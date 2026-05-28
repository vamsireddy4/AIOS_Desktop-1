"""Background task runner — spawns Claude Code per task using the assigned
agent's system prompt. Each task runs as an isolated subprocess; sub-agent
spawning is handled natively by Claude Code's built-in Task tool.

The runner starts N worker threads (default 2). Each worker:
  1. Atomically claims a pending task via tasks_store.claim_next_pending_task()
  2. Builds the Claude command (agent prompt + Composio MCP + bypass perms)
  3. Streams stream-json output, appends tool-use + assistant text to the
     task's narrative_json column, and pushes broadcast events so the
     renderer can refresh the Kanban in real time
  4. Parses sentinels in the final response:
       [BLOCKED: <reason>]            → status=blocked
       [NEEDS_CONNECTOR: <service>]   → status=awaiting_connection
       [SPAWN_AGENT: slug|name|role|prompt] → creates a custom agent
  5. Otherwise: status=completed, full final answer stored in result_json

Concurrency cap, by default 2 simultaneous task runs. Tune via the
"task_concurrency" setting in app_state (1-4 sensible range).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

import agents as agents_mod
from claude_runtime import (
    COMPOSIO_SYSTEM_PROMPT,
    execution_env,
    mcp_isolation_flags,
    text_from_stream_message,
    tool_results_from_stream_message,
    tool_uses_from_stream_message,
)
import tasks_store
import workspace


_RUNNER_LOCK = threading.Lock()
_RUNNER_STARTED = False
_SHUTDOWN = threading.Event()

_DEFAULT_CONCURRENCY = 2
_DEFAULT_TASK_TIMEOUT_SECONDS = 15 * 60

# Sentinels emitted by agents to coordinate with the runner. These are line
# anchored so bracketed text inside the payload, like [Subject/Project Name],
# does not prematurely terminate parsing.
_RE_BLOCKED = re.compile(r"^\[BLOCKED:\s*(.+)\]\s*$", re.IGNORECASE | re.MULTILINE)
_RE_NEEDS_CONNECTOR = re.compile(r"^\[NEEDS_CONNECTOR:\s*([^\]\n]+)\]\s*$", re.IGNORECASE | re.MULTILINE)
_RE_SPAWN_AGENT = re.compile(r"^\[SPAWN_AGENT:\s*(.+)\]\s*$", re.IGNORECASE | re.MULTILINE)
_RE_ASSIGN_TASK = re.compile(r"^\[ASSIGN_TASK:\s*(.+)\]\s*$", re.IGNORECASE | re.MULTILINE)
_RE_AWAITING_APPROVAL = re.compile(r"^\[AWAITING_APPROVAL:\s*([^\]\n]+)\]\s*$", re.IGNORECASE | re.MULTILINE)


_BroadcastFn = Callable[[str, dict[str, Any]], None]


def start_runner(broadcast: _BroadcastFn, concurrency: int | None = None) -> None:
    """Idempotent — calling repeatedly is a no-op after the first call.
    Pass the broadcast helper from host.py so the runner can push events."""
    global _RUNNER_STARTED
    with _RUNNER_LOCK:
        if _RUNNER_STARTED:
            return
        _RUNNER_STARTED = True

    # Recover orphans from a previous sidecar session — anything left at
    # in_progress when we boot is dead (its Claude subprocess died with the
    # old sidecar). Flip back to pending so we re-run it.
    try:
        recovered = tasks_store.reset_orphan_tasks()
        if recovered:
            print(f"[tasks_runner] recovered {recovered} orphan task(s)", file=sys.stderr, flush=True)
    except Exception as err:
        print(f"[tasks_runner] orphan recovery failed: {err}", file=sys.stderr, flush=True)

    workers = _resolve_concurrency(concurrency)
    for i in range(workers):
        t = threading.Thread(
            target=_worker_loop,
            name=f"aios-tasks-runner-{i}",
            args=(i, broadcast),
            daemon=True,
        )
        t.start()


def shutdown_runner() -> None:
    _SHUTDOWN.set()


def _resolve_concurrency(passed: int | None) -> int:
    if passed and passed > 0:
        return max(1, min(passed, 4))
    raw = workspace.get_setting("task_concurrency")
    if raw and raw.isdigit():
        return max(1, min(int(raw), 4))
    return _DEFAULT_CONCURRENCY


def _resolve_task_timeout_seconds() -> int:
    raw = workspace.get_setting("task_timeout_seconds")
    if raw and raw.isdigit():
        return max(60, min(int(raw), 6 * 60 * 60))
    return _DEFAULT_TASK_TIMEOUT_SECONDS


def _worker_loop(slot_id: int, broadcast: _BroadcastFn) -> None:
    """Long-running loop. Sleeps when the queue is empty."""
    while not _SHUTDOWN.is_set():
        try:
            task = tasks_store.claim_next_pending_task()
        except Exception as err:
            print(f"[tasks_runner.{slot_id}] claim error: {err}", file=sys.stderr, flush=True)
            time.sleep(5.0)
            continue

        if task is None:
            time.sleep(2.0)
            continue

        broadcast("task_update", {"taskId": task["id"], "status": "in_progress"})
        try:
            _run_one_task(task, broadcast)
        except Exception as err:
            print(f"[tasks_runner.{slot_id}] task {task.get('id')} error: {err}", file=sys.stderr, flush=True)
            try:
                tasks_store.update_task_status(task["id"], "failed", result=f"Runner error: {err}")
                broadcast("task_update", {"taskId": task["id"], "status": "failed"})
            except Exception:
                pass


def _run_one_task(task: dict[str, Any], broadcast: _BroadcastFn) -> None:
    task_id = task["id"]
    agent_id = task["agent_id"]

    # Resolve the agent. Custom agents may have been deleted between create
    # and run; if so, drop the task with a clear failure message.
    try:
        agent = agents_mod.get_agent(agent_id)
    except Exception:
        tasks_store.update_task_status(
            task_id,
            "failed",
            result=f"Assigned agent '{agent_id}' no longer exists. Reassign or recreate.",
        )
        broadcast("task_update", {"taskId": task_id, "status": "failed"})
        return

    claude_path = workspace.get_setting("claude_path")
    if not claude_path:
        tasks_store.update_task_status(
            task_id,
            "failed",
            result="Claude Code path isn't configured. Open Settings → Connect Claude Code.",
        )
        broadcast("task_update", {"taskId": task_id, "status": "failed"})
        return

    user_context = _read_user_context()
    department_catalog = _department_catalog() if agent_id == "ceo" else ""

    agent_prompt = (agent.get("custom_prompt") or agent["default_prompt"]) or ""
    agent_prompt = agent_prompt.replace("{USER_CONTEXT}", user_context)
    if department_catalog:
        agent_prompt = agent_prompt.replace("{DEPARTMENT_CATALOG}", department_catalog)

    # Synthesis pass: parent task whose delegated children have all finished.
    # Replace the task message with a synthesis brief that bundles every
    # child's status + final answer. The agent's job in this pass is to
    # produce one coherent reply tying the children's work together — not
    # to delegate further.
    is_synthesis_pass = bool(task.get("synthesis_pass"))
    # Strip the [TEAM_MODE] UI marker (it routes to CEO + forces decomposition
    # via the CEO system prompt; Claude doesn't need to see it as raw text).
    task_message = task["message"]
    if task_message.lstrip().startswith("[TEAM_MODE]"):
        task_message = task_message.lstrip()[len("[TEAM_MODE]"):].lstrip()
    if is_synthesis_pass:
        task_message = _build_synthesis_message(task)
    elif _was_last_action_approval(task):
        # User approved the agent's preview. Re-feed the previous draft so
        # the fresh subprocess (no Claude session continuity) knows what to
        # actually execute. Operator may have added a note to the approve
        # action — surface it too in case they want a small tweak.
        prior_draft = (task.get("result") or "").strip()
        approver_note = _last_operator_note(task)
        approval_block = (
            "USER APPROVED YOUR PROPOSED ACTION.\n\n"
            "Here is what you previously drafted and showed them:\n\n"
            f"{prior_draft if prior_draft else '(no draft captured — re-read the task message)'}\n\n"
            "Now actually EXECUTE that action via the appropriate tool calls. "
            "Do NOT emit [AWAITING_APPROVAL:] this time — the user has already "
            "approved. Perform the action, then report in plain language what "
            "happened (e.g. message id, status, who received it)."
        )
        if approver_note:
            approval_block += (
                "\n\nThe user attached this note alongside their approval — "
                "apply it as a small tweak before executing:\n"
                f"{approver_note}"
            )
        task_message = f"{task_message}\n\n{approval_block}"
    else:
        operator_guidance = _operator_retry_guidance(task)
        if operator_guidance:
            task_message = (
                f"{task_message}\n\n"
                "LATEST OPERATOR GUIDANCE FROM RETRY\n"
                f"{operator_guidance}\n\n"
                "Use the operator guidance to continue the task. Do not ask for "
                "the same missing detail again if the operator explicitly told "
                "you to choose a sensible placeholder or mock value."
            )

    mcp_flags = mcp_isolation_flags()
    composio_hint = ["--append-system-prompt", COMPOSIO_SYSTEM_PROMPT] if mcp_flags else []

    command = [
        claude_path,
        "--print",
        *mcp_flags,
        *composio_hint,
        "--append-system-prompt",
        agent_prompt,
        "--verbose",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-mode",
        "bypassPermissions",
        task_message,
    ]
    cwd = str(workspace.workspace_root())

    tasks_store.append_narrative_event(
        task_id,
        {
            "kind": "system",
            "role": "system",
            "agentId": agent["id"],
            "text": f"{agent['name']} started this task.",
        },
    )
    broadcast("task_narrative", {"taskId": task_id})

    # Isolate Claude from the parent sidecar's stdio pipes. On Windows,
    # spawning a child process from a background thread without isolation
    # can corrupt the parent's stdin handle (the IPC pipe from Electron),
    # causing `for line in sys.stdin` to hit EOF → main() returns → sidecar
    # exits cleanly with code 0. Electron then respawns the sidecar on
    # the next IPC call, producing an infinite restart loop.
    popen_kwargs: dict[str, Any] = dict(
        cwd=cwd,
        env=execution_env(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        close_fds=True,
    )
    if os.name == "nt":
        # CREATE_NEW_PROCESS_GROUP detaches Claude into its own process
        # group so Ctrl-C / signal handling can't propagate back to the
        # parent. CREATE_NO_WINDOW hides the console window that would
        # otherwise pop up alongside the GUI app.
        popen_kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        )
    else:
        popen_kwargs["start_new_session"] = True

    try:
        proc = subprocess.Popen(command, **popen_kwargs)
    except FileNotFoundError:
        tasks_store.update_task_status(
            task_id,
            "failed",
            result=f"Claude executable was not found at {claude_path}. Reconnect in Settings.",
        )
        broadcast("task_update", {"taskId": task_id, "status": "failed"})
        return

    timeout_seconds = _resolve_task_timeout_seconds()
    timed_out = threading.Event()

    def _kill_on_timeout() -> None:
        if proc.poll() is not None:
            return
        timed_out.set()
        try:
            proc.kill()
        except Exception:
            pass

    timeout_timer = threading.Timer(timeout_seconds, _kill_on_timeout)
    timeout_timer.daemon = True
    timeout_timer.start()

    stderr_chunks: list[str] = []

    def _drain_stderr() -> None:
        if proc.stderr is None:
            return
        try:
            for chunk in proc.stderr:
                if not chunk:
                    continue
                stderr_chunks.append(chunk)
                if sum(len(part) for part in stderr_chunks) > 20000:
                    del stderr_chunks[:-20]
        except Exception:
            return

    stderr_thread = threading.Thread(
        target=_drain_stderr,
        name=f"aios-task-stderr-{task_id[:8]}",
        daemon=True,
    )
    stderr_thread.start()

    final_text = ""
    session_id: str | None = None
    last_full_text = ""
    # Dedupe tool_use events by id — Claude's --include-partial-messages
    # emits the same assistant message multiple times as it grows, so the
    # same tool_use shows up repeatedly. Same for tool_results.
    seen_tool_uses: set[str] = set()
    seen_tool_results: set[str] = set()
    tool_use_index: dict[str, str] = {}  # id → display name (for result correlation)

    # Also capture any plain-text "thinking" the agent does mid-stream so the
    # narrative doesn't look frozen during a long subprocess run.
    last_thinking_emit = ""

    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            ptype = payload.get("type")

            if ptype == "system" and payload.get("subtype") == "init":
                session_id = payload.get("session_id")

            elif ptype == "assistant":
                full_text = text_from_stream_message(payload)
                if full_text and full_text != last_full_text:
                    last_full_text = full_text
                    final_text = full_text
                    # Emit a "thinking" entry once per substantial growth so
                    # the user sees activity. We only emit the NEW portion to
                    # avoid duplicating already-shown text.
                    new_portion = full_text[len(last_thinking_emit):].strip()
                    if len(new_portion) >= 80:
                        excerpt = new_portion[:400]
                        tasks_store.append_narrative_event(
                            task_id,
                            {
                                "kind": "thinking",
                                "role": "assistant",
                                "agentId": agent["id"],
                                "text": excerpt,
                            },
                        )
                        last_thinking_emit = full_text
                        broadcast("task_narrative", {"taskId": task_id})

                for tool_use in tool_uses_from_stream_message(payload):
                    tu_id = tool_use.get("id") or ""
                    if not tu_id or tu_id in seen_tool_uses:
                        continue
                    seen_tool_uses.add(tu_id)
                    tool_name = (tool_use.get("name") or "tool").strip()
                    summary = (tool_use.get("summary") or "").strip()
                    tool_use_index[tu_id] = tool_name

                    if tool_name == "Task":
                        # Built-in sub-agent spawn. The "description" arg is
                        # the brief the parent gave the child.
                        text = f"Delegated to a sub-agent: {summary or '(no brief)'}"
                        kind = "delegate"
                    elif tool_name.startswith("mcp__composio__"):
                        # Composio MCP call — hide the prefix from the UI.
                        short = tool_name.replace("mcp__composio__", "")
                        text = f"Called {short}" + (f" — {summary}" if summary else "")
                        kind = "tool"
                    else:
                        text = f"Used {tool_name}" + (f" — {summary}" if summary else "")
                        kind = "tool"

                    tasks_store.append_narrative_event(
                        task_id,
                        {
                            "kind": kind,
                            "role": "assistant",
                            "agentId": agent["id"],
                            "text": text,
                        },
                    )
                    broadcast("task_narrative", {"taskId": task_id})

            elif ptype == "user":
                # tool_result messages — surface failures, mute successes
                # (a flood of "X succeeded" entries would drown the UI).
                for tr in tool_results_from_stream_message(payload):
                    tr_id = tr.get("toolUseId") or ""
                    if not tr_id or tr_id in seen_tool_results:
                        continue
                    seen_tool_results.add(tr_id)
                    if tr.get("isError"):
                        tool_name = tool_use_index.get(tr_id, "tool")
                        short_name = tool_name.replace("mcp__composio__", "")
                        tasks_store.append_narrative_event(
                            task_id,
                            {
                                "kind": "tool_error",
                                "role": "system",
                                "agentId": agent["id"],
                                "text": f"{short_name} failed — agent will likely retry or work around it.",
                            },
                        )
                        broadcast("task_narrative", {"taskId": task_id})

            elif ptype == "result":
                result_text = str(payload.get("result") or "").strip()
                if result_text:
                    final_text = result_text
    except Exception as err:
        timeout_timer.cancel()
        try:
            proc.kill()
        except Exception:
            pass
        tasks_store.update_task_status(
            task_id,
            "failed",
            result=f"Stream parse error: {err}",
            claude_session_id=session_id,
        )
        broadcast("task_update", {"taskId": task_id, "status": "failed"})
        return

    return_code = proc.wait()
    timeout_timer.cancel()
    stderr_thread.join(timeout=1.0)
    stderr = "".join(stderr_chunks).strip()

    final_text_clean = (final_text or "").strip()

    if timed_out.is_set():
        timeout_minutes = max(1, round(timeout_seconds / 60))
        result_text = (
            f"Task timed out after {timeout_minutes} minute(s) without finishing. "
            "Open the task and retry with a smaller request or add guidance."
        )
        if stderr:
            result_text = f"{result_text}\n\nClaude stderr:\n{stderr[:4000]}"
        tasks_store.append_narrative_event(
            task_id,
            {
                "kind": "tool_error",
                "role": "system",
                "agentId": agent["id"],
                "text": result_text,
            },
        )
        tasks_store.update_task_status(
            task_id,
            "failed",
            result=result_text,
            claude_session_id=session_id,
        )
        broadcast("task_update", {"taskId": task_id, "status": "failed"})
        _maybe_trigger_parent(task_id, broadcast)
        return

    # Record the agent's final response as a worker narrative entry so users
    # see something in the timeline even if the final answer is short.
    if final_text_clean:
        tasks_store.append_narrative_event(
            task_id,
            {
                "kind": "worker",
                "role": "assistant",
                "agentId": agent["id"],
                "text": final_text_clean[:8000],
            },
        )

    # Handle [SPAWN_AGENT: ...] sentinels first so any custom agents are
    # created regardless of the task outcome (and immediately available for
    # any ASSIGN_TASK sentinel below that references them).
    for match in _RE_SPAWN_AGENT.finditer(final_text_clean):
        try:
            parts = [p.strip() for p in match.group(1).split("|", 3)]
            if len(parts) == 4:
                _, name, role, prompt = parts
                if name and prompt:
                    new_agent = agents_mod.create_custom_agent(
                        name=name,
                        role=role,
                        prompt=prompt,
                        parent_id=agent["id"],
                    )
                    tasks_store.append_narrative_event(
                        task_id,
                        {
                            "kind": "system",
                            "role": "system",
                            "agentId": agent["id"],
                            "text": f"Created new agent '{new_agent['name']}' to support future related work.",
                        },
                    )
                    broadcast("agents_changed", {})
        except Exception as err:
            print(f"[tasks_runner] SPAWN_AGENT failed: {err}", file=sys.stderr, flush=True)

    # Handle [ASSIGN_TASK: <slug> | <message>] sentinels. Each match creates
    # a real child task linked to this one via parent_task_id. If at least
    # one child is created the parent is marked awaiting_children — the
    # child-completion trigger re-queues it for a synthesis pass.
    #
    # Multi-round support: synthesis passes CAN now also emit [ASSIGN_TASK:]
    # IF the round count is still under MAX_SYNTHESIS_ROUNDS. This lets CEO
    # iterate ("specialist A's answer was thin, ask them again with more
    # context"). On the final round, sentinels are silently dropped — the
    # _build_synthesis_message prompt tells the agent this.
    #
    # Depth + total-descendants guards: a specialist can also emit
    # [ASSIGN_TASK:], creating grandchildren. We cap depth at
    # MAX_DELEGATION_DEPTH and total descendants per top-level parent at
    # MAX_DESCENDANTS_PER_PARENT to prevent runaway.
    children_created = 0
    # Compute the top-level ancestor of this task (the parent at depth 0).
    # Used to check global caps that apply across all descendants.
    top_ancestor_id = task_id
    cur_ancestor = task
    for _ in range(10):
        parent_id = cur_ancestor.get("parent_task_id")
        if not parent_id:
            break
        parent_t = tasks_store.get_task(parent_id)
        if not parent_t:
            break
        top_ancestor_id = parent_id
        cur_ancestor = parent_t
    current_depth = tasks_store.get_task_depth(task_id)
    all_descendants = tasks_store.list_descendant_tasks(top_ancestor_id)
    total_descendants = len(all_descendants)
    # Multi-round synthesis cap: allow delegation if round < MAX, silently
    # drop sentinels otherwise. Solo (non-synthesis) calls always allowed.
    synthesis_round_n = int(task.get("synthesis_round") or 0)
    can_delegate = True
    if is_synthesis_pass and synthesis_round_n >= MAX_SYNTHESIS_ROUNDS:
        can_delegate = False
    if current_depth >= MAX_DELEGATION_DEPTH:
        can_delegate = False
    if total_descendants >= MAX_DESCENDANTS_PER_PARENT:
        can_delegate = False
    if can_delegate:
        for match in _RE_ASSIGN_TASK.finditer(final_text_clean):
            try:
                parts = [p.strip() for p in match.group(1).split("|", 1)]
                if len(parts) != 2:
                    continue
                target_slug, sub_message = parts
                if not target_slug or not sub_message:
                    continue
                try:
                    target_agent = agents_mod.get_agent(target_slug)
                except Exception:
                    tasks_store.append_narrative_event(
                        task_id,
                        {
                            "kind": "tool_error",
                            "role": "system",
                            "agentId": agent["id"],
                            "text": f"Tried to delegate to '{target_slug}' but no such agent exists.",
                        },
                    )
                    continue
                child = tasks_store.create_task(
                    name=f"↳ {sub_message[:60]}",
                    message=sub_message,
                    agent_id=target_agent["id"],
                    priority=task.get("priority") or 3,
                    parent_task_id=task_id,
                )
                tasks_store.append_narrative_event(
                    task_id,
                    {
                        "kind": "assignment",
                        "role": "assistant",
                        "agentId": agent["id"],
                        "text": f"Delegated to {target_agent['name']}: {sub_message[:180]}",
                    },
                )
                children_created += 1
                broadcast("task_update", {"taskId": child["id"], "status": "pending"})
            except Exception as err:
                print(f"[tasks_runner] ASSIGN_TASK failed: {err}", file=sys.stderr, flush=True)

    if children_created > 0:
        # Parent is now waiting on its children. Don't mark completed — the
        # synthesis pass will re-spawn the parent once all children finish.
        tasks_store.update_task_status(
            task_id,
            "awaiting_children",
            result=final_text_clean,
            claude_session_id=session_id,
        )
        broadcast("task_update", {"taskId": task_id, "status": "awaiting_children"})
        return

    approval_match = _RE_AWAITING_APPROVAL.search(final_text_clean)
    needs_match = _RE_NEEDS_CONNECTOR.search(final_text_clean)
    blocked_match = _RE_BLOCKED.search(final_text_clean)

    if approval_match:
        # Strip the sentinel from the body the UI shows so the user only sees
        # the draft itself, not the bracketed marker.
        preview_text = _RE_AWAITING_APPROVAL.sub("", final_text_clean).strip()
        tasks_store.update_task_status(
            task_id,
            "awaiting_approval",
            blocked_reason=approval_match.group(1).strip(),
            result=preview_text or final_text_clean,
            claude_session_id=session_id,
        )
        broadcast("task_update", {"taskId": task_id, "status": "awaiting_approval"})
        _maybe_trigger_parent(task_id, broadcast)
        return

    if needs_match:
        tasks_store.update_task_status(
            task_id,
            "awaiting_connection",
            needs_connector=needs_match.group(1).strip(),
            result=final_text_clean,
            claude_session_id=session_id,
        )
        broadcast("task_update", {"taskId": task_id, "status": "awaiting_connection"})
        _maybe_trigger_parent(task_id, broadcast)
        return

    if blocked_match:
        tasks_store.update_task_status(
            task_id,
            "blocked",
            blocked_reason=blocked_match.group(1).strip(),
            result=final_text_clean,
            claude_session_id=session_id,
        )
        broadcast("task_update", {"taskId": task_id, "status": "blocked"})
        _maybe_trigger_parent(task_id, broadcast)
        return

    if return_code == 0:
        tasks_store.update_task_status(
            task_id,
            "completed",
            result=final_text_clean,
            claude_session_id=session_id,
        )
        broadcast("task_update", {"taskId": task_id, "status": "completed"})
        _maybe_trigger_parent(task_id, broadcast)
        return

    tasks_store.update_task_status(
        task_id,
        "failed",
        result=stderr or final_text_clean or f"Claude exited with status {return_code}.",
        claude_session_id=session_id,
    )
    broadcast("task_update", {"taskId": task_id, "status": "failed"})
    _maybe_trigger_parent(task_id, broadcast)


def _maybe_trigger_parent(child_task_id: str, broadcast: _BroadcastFn) -> None:
    """Called after a terminal status update. If the task has a parent in
    awaiting_children and all siblings are terminal, re-queue the parent for
    its synthesis pass."""
    try:
        triggered = tasks_store.maybe_trigger_parent_synthesis(child_task_id)
        if triggered:
            child = tasks_store.get_task(child_task_id)
            if child and child.get("parent_task_id"):
                broadcast("task_update", {"taskId": child["parent_task_id"], "status": "pending"})
    except Exception as err:
        print(f"[tasks_runner] parent-synthesis trigger failed: {err}", file=sys.stderr, flush=True)


MAX_SYNTHESIS_ROUNDS = 3
MAX_DELEGATION_DEPTH = 3
MAX_DESCENDANTS_PER_PARENT = 20
MAX_TOTAL_COST_USD = 5.0


def _build_synthesis_message(parent_task: dict[str, Any]) -> str:
    """Construct the synthesis-pass message. The parent agent receives the
    original brief plus each child's name + status + final answer. On
    rounds < MAX, the agent MAY emit more [ASSIGN_TASK:] sentinels to
    iterate; on the final round, it MUST write a terminal answer.
    """
    children = tasks_store.list_child_tasks(parent_task["id"])
    round_n = int(parent_task.get("synthesis_round") or 0)
    is_final_round = round_n >= MAX_SYNTHESIS_ROUNDS
    parts: list[str] = []
    if is_final_round:
        parts.append(
            f"SYNTHESIS PASS — ROUND {round_n} of {MAX_SYNTHESIS_ROUNDS} (FINAL)\n\n"
            "You previously delegated this work to specialists. They've returned "
            "their results below. **The round cap is now reached — you MUST write "
            "a final terminal answer in this turn.** Do NOT emit any "
            "[ASSIGN_TASK:], [SPAWN_AGENT:], or other sentinels — they will be "
            "ignored. Pull together the best of what the specialists produced. "
            "If something is incomplete, say so clearly and give the bottom line."
        )
    else:
        parts.append(
            f"SYNTHESIS PASS — ROUND {round_n} of {MAX_SYNTHESIS_ROUNDS}\n\n"
            "You previously delegated this work to one or more specialists. "
            "They are now all finished. Below is the original request followed "
            "by each child's outcome.\n\n"
            "JUDGE THE WORK:\n"
            "- If the children's work is complete and coherent → write the final "
            "answer NOW. Do NOT emit sentinels.\n"
            f"- If there are real gaps, contradictions, or a specialist failed and the "
            f"work needs another pass → you MAY emit more [ASSIGN_TASK:] lines to "
            f"trigger round {round_n + 1}. Only delegate again if a user would "
            f"genuinely notice the gap in the final answer — don't iterate for the "
            f"sake of looking thorough."
        )
    parts.append(f"\nORIGINAL REQUEST\n{parent_task['message'].strip()}")
    parts.append("\nDELEGATIONS (this round)")
    for ch in children:
        agent_label = ch.get("agent_id", "?")
        status_label = ch.get("status", "?")
        result_text = (ch.get("result") or "").strip() or "(no result captured)"
        parts.append(f"\n- [{status_label}] {agent_label}:\n{result_text}")
    return "\n".join(parts)


def _strip_team_mode_marker(message: str) -> str:
    """Strip the [TEAM_MODE] prefix (a UI signal that CEO must decompose).
    The marker is purely for routing; Claude doesn't need to see it as
    structured input — the CEO prompt already knows about it via its
    system prompt. Keeping it visible to Claude is harmless but noisy."""
    return message.lstrip()


def _was_last_action_approval(task: dict[str, Any]) -> bool:
    """True if the most recent operator narrative event was an approve.

    Used by the runner to switch from the default retry flow (re-feed the
    operator's note as guidance) to the approval flow (re-feed the previous
    draft + an EXECUTE NOW instruction). Without this, an approved task
    would just re-draft instead of executing."""
    narrative = task.get("narrative")
    if not isinstance(narrative, list):
        return False
    for event in reversed(narrative):
        if not isinstance(event, dict):
            continue
        if event.get("kind") != "operator":
            continue
        text = str(event.get("text") or "").strip()
        # Approve writes "(approved)" or "(approved) <note>"; reject writes
        # "(rejected)"; retry writes "(retry)" or just the note.
        return text.startswith("(approved)") or text == "(approved)"
    return False


def _last_operator_note(task: dict[str, Any]) -> str:
    """Return any free-text note attached to the most recent operator action,
    stripped of the leading sentinel marker. Empty string when there is none."""
    narrative = task.get("narrative")
    if not isinstance(narrative, list):
        return ""
    for event in reversed(narrative):
        if not isinstance(event, dict):
            continue
        if event.get("kind") != "operator":
            continue
        text = str(event.get("text") or "").strip()
        for marker in ("(approved)", "(rejected)", "(retry)"):
            if text == marker:
                return ""
            if text.startswith(f"{marker} "):
                return text[len(marker) + 1:].strip()
        return text
    return ""


def _operator_retry_guidance(task: dict[str, Any]) -> str:
    """Return recent user guidance entered from the task action box.

    The UI stores retry notes in narrative_json. Without feeding those notes
    back into the next Claude run, retries see the exact same original prompt
    and can block forever on a question the user already answered.

    Strips the leading action marker (e.g. "(retry) ", "(rejected) ") so the
    guidance reads like a plain instruction, not a tagged log entry.
    """
    narrative = task.get("narrative")
    if not isinstance(narrative, list):
        return ""
    notes: list[str] = []
    for event in narrative:
        if not isinstance(event, dict):
            continue
        if event.get("kind") != "operator":
            continue
        text = str(event.get("text") or "").strip()
        if not text:
            continue
        # Strip leading "(retry) " / "(rejected) " — these are bookkeeping,
        # not guidance. Skip bare markers entirely.
        stripped = text
        for marker in ("(retry)", "(rejected)", "(approved)"):
            if stripped == marker:
                stripped = ""
                break
            if stripped.startswith(f"{marker} "):
                stripped = stripped[len(marker) + 1:].strip()
                break
        if not stripped:
            continue
        notes.append(stripped)
    if not notes:
        return ""
    return "\n".join(f"- {note}" for note in notes[-3:])


def _read_user_context() -> str:
    """Read the user's profile from context/*.md and condense it for prompt
    injection. These files are written by complete_onboarding and edited
    on the Context page."""
    root = workspace.workspace_root()
    pieces: list[str] = []
    for filename in (
        "business-info.md",
        "personal-info.md",
        "strategy.md",
        "current-data.md",
        "business.md",
        "profile.md",
        "priorities.md",
        "vision.md",
    ):
        path = root / "context" / filename
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace").strip()
            if text:
                pieces.append(f"## {filename}\n\n{text}")
        except Exception:
            continue
    if not pieces:
        return "(No user profile yet — onboarding hasn't been completed or context/*.md is empty.)"
    combined = "\n\n".join(pieces)
    # Cap so we don't blow up the system prompt budget.
    if len(combined) > 8000:
        combined = combined[:8000] + "\n\n[user context truncated]"
    return combined


def _department_catalog() -> str:
    """Synthesize a catalog of current sub-agents so the CEO knows whom to
    delegate to via the Task tool. Reflects any user-renamed or user-added
    agents."""
    try:
        result = agents_mod.list_agents()
    except Exception:
        return ""
    rows: list[str] = []
    for agent in result.get("agents", []):
        if agent["id"] == "ceo":
            continue
        rows.append(f"- {agent['name']} ({agent['id']}): {agent['role']}")
    return "\n".join(rows)
