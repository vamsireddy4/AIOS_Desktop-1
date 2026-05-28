from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from workspace import (
    advance_auto_task,
    append_file,
    begin_auto_task_run,
    complete_onboarding,
    complete_onboarding_freeform,
    reset_onboarding,
    reset_workspace,
    copy_module_assets,
    create_auto_task,
    create_thread,
    delete_auto_task,
    delete_thread,
    delete_workspace_file,
    due_auto_tasks,
    finish_auto_task_run,
    get_context_summary,
    get_onboarding_state,
    get_outputs_summary,
    get_plans_summary,
    get_recent_workspace_activity,
    get_sessions,
    get_shares_summary,
    get_setting,
    get_workspace_info,
    list_auto_tasks,
    list_connector_status,
    list_directory,
    list_external_directory,
    browse_external_directory,
    list_recent_auto_runs,
    list_workspace_files,
    list_workspace_section,
    move_file,
    read_file,
    read_markdown_preview,
    rename_thread,
    save_onboarding_answer,
    save_session,
    set_setting,
    toggle_auto_task,
    update_auto_task,
    workspace_root,
    write_file,
    list_modules,
    build_daily_brief_prompt,
    get_today_brief_status,
    get_daily_brief,
    list_daily_briefs,
    mark_brief_seen,
    save_daily_brief,
    mark_import_folder,
    unmark_import_folder,
    list_marked_import_folders,
    is_import_folder_marked,
    link_folder,
    unlink_folder,
    list_linked_folders,
)

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def execution_env() -> dict[str, str]:
    home = str(Path.home())
    current_path = os.environ.get("PATH", "")
    if sys.platform.startswith("win"):
        appdata = os.environ.get("APPDATA", "")
        local_appdata = os.environ.get("LOCALAPPDATA", "")
        userprofile = os.environ.get("USERPROFILE", home)
        # Skip any join where the env var resolved empty — joining "" with
        # a tail yields a relative path that pollutes PATH without helping.
        # Order: most-likely Claude/npm install locations first.
        candidates = [
            os.path.join(userprofile, ".claude", "bin") if userprofile else "",  # standalone Claude installer
            os.path.join(userprofile, ".claude", "local", "bin") if userprofile else "",
            os.path.join(userprofile, ".local", "bin") if userprofile else "",
            os.path.join(appdata, "npm") if appdata else "",                     # default npm global
            os.path.join(local_appdata, "Programs", "nodejs") if local_appdata else "",
            os.path.join(local_appdata, "npm") if local_appdata else "",
            r"C:\Program Files\nodejs",
            r"C:\Program Files (x86)\nodejs",
        ]
        additions = [p for p in candidates if p]
    else:
        additions = [
            os.path.join(home, ".npm-global", "bin"),
            os.path.join(home, ".volta", "bin"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
    path_parts: list[str] = []
    for item in additions + current_path.split(os.pathsep):
        if item and item not in path_parts:
            path_parts.append(item)
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join(path_parts)
    saved_api_key = get_setting("anthropic_api_key")
    if saved_api_key and not env.get("ANTHROPIC_API_KEY"):
        env["ANTHROPIC_API_KEY"] = saved_api_key
    return env


class HostError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


import threading

import agents as agents_mod
import tasks_store

# Seed the 9 built-in agents (CEO + 8 departments) into SQLite on every boot.
# Idempotent — existing custom_prompt edits are preserved.
try:
    agents_mod.ensure_builtin_agents()
except Exception as _seed_err:
    print(f"[host] agents seed failed: {_seed_err}", file=sys.stderr, flush=True)

# Shared lock for all stdout writes. With concurrent request handlers, we
# need to make sure two threads don't interleave their JSON-RPC responses
# into the stdout pipe — that would corrupt the framing the Electron host
# relies on.
_STDOUT_LOCK = threading.Lock()


def emit_event(message_id: str | None, event: str, data: dict[str, Any]) -> None:
    if not message_id:
        return
    with _STDOUT_LOCK:
        print(json.dumps({"id": message_id, "event": event, "data": data}), flush=True)


def broadcast_event(event: str, data: dict[str, Any]) -> None:
    """Push an unsolicited event to the renderer (no associated request id).
    Used by the tasks runner to notify the UI of task status changes."""
    with _STDOUT_LOCK:
        print(json.dumps({"id": "", "event": event, "data": data}), flush=True)


def text_from_stream_message(payload: dict[str, Any]) -> str:
    message = payload.get("message") if isinstance(payload.get("message"), dict) else {}
    content = message.get("content") if isinstance(message.get("content"), list) else []
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text") or ""))
    return "".join(parts)


def tool_uses_from_stream_message(payload: dict[str, Any]) -> list[dict[str, Any]]:
    message = payload.get("message") if isinstance(payload.get("message"), dict) else {}
    content = message.get("content") if isinstance(message.get("content"), list) else []
    result: list[dict[str, Any]] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            inp = block.get("input") if isinstance(block.get("input"), dict) else {}
            summary_parts: list[str] = []
            for key in ("command", "file_path", "path", "pattern", "url", "description"):
                value = inp.get(key)
                if isinstance(value, str) and value.strip():
                    summary_parts.append(value.strip())
                    break
            entry: dict[str, Any] = {
                "id": str(block.get("id") or ""),
                "name": str(block.get("name") or ""),
                "summary": (summary_parts[0] if summary_parts else "")[:240],
            }
            # Plan-mode: surface the full plan markdown so the renderer can
            # render a Plan card with Accept / Reject buttons instead of a
            # normal assistant bubble.
            if entry["name"] == "ExitPlanMode":
                plan = inp.get("plan")
                if isinstance(plan, str) and plan.strip():
                    entry["plan"] = plan
            result.append(entry)
    return result


def tool_results_from_stream_message(payload: dict[str, Any]) -> list[dict[str, Any]]:
    message = payload.get("message") if isinstance(payload.get("message"), dict) else {}
    content = message.get("content") if isinstance(message.get("content"), list) else []
    result: list[dict[str, Any]] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_result":
            is_error = bool(block.get("is_error"))
            if is_error:
                # v0.2.27 probe — capture the exact tool-error format so the
                # next release can pattern-match Composio "service not
                # connected" errors and render an inline connector chip.
                # Logs to <workspace>/logs/tool-errors.log. Safe to leave on
                # in the meantime; only fires on errors.
                _debug_log_tool_error(block)
            result.append(
                {
                    "toolUseId": str(block.get("tool_use_id") or ""),
                    "isError": is_error,
                }
            )
    return result


def _debug_log_tool_error(block: dict[str, Any]) -> None:
    try:
        from workspace import workspace_root
        from datetime import datetime, timezone
        log_path = workspace_root() / "logs" / "tool-errors.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "block": block,
        }
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, default=str) + "\n")
    except Exception:
        # Never break the stream because logging failed.
        pass


# Track active chat-stream subprocesses by streamId so cancel_chat_stream
# can terminate them. Keyed by streamId because that's what the renderer
# already passes through the stream events. Locked because cancel runs on
# the JSON-RPC dispatch thread while run_claude_stream runs on its own.
_ACTIVE_STREAMS: dict[str, "subprocess.Popen[str]"] = {}
_ACTIVE_STREAMS_LOCK = threading.Lock()


def cancel_chat_stream(stream_id: str) -> dict[str, Any]:
    """Terminate the Claude Code subprocess for a given streamId. Returns
    ok=True if there was an active stream to cancel, ok=False with reason
    otherwise. Best-effort: terminate() first, kill() after 0.5s if still
    alive. Always pops the dict entry so a stuck process doesn't leak."""
    with _ACTIVE_STREAMS_LOCK:
        proc = _ACTIVE_STREAMS.pop(stream_id, None)
    if proc is None:
        return {"ok": False, "reason": "no_active_stream"}
    try:
        proc.terminate()
        try:
            proc.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            proc.kill()
        return {"ok": True}
    except Exception as err:
        return {"ok": False, "reason": str(err)}


def run_claude_stream(
    command: list[str],
    cwd: str,
    timeout: int,
    request_id: str | None,
    stream_id: str,
) -> dict[str, Any]:
    started = subprocess.Popen(
        command,
        cwd=cwd,
        env=execution_env(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    with _ACTIVE_STREAMS_LOCK:
        _ACTIVE_STREAMS[stream_id] = started
    final: dict[str, Any] | None = None
    streamed_text = ""
    last_full_text = ""

    try:
        assert started.stdout is not None
        for line in started.stdout:
            payload = json.loads(line)
            payload_type = payload.get("type")
            if payload_type == "system" and payload.get("subtype") == "init":
                emit_event(request_id, "claude_stream", {"streamId": stream_id, "sessionId": payload.get("session_id")})
            elif payload_type == "stream_event":
                event = payload.get("event") if isinstance(payload.get("event"), dict) else {}
                delta = event.get("delta") if isinstance(event.get("delta"), dict) else {}
                if delta.get("type") == "text_delta":
                    text = str(delta.get("text") or "")
                    streamed_text += text
                    last_full_text = streamed_text
                    emit_event(request_id, "claude_stream", {"streamId": stream_id, "delta": text})
            elif payload_type == "assistant":
                full_text = text_from_stream_message(payload)
                if full_text and len(full_text) > len(last_full_text) and full_text.startswith(last_full_text):
                    delta = full_text[len(last_full_text):]
                    streamed_text += delta
                    emit_event(request_id, "claude_stream", {"streamId": stream_id, "delta": delta})
                if full_text:
                    last_full_text = full_text
                for tool_use in tool_uses_from_stream_message(payload):
                    emit_event(request_id, "claude_stream", {"streamId": stream_id, "toolUse": tool_use})
            elif payload_type == "user":
                for tool_result in tool_results_from_stream_message(payload):
                    emit_event(request_id, "claude_stream", {"streamId": stream_id, "toolResult": tool_result})
            elif payload_type == "result":
                final = payload
    except json.JSONDecodeError as error:
        started.kill()
        with _ACTIVE_STREAMS_LOCK:
            _ACTIVE_STREAMS.pop(stream_id, None)
        raise HostError("CLAUDE_STREAM_ERROR", f"Claude returned malformed stream output: {error}")
    except subprocess.TimeoutExpired:
        started.kill()
        with _ACTIVE_STREAMS_LOCK:
            _ACTIVE_STREAMS.pop(stream_id, None)
        raise HostError("CLAUDE_TIMEOUT", "Claude Code did not finish before the timeout. Reconnect Claude or retry with a shorter prompt.")

    # Pop the active-stream entry so cancel_chat_stream can't fire after
    # the subprocess has already exited. We pop regardless of success path
    # below — the dict only tracks running streams.
    with _ACTIVE_STREAMS_LOCK:
        _ACTIVE_STREAMS.pop(stream_id, None)

    stderr = started.stderr.read().strip() if started.stderr else ""
    return_code = started.wait(timeout=timeout)
    if return_code != 0:
        # Real cancellation = SIGTERM (-15 POSIX / 15 Win) or SIGKILL (-9 / 9).
        # Exit code 1 used to live in this set, but it's the generic failure
        # code (auth, missing CLI, malformed args, API errors) — calling it
        # "Cancelled." hides every real diagnostic from the user.
        if return_code in (-15, 15, -9, 9):
            raise HostError("CLAUDE_CANCELLED", "Cancelled.")
        # Prefer the structured result message ("API Error: 401 ... /login")
        # over raw stderr; fall back to stderr; then a generic exit-code msg.
        result_msg = ""
        if isinstance(final, dict):
            result_msg = str(final.get("result") or "").strip()
        message = result_msg or stderr or f"Claude exited with code {return_code}"
        lowered = message.lower()
        if (
            "invalid authentication credentials" in lowered
            or "please run /login" in lowered
            or ("401" in message and "auth" in lowered)
        ):
            raise HostError("CLAUDE_AUTH_REQUIRED", message)
        raise HostError("CLAUDE_FAILED", message)
    if not final:
        return {"response": streamed_text, "stderr": stderr, "workspaceRoot": cwd, "command": command[:6]}
    if final.get("is_error"):
        raise HostError("CLAUDE_RESULT_ERROR", str(final.get("result") or stderr or "Claude returned an error."))

    response = str(final.get("result") or streamed_text or "").strip()
    emit_event(
        request_id,
        "claude_stream",
        {
            "streamId": stream_id,
            "response": response,
            "sessionId": final.get("session_id"),
            "durationMs": final.get("duration_ms"),
            "costUsd": final.get("total_cost_usd"),
            "done": True,
        },
    )
    return {
        "response": response,
        "stderr": stderr,
        "workspaceRoot": cwd,
        "command": command[:6],
        "sessionId": final.get("session_id"),
        "costUsd": final.get("total_cost_usd"),
        "durationMs": final.get("duration_ms"),
        "modelUsage": final.get("modelUsage"),
    }


def _resume_flags(session_id: str | None) -> list[str]:
    if session_id and isinstance(session_id, str):
        return ["--resume", session_id]
    return []


def _sanitize_mcp_entry(cfg: dict[str, Any]) -> dict[str, Any] | None:
    """Strip an MCP server entry down to fields Claude's --mcp-config accepts.

    Composio's @composio/core SDK returns session.mcp with extra keys (name,
    description, auth, etc.) that Claude's strict inline-config parser rejects
    with 'Does not adhere to MCP server configuration schema'. The persisted
    settings.json works only because the file reader is lenient; the inline
    parser is strict. Same sanitizer is applied at write-time in workspace.py
    so the persisted entry stays clean too.
    """
    if not isinstance(cfg, dict):
        return None
    url = cfg.get("url")
    if not isinstance(url, str) or not url:
        return None
    headers = cfg.get("headers") if isinstance(cfg.get("headers"), dict) else {}
    server_type = cfg.get("type") if cfg.get("type") in ("http", "sse") else "http"
    return {"type": server_type, "url": url, "headers": headers}


def _mcp_isolation_flags() -> list[str]:
    """Pull AIOS's composio MCP config out of ~/.claude/settings.json and pass
    it inline via --mcp-config + --strict-mcp-config so Claude *only* sees the
    Composio server. Suppresses claude.ai's account-linked connectors entirely."""
    try:
        from workspace import claude_settings_path  # type: ignore
        settings_path = claude_settings_path()
        if not settings_path.exists():
            return []
        with settings_path.open("r", encoding="utf-8") as fh:
            settings = json.load(fh)
        composio_cfg = (settings.get("mcpServers") or {}).get("composio")
        sanitized = _sanitize_mcp_entry(composio_cfg) if composio_cfg else None
        if not sanitized:
            return []
        config_json = json.dumps({"mcpServers": {"composio": sanitized}})
        return ["--strict-mcp-config", "--mcp-config", config_json]
    except Exception:
        return []


_COMPOSIO_SYSTEM_PROMPT_BASE = (
    "Tools: COMPOSIO_SEARCH_TOOLS finds a slug, COMPOSIO_MULTI_EXECUTE_TOOL "
    "runs it. Use these — don't assume what's connected.\n"
    "• Local Tasks: To add a mission to the AIOS 'Tasks' page, run from your "
    "shell: `python python/create_mission.py --name \"Mission Title\" --message "
    "\"Mission Details\" --agent \"ceo\"`. (On Windows the launcher is `python` "
    "or `py`; on macOS/Linux it is `python3` — Claude should pick the one "
    "available; do not hardcode python3.)\n"
    "• Implementation Plans: When asked to 'create a plan', draft a detailed Markdown implementation plan "
    "(following the AIOS format: Title, Overview, Current State, Proposed Changes, Design Decisions, Step-by-Step Tasks) "
    "and save it by running: `python python/save_plan.py --title \"Plan Name\" --content \"FULL_MARKDOWN_CONTENT\"`. "
    "Crucially, you MUST also send the full plan content back in your chat reply so the user can see it on WhatsApp.\n"
    "• ONE OUTPUT PER IMPLEMENTATION (hard rule): When asked to 'implement' a plan, "
    "produce EXACTLY ONE consolidated output file under outputs/<slug>/<plan-slug>.md "
    "(or outputs/<plan-slug>.md if there's no obvious category). Do NOT create one "
    "file per plan step, one per section, or one per deliverable. If the plan has "
    "multiple deliverables, fold them all into the single output file with H2 "
    "headings. If you find yourself about to write a second outputs/* file for the "
    "same plan, STOP — append to the existing file or rewrite it instead. Users "
    "have hit 20+ files for one /implement run; that is a regression.\n"
    "• Save as PDF: When the user asks to save, export, or download an answer as a "
    "PDF, write your full Markdown answer normally, then end your reply with one "
    "line on its own: `[AIOS_EXPORT_PDF: outputs/<short-slug>.pdf]` "
    "AIOS will render your answer to a PDF in the workspace's outputs/ folder and "
    "show a downloadable chip under your message. Pick a 2-4 word slug.\n"
    "• Ask with options (v0.2.38+): When you need the user to pick between a small "
    "set of choices (2–5), end your reply with a single line: "
    "`[AIOS_ASK: brief question | Option A | Option B | Option C]`. "
    "AIOS renders this as a row of clickable buttons under your message; "
    "clicking sends the option text as the user's next message. Use ONLY for "
    "genuinely closed-set choices (model picks, yes/no, A vs B). For open "
    "questions, just ask in plain prose — don't force-fit options. The marker "
    "is stripped from the displayed text.\n"
    "• Subagents (v0.2.39+): the workspace ships three Claude Code subagents "
    "in `.claude/agents/`: **code-reviewer** (finds real bugs in diffs), "
    "**brief-writer** (tight daily briefs), **researcher** (multi-source "
    "structured research with citations). Delegate to one with the Task tool "
    "when the request matches — fresh context window, focused system prompt, "
    "constrained tools. They beat trying to do everything in this turn.\n"
    "• Connect a service inline (v0.2.47+): when the user asks for something "
    "that needs a service that isn't connected, instead of just saying 'open "
    "the Connectors page', end your reply with: `[AIOS_CONNECT: <slug>]` "
    "(e.g. `[AIOS_CONNECT: slack]`, `[AIOS_CONNECT: gmail]`). AIOS renders "
    "an inline Connect button under your message — one click jumps the user "
    "to the Connectors page so they don't have to hunt for it. Use the "
    "Composio service slug, lowercase. Use this for AT MOST one service per "
    "turn — pick the most important.\n"

    "User is non-technical. Be brief, plain, direct.\n"

    "• Hide internals: paths, SQLite, IDs, account labels, install dates.\n"
    "• Hide infrastructure: Composio, MCP, tool router, slugs.\n"
    "• Don't preface ('Let me fetch…') or describe tools used.\n"
    "• If a service isn't connected: 'That isn't connected yet — open Connectors.'\n"
    "• If a connector is set up but a feature is unavailable (collector says "
    "'skipped' / 'limited'), say plainly: 'X is connected, [feature] isn't "
    "supported yet through AIOS — it'll auto-enable when support ships.' "
    "Don't blame the user, don't say it's broken.\n"
    "• If a workspace script has a small bug (wrong slug, response shape, "
    "minor typo), silently fix it in place and report only the high-level "
    "outcome ('connected', 'data fetched'). Don't show errors or the patch.\n"
    "• Don't invent OAuth URLs or `lk_…` codes.\n"
    "• Don't reference the user's Claude login email or compare with connected accounts."
)


def _build_composio_system_prompt() -> str:
    """Append a connector-scope-lock to the base prompt that lists the
    services AIOS knows about and which are currently connected. Without
    this, the spawned Claude wanders into recommending Perplexity / Brave /
    Make.com / etc. — services we don't actually support."""
    try:
        from workspace import (
            CONNECTOR_DISPLAY_NAMES,
            KNOWN_CONNECTORS,
            list_connector_status,
        )
    except Exception:
        return _COMPOSIO_SYSTEM_PROMPT_BASE
    available = ", ".join(
        CONNECTOR_DISPLAY_NAMES.get(slug, slug) for slug in KNOWN_CONNECTORS
    )
    # Build "Gmail (satya@x.com), GitHub (@user)" — including account labels
    # is the key thing that stops Claude from asking "do you have Gmail?" or
    # "which account?" mid-conversation. The label is whatever the identify
    # task wrote at connect time.
    statuses = list_connector_status().get("connectors", {})
    connected_entries: list[str] = []
    for slug in KNOWN_CONNECTORS:
        info = statuses.get(slug, {})
        if not info.get("connected"):
            continue
        display = CONNECTOR_DISPLAY_NAMES.get(slug, slug)
        label = info.get("label")
        connected_entries.append(f"{display} ({label})" if label else display)
    if connected_entries:
        connected_str = ", ".join(connected_entries)
        scope_block = (
            "\n• Allowed services (the ONLY ones AIOS supports — never name any "
            "other external service, even if it exists in the world): "
            f"{available}.\n"
            f"• Currently connected for this user: {connected_str}.\n"
            "• Never ask the user whether they have one of these services "
            "connected — the list above is authoritative. Never ask which "
            "account; the email/handle in parentheses IS the account.\n"
            "• MEMORY OVERRIDE: this list is REFRESHED every turn. If an earlier "
            "message in this conversation asked the user about a connector that "
            "now appears above, they have connected it since — DO NOT ask again. "
            "Proceed with the action using that connector immediately.\n"
            "• If the user asks for a capability and the right connector is in the "
            "allowed list but NOT connected, say: 'That's available — open the "
            "Connectors page and connect <Service> first.' Then stop. Never "
            "suggest Perplexity, Brave, Make.com, Zapier, n8n, IFTTT, or any "
            "other service outside the allowed list above."
        )
    else:
        scope_block = (
            "\n• Allowed services (the ONLY ones AIOS supports — never name any "
            f"other external service, even if it exists in the world): {available}.\n"
            "• Nothing is connected yet. If the user asks you to act on a service, "
            "tell them to open the Connectors page and connect it first. Never "
            "suggest Perplexity, Brave, Make.com, Zapier, n8n, IFTTT, or any "
            "other service outside the allowed list above."
        )
    return _COMPOSIO_SYSTEM_PROMPT_BASE + scope_block


# Backwards-compatible name kept so existing call sites don't have to change.
# Re-evaluated lazily so toggling a connector at runtime updates the prompt
# on the next spawn.
def _get_composio_system_prompt() -> str:
    return _build_composio_system_prompt()


_ALLOWED_PERMISSION_MODES = {"bypassPermissions", "plan", "acceptEdits"}


# Coaching appended ONLY when permission_mode == "plan". The user is in plan
# mode, so Claude can read but can't write. Goal: get Claude to ASK clarifying
# questions before producing a plan based on guesses. AIOS renders `[AIOS_ASK:
# question | A | B | C]` as clickable buttons under the message, so closed-set
# questions get a slick UI. Open-ended questions stay as plain prose.
_PLAN_MODE_HINT = (
    "You are in Plan mode. You can read code/files freely, but you cannot edit, "
    "run commands, or call write tools. Your job is to produce a clear plan the "
    "user will approve before any work happens.\n"
    "\n"
    "BEFORE calling ExitPlanMode with a final plan, check whether anything is "
    "ambiguous about what the user wants:\n"
    "- Multiple reasonable interpretations of the goal\n"
    "- Architectural choices the user should weigh in on (library X vs Y, "
    "approach A vs B)\n"
    "- Scope questions (just this file, or the whole module?)\n"
    "- Missing inputs you can't reasonably guess\n"
    "\n"
    "If anything's ambiguous, ASK FIRST. Two ways:\n"
    "1. Closed-set choice (2-5 options) → end your reply with: "
    "`[AIOS_ASK: brief question | Option A | Option B | Option C]`. AIOS "
    "renders clickable buttons; clicking sends the option text as the user's "
    "next message. Do NOT call ExitPlanMode in the same turn — just ask.\n"
    "2. Open-ended question → just ask in plain prose at the end of your reply. "
    "Don't call ExitPlanMode this turn; wait for the user's answer.\n"
    "\n"
    "Only call ExitPlanMode when the plan is unambiguous and you've answered "
    "your own remaining questions from reading the code. Keep plans concrete: "
    "numbered steps, file paths, and what changes where.\n"
    "\n"
    "If you also write the plan to a file (preferred for anything non-trivial), "
    "save it INSIDE the user's AIOS workspace at `plans/<short-slug>.md` "
    "(relative path). Do NOT save plans to `~/.claude/plans/` or any other "
    "outside-workspace path — AIOS's Plans page only sees files inside the "
    "workspace, so an outside path is invisible to the user. When you save a "
    "plan to disk, ALSO end your reply with one line on its own: "
    "`[AIOS_ARTIFACT: plans/<short-slug>.md]`. AIOS renders a clickable chip "
    "under your message — one click opens the file in the user's default app."
)


def run_claude(
    prompt: str,
    claude_path: str | None = None,
    timeout: int = 45,
    request_id: str | None = None,
    stream_id: str | None = None,
    session_id: str | None = None,
    model: str | None = None,
    system_prompt: str | None = None,
    add_dirs: list[str] | None = None,
    permission_mode: str = "bypassPermissions",
) -> dict[str, Any]:
    path = claude_path or get_setting("claude_path")
    if not path:
        raise HostError("CLAUDE_NOT_CONFIGURED", "Claude Code path is not configured.")
    # Fall back to bypass for any unknown / malformed mode so a renderer bug
    # can't accidentally land us in interactive-prompt mode (which hangs in
    # --print headless).
    pmode = permission_mode if permission_mode in _ALLOWED_PERMISSION_MODES else "bypassPermissions"

    cwd = str(workspace_root())
    resume = _resume_flags(session_id)
    # Optional --model flag. We pass "haiku" for short, structured tasks like
    # connector-account identify — Haiku is ~3-4x faster than Sonnet/Opus for
    # the same tool-call result, dropping identify from ~10s to ~3-4s.
    # Falsy / unset = use the user's default model.
    model_flags = ["--model", model] if model else []
    # Extra dirs to grant Claude tool scope over — used when the user attaches
    # a folder in chat or @mentions a marked import folder. Lazy: --add-dir only
    # grants Read/Glob/Grep permission, it does NOT pre-read the directory, so
    # even huge folders cost zero tokens until Claude reaches into them. We
    # silently drop paths that don't exist on disk (e.g. external drive ejected
    # between attach and send) so the cmd-line stays valid.
    add_dir_flags: list[str] = []
    if add_dirs:
        seen: set[str] = set()
        for raw in add_dirs:
            if not isinstance(raw, str):
                continue
            stripped = raw.strip()
            if not stripped or stripped in seen:
                continue
            try:
                if not os.path.isdir(stripped):
                    continue
            except OSError:
                continue
            seen.add(stripped)
            add_dir_flags.extend(["--add-dir", stripped])
    # Force Claude to only use MCP servers AIOS hands it, ignoring claude.ai's
    # first-party connectors. Without this, a user whose Anthropic account has
    # Gmail linked to a different address gets cross-wired data when they ask
    # about their inbox — we hit this with `tradephani@gmail.com` overriding
    # the legitimately-connected Composio account.
    mcp_isolation = _mcp_isolation_flags()
    composio_hint = ["--append-system-prompt", _get_composio_system_prompt()] if mcp_isolation else []
    # Per-call system-prompt overlay — used by chat when an @agent is selected.
    # Stacks on top of the Composio hint, so the agent persona wraps inside the
    # tool-use guardrails. Empty / missing = chat default behavior.
    agent_overlay = ["--append-system-prompt", system_prompt] if system_prompt else []
    # Plan-mode coaching: tell Claude to ask clarifying questions BEFORE calling
    # ExitPlanMode if anything's ambiguous. Without this, plan-mode replies are
    # often based on assumptions and the resulting plan is wrong. For closed-set
    # choices Claude uses the AIOS_ASK marker (rendered as clickable buttons by
    # the renderer); for open questions, just plain prose. Only added when
    # pmode == "plan" so it doesn't bloat the prompt for normal turns.
    plan_mode_hint: list[str] = []
    if pmode == "plan":
        plan_mode_hint = ["--append-system-prompt", _PLAN_MODE_HINT]
    attempts = [
        [path, "--print", *resume, *mcp_isolation, *composio_hint, *agent_overlay, *plan_mode_hint, *model_flags, *add_dir_flags, "--output-format", "json", "--permission-mode", pmode, prompt],
        [path, "--print", *resume, *mcp_isolation, *composio_hint, *agent_overlay, *plan_mode_hint, *model_flags, *add_dir_flags, "--output-format", "text", "--permission-mode", pmode, prompt],
    ]
    if stream_id:
        stream_command = [
            path,
            "--print",
            *resume,
            *mcp_isolation,
            *composio_hint,
            *agent_overlay,
            *plan_mode_hint,
            *model_flags,
            *add_dir_flags,
            "--verbose",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--permission-mode",
            pmode,
            prompt,
        ]
        try:
            return run_claude_stream(stream_command, cwd, timeout, request_id, stream_id)
        except FileNotFoundError:
            raise HostError("CLAUDE_NOT_FOUND", f"Claude executable was not found: {path}")
        except HostError as exc:
            if session_id and exc.code in {"CLAUDE_FAILED", "CLAUDE_RESULT_ERROR", "CLAUDE_STREAM_ERROR"}:
                fallback = [c for c in stream_command if c != "--resume" and c != session_id]
                return run_claude_stream(fallback, cwd, timeout, request_id, stream_id)
            raise

    errors: list[str] = []

    for command in attempts:
        try:
            result = subprocess.run(
                command,
                cwd=cwd,
                env=execution_env(),
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        except FileNotFoundError:
            raise HostError("CLAUDE_NOT_FOUND", f"Claude executable was not found: {path}")
        except subprocess.TimeoutExpired:
            raise HostError("CLAUDE_TIMEOUT", "Claude Code did not finish before the timeout. Reconnect Claude or retry with a shorter prompt.")

        output = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()
        if result.returncode == 0 and output:
            parsed: dict[str, Any] | None = None
            try:
                parsed = json.loads(output)
            except json.JSONDecodeError:
                parsed = None
            if parsed and parsed.get("type") == "result":
                if parsed.get("is_error"):
                    raise HostError("CLAUDE_RESULT_ERROR", str(parsed.get("result") or stderr or "Claude returned an error."))
                return {
                    "response": str(parsed.get("result") or "").strip(),
                    "stderr": stderr,
                    "workspaceRoot": cwd,
                    "command": command[:5],
                    "sessionId": parsed.get("session_id"),
                    "costUsd": parsed.get("total_cost_usd"),
                    "durationMs": parsed.get("duration_ms"),
                    "modelUsage": parsed.get("modelUsage"),
                }
            return {
                "response": output,
                "stderr": stderr,
                "workspaceRoot": cwd,
                "command": command[:5],
            }
        errors.append(f"{command[:2]} exited {result.returncode}: {stderr or output}")

    raise HostError("CLAUDE_FAILED", "\n".join(errors))


def run_prime(args: dict[str, Any]) -> dict[str, Any]:
    return run_claude(
        "/prime",
        str(args.get("claudePath") or "") or None,
        timeout=90,
        request_id=str(args.get("_requestId") or "") or None,
        stream_id=str(args.get("streamId") or "") or None,
    )


_CONTEXT_TEMPLATES = {"business-info", "personal-info", "strategy", "current-data"}


def write_binary_file(args: dict[str, Any]) -> dict[str, Any]:
    import base64

    path = require_str(args, "path")
    data_b64 = args.get("data")
    if not isinstance(data_b64, str) or not data_b64:
        raise HostError("BAD_REQUEST", "Missing 'data' (base64 string).")

    try:
        binary = base64.b64decode(data_b64)
    except Exception as exc:
        raise HostError("BAD_REQUEST", f"Invalid base64 data: {exc}")

    target = workspace_root() / path
    if workspace_root() != target.resolve() and workspace_root() not in target.resolve().parents:
        raise HostError("BAD_REQUEST", "Path escapes workspace")

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(binary)
    return {"path": path, "bytes": len(binary)}


def _import_entry_dict(child: Path, base: Path) -> dict[str, Any]:
    from datetime import datetime, timezone

    stat = child.stat()
    rel = child.relative_to(base).as_posix()
    return {
        "name": child.name,
        "path": f"context/import/{rel}",
        "size": stat.st_size,
        "extension": child.suffix.lower().lstrip("."),
        "modifiedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }


def list_imports(_args: dict[str, Any]) -> dict[str, Any]:
    from datetime import datetime, timezone

    root = workspace_root() / "context" / "import"
    folders: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    marked_names = {m["name"] for m in list_marked_import_folders()}
    if root.exists():
        for child in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if child.is_dir():
                items = [c for c in child.iterdir() if c.is_file()]
                latest = max((c.stat().st_mtime for c in items), default=child.stat().st_mtime)
                total_size = sum(c.stat().st_size for c in items)
                folders.append({
                    "name": child.name,
                    "path": f"context/import/{child.name}",
                    "fileCount": len(items),
                    "totalSize": total_size,
                    "modifiedAt": datetime.fromtimestamp(latest, tz=timezone.utc).isoformat(),
                    "isMarked": child.name in marked_names,
                })
            elif child.is_file():
                files.append(_import_entry_dict(child, root))
    folders.sort(key=lambda f: f["modifiedAt"], reverse=True)
    return {"folders": folders, "entries": files}


def list_import_folder(args: dict[str, Any]) -> dict[str, Any]:
    name = require_str(args, "name")
    if "/" in name or "\\" in name or name.startswith("."):
        raise HostError("BAD_REQUEST", "Invalid folder name.")
    base = workspace_root() / "context" / "import"
    target = base / name
    if not target.exists() or not target.is_dir():
        raise HostError("NOT_FOUND", f"Folder not found: {name}")
    files: list[dict[str, Any]] = []
    for child in sorted(target.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if child.is_file():
            files.append(_import_entry_dict(child, base))
    return {"folder": name, "entries": files}


def create_import_folder(args: dict[str, Any]) -> dict[str, Any]:
    raw = require_str(args, "name").strip()
    if not raw:
        raise HostError("BAD_REQUEST", "Folder name cannot be empty.")
    safe = "".join(c for c in raw if c.isalnum() or c in (" ", "-", "_")).strip()
    safe = safe.replace(" ", "-")
    if not safe or safe.startswith("."):
        raise HostError("BAD_REQUEST", "Invalid folder name.")
    base = workspace_root() / "context" / "import"
    target = base / safe
    if target.exists():
        raise HostError("ALREADY_EXISTS", f"Folder already exists: {safe}")
    target.mkdir(parents=True, exist_ok=False)
    return {"name": safe, "path": f"context/import/{safe}"}


def delete_import_folder(args: dict[str, Any]) -> dict[str, Any]:
    import shutil

    name = require_str(args, "name")
    if "/" in name or "\\" in name or name.startswith("."):
        raise HostError("BAD_REQUEST", "Invalid folder name.")
    target = workspace_root() / "context" / "import" / name
    deleted = False
    if target.exists() and target.is_dir():
        shutil.rmtree(target)
        deleted = True
    # Always clean up the marker row — even if the folder was already gone on
    # disk, we want to keep the SQLite table honest. Cheap, idempotent.
    try:
        unmark_import_folder(name)
    except Exception:
        pass
    if deleted:
        broadcast_event("imports_changed", {"folderName": name, "deleted": True})
    return {"deleted": deleted, "name": name}


def toggle_import_marker(args: dict[str, Any]) -> dict[str, Any]:
    """Star / unstar an import folder so it appears in the chat composer's
    @ palette. Idempotent — re-marking refreshes marked_at; unmarking an
    already-unmarked folder returns the same shape."""
    name = require_str(args, "name").strip()
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise HostError("BAD_REQUEST", "Invalid folder name.")
    marked = bool(args.get("marked"))
    target = workspace_root() / "context" / "import" / name
    if not target.exists() or not target.is_dir():
        raise HostError("NOT_FOUND", f"Folder not found: {name}")
    try:
        result = mark_import_folder(name) if marked else unmark_import_folder(name)
    except ValueError as exc:
        raise HostError("BAD_REQUEST", str(exc))
    broadcast_event("imports_changed", {"folderName": name, "marked": marked})
    return result


def list_marked_import_folders_handler(_args: dict[str, Any]) -> dict[str, Any]:
    """Return the set of marked import folders for the chat @ palette. Includes
    each folder's absolute path so the renderer can forward it to run_task
    as an --add-dir target without another round-trip."""
    return {"folders": list_marked_import_folders()}


def link_folder_handler(args: dict[str, Any]) -> dict[str, Any]:
    """Register an arbitrary on-disk folder so it shows up on the Imports
    page and is mentionable in chat. Reference-by-path only — no copy."""
    raw = require_str(args, "absolutePath").strip()
    name = str(args.get("name") or "").strip() or None
    try:
        result = link_folder(raw, name)
    except ValueError as exc:
        raise HostError("BAD_REQUEST", str(exc))
    broadcast_event("imports_changed", {"absolutePath": raw, "linked": True})
    return result


def unlink_folder_handler(args: dict[str, Any]) -> dict[str, Any]:
    raw = require_str(args, "absolutePath").strip()
    try:
        result = unlink_folder(raw)
    except ValueError as exc:
        raise HostError("BAD_REQUEST", str(exc))
    broadcast_event("imports_changed", {"absolutePath": raw, "unlinked": True})
    return result


def list_linked_folders_handler(_args: dict[str, Any]) -> dict[str, Any]:
    return {"folders": list_linked_folders()}


def rotate_device_user_id_handler(_args: dict[str, Any]) -> dict[str, Any]:
    """Generate a brand-new device_user_id so the next connector flow gets
    a clean Composio entity and MCP session."""
    from workspace import rotate_device_user_id  # type: ignore
    return {"deviceUserId": rotate_device_user_id()}


def update_claude_mcp(args: dict[str, Any]) -> dict[str, Any]:
    """Merge an MCP server entry into Claude Code's settings.json.

    args:
      name (str): server name (e.g. "composio")
      config (dict | None): MCP server config block, or None to remove
    """
    from workspace import update_claude_mcp_config  # type: ignore
    name = require_str(args, "name")
    config = args.get("config")
    if config is not None and not isinstance(config, dict):
        raise HostError("BAD_REQUEST", "config must be an object or null.")
    return update_claude_mcp_config(name, config)


def delete_import(args: dict[str, Any]) -> dict[str, Any]:
    """Delete an import file. Accepts a bare filename (root) OR `folder/filename` path."""
    name = require_str(args, "name").strip().replace("\\", "/")
    if not name or name.startswith(".") or ".." in name:
        raise HostError("BAD_REQUEST", "Invalid import name.")
    parts = [p for p in name.split("/") if p]
    if any(p.startswith(".") for p in parts) or len(parts) > 2:
        raise HostError("BAD_REQUEST", "Invalid import name.")
    target = workspace_root() / "context" / "import" / Path(*parts)
    if target.exists() and target.is_file():
        target.unlink()
        return {"deleted": True, "name": name}
    return {"deleted": False, "name": name}


def restore_context_template(args: dict[str, Any]) -> dict[str, Any]:
    name = require_str(args, "name").strip()
    if name not in _CONTEXT_TEMPLATES:
        raise HostError("BAD_REQUEST", f"Unknown context template: {name}")

    starter_roots: list[Path] = []
    env_root = os.environ.get("AIOS_STARTER_KIT_ROOT")
    if env_root:
        starter_roots.append(Path(env_root))
    starter_roots.append(Path(__file__).resolve().parent.parent / "aios-starter-kit")
    starter_roots.append(Path.cwd() / "aios-starter-kit")
    starter = next(
        (root / "context" / f"{name}.md" for root in starter_roots if (root / "context" / f"{name}.md").exists()),
        None,
    )
    if starter is None:
        checked = ", ".join(str(root / "context" / f"{name}.md") for root in starter_roots)
        raise HostError("NOT_FOUND", f"Starter template missing on disk. Checked: {checked}")

    target = workspace_root() / "context" / f"{name}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    content = starter.read_text(encoding="utf-8")
    target.write_text(content, encoding="utf-8")
    return {"path": f"context/{name}.md", "content": content, "bytes": len(content.encode("utf-8"))}


def transcribe_audio(args: dict[str, Any]) -> dict[str, Any]:
    import base64
    import tempfile

    audio_b64 = args.get("audio")
    if not isinstance(audio_b64, str) or not audio_b64:
        raise HostError("BAD_REQUEST", "Missing 'audio' (base64 WAV string).")

    try:
        wav_bytes = base64.b64decode(audio_b64)
    except Exception as exc:
        raise HostError("BAD_REQUEST", f"Invalid base64 audio: {exc}")

    try:
        import speech_recognition as sr  # type: ignore
    except Exception as exc:
        # Catch every exception kind, not just ImportError — packaged builds
        # have surfaced things like FileNotFoundError (missing flac binary
        # touched at import time) and AttributeError (typing.Self on older
        # Python). Surface the real reason so we can diagnose from app logs
        # instead of guessing at "missing dependency".
        raise HostError(
            "TRANSCRIBE_INIT_FAILED",
            f"speech_recognition could not be loaded: {type(exc).__name__}: {exc}",
        )

    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(wav_bytes)
            tmp_path = tmp.name

        recognizer = sr.Recognizer()
        with sr.AudioFile(tmp_path) as source:
            audio = recognizer.record(source)

        engine = str(args.get("engine") or "google").lower()
        language = str(args.get("language") or "en-US")
        try:
            if engine == "sphinx":
                text = recognizer.recognize_sphinx(audio, language=language)
            else:
                text = recognizer.recognize_google(audio, language=language)
        except sr.UnknownValueError:
            return {"text": "", "engine": engine}
        except sr.RequestError as exc:
            raise HostError("STT_FAILED", f"Transcription service error: {exc}")

        return {"text": str(text or "").strip(), "engine": engine}
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def run_task(args: dict[str, Any]) -> dict[str, Any]:
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        raise HostError("EMPTY_PROMPT", "Prompt cannot be empty.")
    # Voice-control loop sends screenshots inline as base64. Write each to a
    # temp file in workspace/tmp/voice-control/ and reference the path in the
    # prompt — Claude Code CLI has no --image flag, so the agent uses its
    # Read tool (vision-capable on Sonnet+) to load the screenshot. One extra
    # tool-use round trip per turn; cost is acceptable.
    import base64
    from uuid import uuid4
    images_b64 = args.get("imagesBase64")
    image_paths: list[str] = []
    if isinstance(images_b64, list) and images_b64:
        tmp_dir = workspace_root() / "tmp" / "voice-control"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        for b64 in images_b64:
            if not isinstance(b64, str) or not b64:
                continue
            p = tmp_dir / f"{uuid4().hex}.png"
            try:
                p.write_bytes(base64.b64decode(b64))
                image_paths.append(str(p))
            except Exception:
                # Skip malformed; do not fail the whole call.
                pass
    # Inject image paths at the top of the prompt with an explicit Read
    # instruction so Claude doesn't ignore them.
    if image_paths:
        path_lines = "\n".join(f"  - {p}" for p in image_paths)
        prompt = (
            "The user attached the following image(s). Use the Read tool on each "
            "BEFORE you reply so you can see them:\n"
            f"{path_lines}\n\n"
            "After reading the image(s), respond to the request below.\n\n"
            "---\n\n"
            f"{prompt}"
        )
    # Folder context — list of absolute paths the renderer attached either
    # via the chat Sources → Folder picker, or via an @mention of a marked
    # import folder. Forwarded as `--add-dir` flags so Claude can Read/Glob
    # /Grep across each one. We don't validate-or-reject here: run_claude
    # silently drops missing paths (race-safe), and we want the inline prompt
    # block to still mention attempted-but-broken folders so Claude can flag.
    raw_dirs = args.get("addDirs")
    add_dirs: list[str] = []
    if isinstance(raw_dirs, list):
        for entry in raw_dirs:
            if isinstance(entry, str) and entry.strip():
                add_dirs.append(entry.strip())
    try:
        return run_claude(
            prompt,
            str(args.get("claudePath") or "") or None,
            timeout=180,
            request_id=str(args.get("_requestId") or "") or None,
            stream_id=str(args.get("streamId") or "") or None,
            session_id=str(args.get("sessionId") or "") or None,
            model=str(args.get("model") or "") or None,
            system_prompt=str(args.get("systemPrompt") or "") or None,
            add_dirs=add_dirs or None,
            permission_mode=str(args.get("permissionMode") or "") or "bypassPermissions",
        )
    finally:
        for p in image_paths:
            try:
                from pathlib import Path as _P
                _P(p).unlink(missing_ok=True)
            except Exception:
                pass


def generate_daily_brief(args: dict[str, Any]) -> dict[str, Any]:
    local_date = require_str(args, "localDate")
    # If we already saved a brief for today, return it without re-generating.
    existing = get_daily_brief(local_date)
    if existing:
        return {"brief": existing, "regenerated": False}

    claude_path = str(args.get("claudePath") or "") or get_setting("claude_path")
    if not claude_path:
        raise HostError("CLAUDE_NOT_CONFIGURED", "Claude Code is not configured.")

    prompt = build_daily_brief_prompt(local_date)
    result = run_claude(
        prompt,
        claude_path,
        timeout=180,
        request_id=str(args.get("_requestId") or "") or None,
        stream_id=str(args.get("streamId") or "") or None,
    )
    content = (result.get("response") or "").strip()
    if not content:
        raise HostError("CLAUDE_EMPTY", "Claude returned an empty brief.")
    # Headline = first H2 line, fallback to first sentence
    headline = ""
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            headline = stripped[3:].strip()
            break
    if not headline:
        first_chunk = content.split("\n", 1)[0].strip()
        headline = first_chunk[:120]
    saved = save_daily_brief(local_date, headline, content)
    return {"brief": saved, "regenerated": True}


def require_str(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str):
        raise HostError("BAD_REQUEST", f"Missing string argument: {key}")
    return value


# ─── Voice Control sidecar (v0.2.0+) ───────────────────────────────────────
# Screen capture + mouse/keyboard execution for the voice-control action loop.
# On Windows this is the production path. On macOS this is a fallback used
# until the native Swift sidecar (with AX-tree resolution + ScreenCaptureKit)
# is wired in. pyautogui is lazy-imported so the host startup cost stays low
# for users who never activate voice control.

def _pyautogui():
    import pyautogui as _g
    _g.FAILSAFE = True  # mouse to corner aborts — emergency stop
    return _g


def _active_monitor_bounds_win() -> dict[str, int] | None:
    """Return the bounds of the monitor containing the foreground window on
    Windows. None on failure or when no foreground window exists."""
    if not hasattr(__import__("sys"), "getwindowsversion"):
        return None
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None
        MONITOR_DEFAULTTONEAREST = 0x2
        hmon = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        if not hmon:
            return None

        class MONITORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD),
            ]
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            return None
        r = mi.rcMonitor
        return {"left": r.left, "top": r.top, "width": r.right - r.left, "height": r.bottom - r.top}
    except Exception:
        return None


def _active_monitor_bounds_mac() -> dict[str, int] | None:
    """Return bounds of the monitor containing the mouse cursor on Mac.
    None on failure.

    Without this, screen_capture(monitor="active") on multi-display Mac
    silently falls back to capturing the primary display — the voice
    loop screenshots the WRONG monitor when the user is working on a
    secondary display. The agent then can't see what it's supposed to
    act on and burns turns confused.

    We use pyautogui.position() (top-left coords on Mac via Quartz,
    matching mss's coordinate system) and find the mss monitor whose
    bounds contain the cursor. mss.monitors[0] is the virtual union,
    indices 1+ are individual monitors."""
    if sys.platform != "darwin":
        return None
    try:
        import pyautogui  # type: ignore
        from mss import mss  # type: ignore
        x, y = pyautogui.position()
        with mss() as sct:
            for i in range(1, len(sct.monitors)):
                m = sct.monitors[i]
                if (m["left"] <= x < m["left"] + m["width"] and
                        m["top"] <= y < m["top"] + m["height"]):
                    return {
                        "left": int(m["left"]),
                        "top": int(m["top"]),
                        "width": int(m["width"]),
                        "height": int(m["height"]),
                    }
        return None
    except Exception:
        return None


def screen_capture(args: dict[str, Any]) -> dict[str, Any]:
    """Capture a monitor and return base64 PNG. Args:
       - monitor: int index (0-based across mss's monitor list, where 0 is
         the union of all monitors) OR 'active' (default; the monitor that
         contains the focused window) OR 'primary' OR 'all'."""
    import base64
    from io import BytesIO
    monitor = args.get("monitor") if args else None
    # Default to 'active' so voice control naturally screenshots the monitor
    # the user is currently working on (most common case).
    if not monitor:
        monitor = "active"

    # mss is a transitive dep of pyautogui's pyscreeze; lazy-import.
    try:
        from mss import mss
        from PIL import Image
    except Exception:
        # Fallback to single-monitor pyautogui if mss isn't available.
        g = _pyautogui()
        img = g.screenshot()
        buf = BytesIO()
        img.save(buf, format="PNG")
        return {
            "png": base64.b64encode(buf.getvalue()).decode("ascii"),
            "width": img.width,
            "height": img.height,
            "monitor": "primary",
        }

    with mss() as sct:
        # mss().monitors[0] is the virtual union of all monitors; index 1+
        # are individual monitors. Map our friendlier values to that.
        bounds: dict[str, int] | None = None
        chosen = "primary"
        if monitor == "all":
            bounds = sct.monitors[0]
            chosen = "all"
        elif monitor == "active":
            # Platform-specific active monitor detection. On Windows we
            # use the foreground window's containing monitor; on Mac we
            # use the cursor's containing monitor (no equivalent of
            # GetForegroundWindow that gives us screen coords cheaply).
            # Both fall back to primary if detection fails.
            if sys.platform == "darwin":
                active = _active_monitor_bounds_mac()
            else:
                active = _active_monitor_bounds_win()
            if active:
                bounds = active
                chosen = "active"
            else:
                bounds = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
                chosen = "primary"
        elif monitor == "primary":
            bounds = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            chosen = "primary"
        else:
            try:
                idx = int(monitor)
                if 0 <= idx < len(sct.monitors):
                    bounds = sct.monitors[idx]
                    chosen = f"index_{idx}"
                else:
                    bounds = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
                    chosen = "primary"
            except (TypeError, ValueError):
                bounds = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
                chosen = "primary"

        shot = sct.grab(bounds)
        img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
        buf = BytesIO()
        img.save(buf, format="PNG")
        return {
            "png": base64.b64encode(buf.getvalue()).decode("ascii"),
            "width": img.width,
            "height": img.height,
            "monitor": chosen,
            "origin": {"x": bounds["left"], "y": bounds["top"]},
        }


_AX_CLICKABLE_TYPES = {
    "ButtonControl", "HyperlinkControl", "ListItemControl", "MenuItemControl",
    "TabItemControl", "RadioButtonControl", "CheckBoxControl", "SplitButtonControl",
    "ComboBoxControl", "EditControl", "TreeItemControl", "ImageControl",
    "DataItemControl", "HeaderItemControl",
}


_AX_TREE_CACHE: dict[str, Any] = {"at": 0.0, "args_key": "", "result": None}
_AX_TREE_CACHE_TTL_S = 2.0


def screen_ax_tree(args: dict[str, Any]) -> dict[str, Any]:
    """Windows UIAutomation: walk the focused window's accessibility tree and
    return a flat list of visible elements with bounds, labels, and types.
    The voice-control agent uses this to target elements by id instead of
    guessing pixel coordinates. On non-Windows or when UIA is unavailable,
    returns {available: false, ...} so the orchestrator falls back to vision.

    Includes a 2s TTL cache keyed by the call args so a prewarm fired from
    the renderer the moment the user opens the panel pays off — the first
    real turn reuses the warm result instead of re-walking from cold."""
    import sys
    if sys.platform != "win32":
        return {"available": False, "reason": "ax_tree only implemented on Windows in v0.2.0-beta", "elements": []}

    try:
        import uiautomation as auto
    except Exception as exc:
        return {"available": False, "reason": f"uiautomation not available: {exc}", "elements": []}

    import time
    max_depth = int(args.get("maxDepth") or 8)
    max_elements = int(args.get("maxElements") or 200)
    time_budget = float(args.get("timeBudget") or 1.5)
    deadline = time.monotonic() + time_budget

    args_key = f"{max_depth}|{max_elements}|{time_budget}"
    now = time.monotonic()
    if (
        _AX_TREE_CACHE["result"] is not None
        and _AX_TREE_CACHE["args_key"] == args_key
        and now - _AX_TREE_CACHE["at"] < _AX_TREE_CACHE_TTL_S
    ):
        cached = dict(_AX_TREE_CACHE["result"])
        cached["from_cache"] = True
        return cached

    elements: list[dict[str, Any]] = []
    truncated = False

    try:
        # Walk the foreground window specifically. Walking the full desktop
        # is too slow on most machines (3-5s) and adds elements the user
        # can't interact with anyway. If no foreground window, fall back to
        # root.
        target = auto.GetForegroundControl() or auto.GetRootControl()
        foreground_name = ""
        try:
            foreground_name = target.Name or target.ClassName or ""
        except Exception:
            pass

        def walk(ctrl: Any, depth: int) -> None:
            nonlocal truncated
            if time.monotonic() > deadline:
                truncated = True
                return
            if len(elements) >= max_elements:
                truncated = True
                return
            if depth > max_depth:
                return
            try:
                rect = ctrl.BoundingRectangle
                w = rect.right - rect.left
                h = rect.bottom - rect.top
                if w <= 0 or h <= 0:
                    pass  # skip but still descend — invisible container may have visible kids
                else:
                    is_offscreen = bool(getattr(ctrl, "IsOffscreen", False))
                    if not is_offscreen:
                        ctype = ctrl.ControlTypeName or ""
                        name = (ctrl.Name or "").strip()
                        if name or ctype in _AX_CLICKABLE_TYPES:
                            elements.append({
                                "id": len(elements),
                                "name": name[:120],
                                "control_type": ctype,
                                "automation_id": (getattr(ctrl, "AutomationId", "") or "")[:80],
                                "class_name": (getattr(ctrl, "ClassName", "") or "")[:60],
                                "bounds": {"x": rect.left, "y": rect.top, "w": w, "h": h},
                                "clickable": ctype in _AX_CLICKABLE_TYPES,
                            })
                children = ctrl.GetChildren() or []
                for child in children:
                    if time.monotonic() > deadline:
                        truncated = True
                        return
                    walk(child, depth + 1)
            except Exception:
                # Element threw on access — keep walking.
                return

        walk(target, 0)
    except Exception as exc:
        return {"available": False, "reason": f"AX walk failed: {exc}", "elements": []}

    result = {
        "available": True,
        "elements": elements,
        "truncated": truncated,
        "foreground": foreground_name,
        "count": len(elements),
    }
    _AX_TREE_CACHE["at"] = now
    _AX_TREE_CACHE["args_key"] = args_key
    _AX_TREE_CACHE["result"] = result
    return result


def voice_click(args: dict[str, Any]) -> dict[str, Any]:
    g = _pyautogui()
    x = int(args.get("x") or 0)
    y = int(args.get("y") or 0)
    button = str(args.get("button") or "left").lower()
    if button not in ("left", "right", "middle"):
        raise HostError("BAD_BUTTON", "button must be left, right, or middle")
    clicks = int(args.get("clicks") or 1)
    g.click(x=x, y=y, button=button, clicks=clicks)
    return {"ok": True, "x": x, "y": y, "button": button, "clicks": clicks}


def voice_type(args: dict[str, Any]) -> dict[str, Any]:
    g = _pyautogui()
    text = require_str(args, "text")
    # Optional clear: select-all then delete before typing. Critical for input
    # fields that may already have content (e.g. Windows Run remembers the
    # last command; search bars retain prior queries). Without this, TYPE
    # concatenates onto whatever's there and downstream commands break.
    #
    # Platform-correct select-all: Mac uses Cmd+A, every other OS uses
    # Ctrl+A. Before this fix the Mac path pressed Ctrl+A which most
    # Mac apps interpret as "move cursor to start of line" (or no-op),
    # so the field was never cleared — every TYPE with clear=true on
    # Mac appended to existing content instead of replacing it. Caught
    # in the seventh Mac audit pass.
    if bool(args.get("clear")):
        if sys.platform == "darwin":
            g.hotkey("command", "a")
        else:
            g.hotkey("ctrl", "a")
        g.press("delete")
    # 0.02s between keystrokes — fast enough to feel natural, slow enough that
    # apps with input throttling (Slack, some web inputs) don't drop chars.
    g.write(text, interval=0.02)
    return {"ok": True, "length": len(text), "cleared": bool(args.get("clear"))}


def _mac_bring_to_foreground(app_name: str, attempts: int = 6, gap: float = 0.4) -> bool:
    """macOS: bring the just-launched app to the foreground. After `open -a`,
    the app may launch behind AIOS (especially when AIOS itself was front-
    most). Without this, the next screenshot still shows AIOS and Claude
    can't find the target app to interact with.

    Uses AppleScript's `tell application "X" to activate` — works for any
    app whose user-facing display name was passed to `open -a`. Retries a
    few times because the app's process can take a moment to register."""
    import sys
    if sys.platform != "darwin":
        return False
    import subprocess
    import time
    clean = (app_name or "").strip()
    if not clean:
        return False
    # Strip a trailing ".app" if the user passed it that way.
    if clean.lower().endswith(".app"):
        clean = clean[:-4]
    for _ in range(attempts):
        try:
            # AppleScript handles names with spaces fine when wrapped in quotes.
            script = f'tell application "{clean}" to activate'
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=2.5,
            )
            if result.returncode == 0:
                return True
        except Exception:
            pass
        time.sleep(gap)
    return False


def _win_bring_to_foreground(matcher: str, attempts: int = 8, gap: float = 0.4) -> bool:
    """After launching an app, find its window by title-matching and bring
    it to the foreground. Solves the "Spotify opened in the background"
    problem where Claude burned a turn clicking the taskbar to focus it.
    Returns True if a matching window was found and SetForegroundWindow was
    called, False otherwise. Best-effort — never raises."""
    import sys
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        from ctypes import wintypes
        import time

        user32 = ctypes.windll.user32

        EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def is_match_window(hwnd: int) -> bool:
            if not user32.IsWindowVisible(hwnd):
                return False
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return False
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = (buf.value or "").strip()
            if not title:
                return False
            return matcher.lower() in title.lower()

        found_hwnd: list[int] = []

        @EnumWindowsProc
        def collect(hwnd, _lparam):
            if is_match_window(hwnd):
                found_hwnd.append(hwnd)
                return False  # stop enumerating
            return True  # keep going

        for _ in range(attempts):
            found_hwnd.clear()
            user32.EnumWindows(collect, 0)
            if found_hwnd:
                hwnd = found_hwnd[0]
                # SetForegroundWindow alone is unreliable when the calling
                # process isn't the foreground app. AttachThreadInput + the
                # show/restore dance is the well-known workaround.
                try:
                    SW_RESTORE = 9
                    user32.ShowWindow(hwnd, SW_RESTORE)
                    fg = user32.GetForegroundWindow()
                    cur_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
                    new_tid = user32.GetWindowThreadProcessId(hwnd, None)
                    attached = False
                    try:
                        if cur_tid and new_tid and cur_tid != new_tid:
                            user32.AttachThreadInput(cur_tid, new_tid, True)
                            attached = True
                        user32.SetForegroundWindow(hwnd)
                    finally:
                        # Always detach so a SetForegroundWindow failure or
                        # sandbox denial never leaks a THREAD_INFO struct that
                        # would later deadlock the event loop on app-switch.
                        if attached:
                            user32.AttachThreadInput(cur_tid, new_tid, False)
                    user32.BringWindowToTop(hwnd)
                except Exception:
                    pass
                return True
            time.sleep(gap)
        return False
    except Exception:
        return False


def _win_launch_via_start_apps(name: str) -> None:
    """Use PowerShell's Get-StartApps to find a Start-menu app matching `name`
    (fuzzy, case-insensitive) and launch it via its AUMID. This is what makes
    Microsoft Store / UWP apps like Spotify, Discord, WhatsApp work — they're
    not on PATH and aren't in the App Paths registry, but they DO appear in
    Get-StartApps with a valid AppsFolder AUMID."""
    import subprocess
    safe = name.replace("'", "''")
    # Get-StartApps' AppID is either a Microsoft Store AUMID (e.g.
    # "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App") OR a full file path
    # for classic apps (e.g. "C:\Users\me\AppData\Roaming\Spotify\Spotify.exe").
    # Pick the right Start-Process form based on which it is.
    ps_script = (
        f"$ErrorActionPreference='Stop'; "
        f"$name = '{safe}'; "
        f"$app = Get-StartApps | "
        f"Where-Object {{ $_.Name -like \"*$name*\" }} | "
        f"Select-Object -First 1; "
        f"if (-not $app) {{ throw 'No Start menu app matching: ' + $name }}; "
        f"if ($app.AppID -match '\\\\' -or $app.AppID -match '\\.exe$') {{ "
        f"  Start-Process -FilePath $app.AppID "
        f"}} else {{ "
        f"  Start-Process \"shell:AppsFolder\\$($app.AppID)\" "
        f"}}"
    )
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps_script],
        capture_output=True,
        text=True,
        timeout=12,
        creationflags=creationflags,
    )
    if result.returncode != 0:
        msg = (result.stderr or result.stdout or "PowerShell Start-Process failed").strip()
        raise RuntimeError(msg)


def voice_open(args: dict[str, Any]) -> dict[str, Any]:
    """Launch an app, file, or URL via the OS shell. Tries several strategies
    so it works for: PATH binaries (notepad), Microsoft Store / UWP apps
    (Spotify, Discord, WhatsApp), apps registered under App Paths (Chrome,
    VS Code), URLs, file paths, and custom protocols (mailto:, ms-settings:)."""
    import subprocess
    import sys
    target = require_str(args, "target").strip()
    if not target:
        raise HostError("BAD_TARGET", "target is required")

    last_err: Exception | None = None
    strategies: list[Any] = []

    if sys.platform == "win32":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        looks_like_app = (
            ":" not in target
            and "\\" not in target
            and "/" not in target
            and "." not in target.split(":")[0]
        )
        # Strategy ORDER MATTERS. `cmd /c start` always returns success
        # immediately even when the target can't be found (the missing-app
        # popup is asynchronous), so it swallows what should have been a
        # fall-through to better strategies. For app-name targets we resolve
        # via PowerShell Get-StartApps FIRST (synchronous, errors propagate),
        # then fall back to `start` only for paths / URLs / protocols.
        if looks_like_app:
            # 1. PowerShell Get-StartApps fuzzy match. Catches Microsoft Store
            #    / UWP apps (Spotify, Discord, WhatsApp), classic apps in the
            #    Start menu (Chrome, VS Code), and anything pinned. Errors
            #    bubble synchronously so we know if it failed.
            strategies.append(lambda: _win_launch_via_start_apps(target))
        # 2. cmd /c start "" <target> — shell launcher for URLs, file paths,
        #    ms-* protocols, mailto:, and the few PATH-resident binaries.
        strategies.append(lambda: subprocess.Popen(
            ["cmd", "/c", "start", "", "/B", target],
            shell=False,
            creationflags=creationflags,
            close_fds=True,
        ))
        # 3. os.startfile — Win32 ShellExecute, file associations + URLs.
        import os as _os
        strategies.append(lambda: _os.startfile(target))  # type: ignore[attr-defined]
        # 4. Direct Popen — for explicit .exe paths.
        strategies.append(lambda: subprocess.Popen([target], close_fds=True))
    elif sys.platform == "darwin":
        # 1. open -a APP — launches an installed Mac app by display name
        #    ("Spotify", "Visual Studio Code") regardless of cwd.
        strategies.append(lambda: subprocess.Popen(["open", "-a", target]))
        # 2. open URL / path — fallback for URLs and file paths.
        strategies.append(lambda: subprocess.Popen(["open", target]))
        # 3. open -b BUNDLE_ID — if target looks like a bundle identifier.
        if "." in target and "/" not in target and " " not in target:
            strategies.append(lambda: subprocess.Popen(["open", "-b", target]))
    else:
        strategies.append(lambda: subprocess.Popen(["xdg-open", target]))

    for fn in strategies:
        try:
            fn()
            # Best-effort: bring the newly-launched app's window to the
            # foreground so Claude doesn't burn the next turn clicking the
            # taskbar to focus it. Use the target name as a fuzzy title
            # match — works for most apps whose window title contains the
            # app name (Notepad, Spotify, Chrome, VS Code, etc.). Skip
            # for URLs / paths / protocols which target the browser/file
            # explorer (already focused or system-launched).
            target_clean = target.split(":")[0].split("\\")[-1].split("/")[-1]
            if target_clean and not target_clean.lower().startswith(("http", "ms-", "mailto")):
                if sys.platform == "win32":
                    focused = _win_bring_to_foreground(target_clean)
                elif sys.platform == "darwin":
                    focused = _mac_bring_to_foreground(target_clean)
                else:
                    focused = False
            else:
                focused = False
            return {"ok": True, "target": target, "focused": focused}
        except Exception as exc:
            last_err = exc
            continue
    raise HostError("OPEN_FAILED", f"Couldn't open '{target}': {last_err}")


def voice_hotkey(args: dict[str, Any]) -> dict[str, Any]:
    g = _pyautogui()
    keys = args.get("keys")
    if isinstance(keys, str):
        keys = [k.strip().lower() for k in keys.split("+") if k.strip()]
    if not isinstance(keys, list) or not keys:
        raise HostError("BAD_KEYS", "keys must be a list of key names or 'key1+key2' string")
    g.hotkey(*keys)
    return {"ok": True, "keys": keys}


def voice_scroll(args: dict[str, Any]) -> dict[str, Any]:
    g = _pyautogui()
    dy = int(args.get("dy") or 0)
    g.scroll(dy)
    return {"ok": True, "dy": dy}


def voice_move(args: dict[str, Any]) -> dict[str, Any]:
    g = _pyautogui()
    x = int(args.get("x") or 0)
    y = int(args.get("y") or 0)
    duration = float(args.get("duration") or 0.2)
    g.moveTo(x, y, duration=duration)
    return {"ok": True, "x": x, "y": y}


def voice_drag(args: dict[str, Any]) -> dict[str, Any]:
    """Drag from (x1,y1) to (x2,y2) holding the named button. Used for
    window resize, slider drags, text selection by drag, drag-and-drop."""
    g = _pyautogui()
    x1 = int(args.get("x1") or 0)
    y1 = int(args.get("y1") or 0)
    x2 = int(args.get("x2") or 0)
    y2 = int(args.get("y2") or 0)
    duration = float(args.get("duration") or 0.35)
    button = str(args.get("button") or "left").lower()
    if button not in ("left", "right", "middle"):
        raise HostError("BAD_BUTTON", "button must be left, right, or middle")
    g.moveTo(x1, y1, duration=0.1)
    g.dragTo(x2, y2, duration=duration, button=button)
    return {"ok": True, "from": [x1, y1], "to": [x2, y2], "button": button}


def voice_clipboard_get(_args: dict[str, Any]) -> dict[str, Any]:
    """Return the current clipboard text. Useful when Claude wants to read
    what the user copied earlier, or check after a [HOTKEY ctrl+c]."""
    try:
        import pyperclip  # ships with pyautogui
        text = pyperclip.paste()
        return {"text": text or ""}
    except Exception as exc:
        raise HostError("CLIPBOARD_GET_FAILED", f"Failed to read clipboard: {exc}")


def voice_clipboard_set(args: dict[str, Any]) -> dict[str, Any]:
    """Set the clipboard to a given text. Combine with [HOTKEY ctrl+v] for
    fast paste of long content (way faster than typing key-by-key)."""
    text = require_str(args, "text")
    try:
        import pyperclip
        pyperclip.copy(text)
        return {"ok": True, "length": len(text)}
    except Exception as exc:
        raise HostError("CLIPBOARD_SET_FAILED", f"Failed to write clipboard: {exc}")


def voice_wait(args: dict[str, Any]) -> dict[str, Any]:
    """Pause for N seconds so the UI can settle (app launch, animation,
    page load) before the next action. Capped at 5s per call."""
    import time
    seconds = float(args.get("seconds") or 1)
    seconds = max(0.0, min(5.0, seconds))
    time.sleep(seconds)
    return {"ok": True, "waited": seconds}


_WIN_CURSOR_HANDLES: dict[int, str] = {}
def _ensure_win_cursor_handles() -> dict[int, str]:
    """Resolve and cache the hCursor handle for each well-known system
    cursor so we can compare GetCursorInfo()'s active handle against them.
    Cheap one-time lookup; LoadCursorW(NULL, ...) returns a shared system
    handle that doesn't need to be freed."""
    global _WIN_CURSOR_HANDLES
    if _WIN_CURSOR_HANDLES:
        return _WIN_CURSOR_HANDLES
    try:
        import sys
        if sys.platform != "win32":
            return {}
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        u.LoadCursorW.restype = wintypes.HANDLE
        u.LoadCursorW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]
        # IDC_* constants from WinUser.h. Cast int → LPCWSTR via MAKEINTRESOURCE.
        defs: list[tuple[int, str]] = [
            (32512, "arrow"),       # IDC_ARROW
            (32513, "ibeam"),       # IDC_IBEAM
            (32514, "wait"),        # IDC_WAIT
            (32515, "cross"),       # IDC_CROSS
            (32516, "up_arrow"),    # IDC_UPARROW
            (32642, "size_nwse"),   # IDC_SIZENWSE
            (32643, "size_nesw"),   # IDC_SIZENESW
            (32644, "size_we"),     # IDC_SIZEWE
            (32645, "size_ns"),     # IDC_SIZENS
            (32646, "size_all"),    # IDC_SIZEALL
            (32648, "no"),          # IDC_NO (forbidden)
            (32649, "hand"),        # IDC_HAND (link)
            (32650, "app_starting"),# IDC_APPSTARTING
            (32651, "help"),        # IDC_HELP
        ]
        out: dict[int, str] = {}
        for resource_id, name in defs:
            handle = u.LoadCursorW(0, ctypes.c_wchar_p(resource_id))
            if handle:
                out[int(handle)] = name
        _WIN_CURSOR_HANDLES = out
    except Exception:
        _WIN_CURSOR_HANDLES = {}
    return _WIN_CURSOR_HANDLES


def voice_get_cursor_type(_args: dict[str, Any]) -> dict[str, Any]:
    """Return the OS cursor's current shape (arrow / ibeam / hand / etc).
    Used by the cursor companion overlay to swap its sprite so it matches
    what the user is doing — typing → I-beam, hovering link → hand, etc.

    Cheap call: one GetCursorInfo + a dict lookup. Polled at ~10Hz by main."""
    import sys
    if sys.platform != "win32":
        return {"available": False, "type": "arrow"}
    try:
        import ctypes
        from ctypes import wintypes

        class POINT(ctypes.Structure):
            _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

        class CURSORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("flags", wintypes.DWORD),
                ("hCursor", wintypes.HANDLE),
                ("ptScreenPos", POINT),
            ]

        info = CURSORINFO()
        info.cbSize = ctypes.sizeof(CURSORINFO)
        if not ctypes.windll.user32.GetCursorInfo(ctypes.byref(info)):
            return {"available": True, "type": "arrow"}
        handles = _ensure_win_cursor_handles()
        name = handles.get(int(info.hCursor), "arrow")
        return {"available": True, "type": name}
    except Exception:
        return {"available": False, "type": "arrow"}


def mac_check_permissions(_args: dict[str, Any]) -> dict[str, Any]:
    """Return current status of the 4 macOS permissions AIOS needs.
    Each is one of: "granted" | "denied" | "not-determined" | "unknown".
    On non-Mac platforms returns {available: False}.

    Permissions:
      microphone     — voice transcription
      screenRecording— screen_capture for voice control vision
      accessibility  — pyautogui clicks/typing + the Cmd+Option CGEventTap
      automation     — AppleScript "tell application X to activate" for
                       bringing launched apps to foreground

    `automation` always reports "auto" — there's no public API to
    inspect Apple Events permission status; the system prompts on
    first use per target app and remembers the answer."""
    import sys
    if sys.platform != "darwin":
        return {"available": False}

    result: dict[str, str] = {
        "microphone": "unknown",
        "screenRecording": "unknown",
        "accessibility": "unknown",
        "automation": "auto",
    }

    # 1. Microphone — AVCaptureDevice.authorizationStatusForMediaType
    # 0=notDetermined, 1=restricted, 2=denied, 3=authorized
    try:
        from AVFoundation import AVCaptureDevice
        AVMediaTypeAudio = "soun"  # constant value; importing the symbol can be flaky
        status = AVCaptureDevice.authorizationStatusForMediaType_(AVMediaTypeAudio)
        result["microphone"] = (
            "granted" if status == 3
            else "denied" if status in (1, 2)
            else "not-determined"
        )
    except Exception as exc:
        result["microphone"] = "unknown"
        print(f"[permissions] mic check failed: {exc}", file=sys.stderr, flush=True)

    # 2. Screen Recording — CGPreflightScreenCaptureAccess (10.15+)
    try:
        from Quartz import CGPreflightScreenCaptureAccess
        result["screenRecording"] = "granted" if CGPreflightScreenCaptureAccess() else "denied"
    except Exception as exc:
        result["screenRecording"] = "unknown"
        print(f"[permissions] screen check failed: {exc}", file=sys.stderr, flush=True)

    # 3. Accessibility — AXIsProcessTrusted
    try:
        from ApplicationServices import AXIsProcessTrusted
        result["accessibility"] = "granted" if AXIsProcessTrusted() else "denied"
    except Exception as exc:
        result["accessibility"] = "unknown"
        print(f"[permissions] ax check failed: {exc}", file=sys.stderr, flush=True)

    return {"available": True, **result}


def mac_request_permission(args: dict[str, Any]) -> dict[str, Any]:
    """Trigger the appropriate Mac permission grant flow:
      microphone     — fires CGRequestScreenCaptureAccess-equivalent via
                       AVCaptureDevice.requestAccess (auto-prompts user)
      screenRecording— opens System Settings → Privacy → Screen Recording
                       (manual grant required; macOS never auto-prompts)
      accessibility  — opens System Settings → Privacy → Accessibility
      automation     — runs a no-op AppleScript so macOS shows the
                       Apple Events permission prompt for Finder

    Returns {ok: True} after kicking off the flow. The renderer should
    poll mac_check_permissions every ~2s to detect when the user
    completes the grant."""
    import sys
    import subprocess
    if sys.platform != "darwin":
        return {"ok": False, "reason": "darwin only"}

    kind = str(args.get("kind") or "")
    if kind == "microphone":
        try:
            from AVFoundation import AVCaptureDevice
            AVMediaTypeAudio = "soun"
            # requestAccessForMediaType_completionHandler_ is async; the
            # completion handler is fire-and-forget here. The system
            # dialog appears immediately for the user. Polling
            # mac_check_permissions afterwards catches the response.
            AVCaptureDevice.requestAccessForMediaType_completionHandler_(
                AVMediaTypeAudio, lambda granted: None
            )
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}

    if kind == "screenRecording":
        # First call CGRequestScreenCaptureAccess — on first launch this
        # adds AIOS to the Privacy pane list (otherwise the user has to
        # find the app via "+" themselves). Then open the Settings pane.
        try:
            from Quartz import CGRequestScreenCaptureAccess
            CGRequestScreenCaptureAccess()
        except Exception:
            pass
        try:
            subprocess.run(
                ["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"],
                check=False,
            )
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}

    if kind == "accessibility":
        # AXIsProcessTrustedWithOptions with prompt=True adds AIOS to
        # the list and shows the system "Open System Settings" dialog.
        try:
            from ApplicationServices import AXIsProcessTrustedWithOptions
            from CoreFoundation import CFDictionaryCreate, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks
            from ApplicationServices import kAXTrustedCheckOptionPrompt
            options = {kAXTrustedCheckOptionPrompt: True}
            AXIsProcessTrustedWithOptions(options)
        except Exception:
            pass
        try:
            subprocess.run(
                ["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"],
                check=False,
            )
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}

    if kind == "automation":
        # Fire a harmless AppleScript that targets Finder so macOS shows
        # the Apple Events permission dialog. Once granted, future
        # AppleScripts to ANY app fire the same dialog per-target the
        # first time (no way to batch-grant ahead of time).
        try:
            subprocess.run(
                ["osascript", "-e", 'tell application "Finder" to activate'],
                check=False,
                timeout=4,
            )
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}

    return {"ok": False, "reason": f"unknown kind: {kind}"}


def voice_check_environment(_args: dict[str, Any]) -> dict[str, Any]:
    """Cheap probe used between voice-loop turns to detect when the user
    Cmd-Tabs away mid-workflow OR when a modal dialog has popped up that
    needs human attention. Both cases pause the loop so the agent doesn't
    blindly click into the wrong app or behind a modal.

    Returns:
        available: false on non-Windows (Mac equivalent in v0.5.0).
        foreground_app: process name (e.g. "chrome.exe", "Notepad.exe").
        foreground_title: window title.
        foreground_pid: process ID (for unique app instance tracking).
        modal_present: true if a Window control marked IsModal is on top
            of the foreground window."""
    import sys
    if sys.platform != "win32":
        return {"available": False, "reason": "win32 only"}

    try:
        import uiautomation as auto
    except Exception as exc:
        return {"available": False, "reason": f"uiautomation not available: {exc}"}

    try:
        fg = auto.GetForegroundControl()
        if fg is None:
            return {"available": True, "foreground_app": "", "foreground_title": "", "foreground_pid": 0, "modal_present": False}
        title = ""
        try:
            title = (fg.Name or "")[:200]
        except Exception:
            pass
        pid = 0
        try:
            pid = int(getattr(fg, "ProcessId", 0) or 0)
        except Exception:
            pass
        # Process name from PID via psutil if available; fall back to
        # WMIC-free lookup using ctypes if not. We avoid spawning a
        # subprocess in the polling path.
        app_name = ""
        try:
            import ctypes
            from ctypes import wintypes
            PROCESS_QUERY_LIMITED = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED, False, pid)
            if handle:
                try:
                    buf = ctypes.create_unicode_buffer(260)
                    size = wintypes.DWORD(260)
                    if ctypes.windll.kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                        full = buf.value
                        app_name = full.rsplit("\\", 1)[-1]
                finally:
                    ctypes.windll.kernel32.CloseHandle(handle)
        except Exception:
            pass

        # Modal detection: look at the foreground window's siblings (windows
        # owned by the same process) for one whose ControlType is Window AND
        # whose WindowPattern reports IsModal. Cheap — children of root
        # filtered by pid.
        modal_present = False
        try:
            root = auto.GetRootControl()
            for child in (root.GetChildren() or []):
                try:
                    if int(getattr(child, "ProcessId", 0) or 0) != pid:
                        continue
                    pat = child.GetWindowPattern() if hasattr(child, "GetWindowPattern") else None
                    if pat and getattr(pat, "IsModal", False):
                        modal_present = True
                        break
                except Exception:
                    continue
        except Exception:
            pass

        return {
            "available": True,
            "foreground_app": app_name,
            "foreground_title": title,
            "foreground_pid": pid,
            "modal_present": modal_present,
        }
    except Exception as exc:
        return {"available": False, "reason": f"probe failed: {exc}"}


def dispatch(cmd: str, args: dict[str, Any]) -> Any:
    handlers: dict[str, Callable[[dict[str, Any]], Any]] = {
        "get_workspace_info": lambda _args: get_workspace_info(),
        "get_onboarding_state": lambda _args: get_onboarding_state(),
        "save_onboarding_answer": lambda a: save_onboarding_answer(
            require_str(a, "questionId"),
            require_str(a, "value"),
            int(a["step"]) if "step" in a and a["step"] is not None else None,
        ),
        "complete_onboarding": lambda a: complete_onboarding(a.get("answers") if isinstance(a.get("answers"), dict) else None),
        "complete_onboarding_freeform": lambda a: complete_onboarding_freeform(str(a.get("text") or ""), str(a.get("seedFolderPath") or ""), str(a.get("seedFolderName") or "")),
        "reset_onboarding": lambda _a: reset_onboarding(),
        "reset_workspace": lambda _a: reset_workspace(),
        "read_file": lambda a: read_file(require_str(a, "path")),
        "write_file": lambda a: write_file(require_str(a, "path"), require_str(a, "content")),
        "append_file": lambda a: append_file(require_str(a, "path"), require_str(a, "content")),
        "move_file": lambda a: move_file(require_str(a, "fromPath"), require_str(a, "toPath")),
        "list_modules": lambda _args: list_modules(),
        "install_module": lambda a: copy_module_assets(require_str(a, "moduleId")),
        "get_context_summary": lambda _args: get_context_summary(),
        "list_workspace_files": lambda a: list_workspace_files(int(a.get("limit") or 400)),
        "list_workspace_section": lambda a: list_workspace_section(require_str(a, "section")),
        "list_directory": lambda a: list_directory(require_str(a, "path"), bool(a.get("recursive")), int(a.get("limit") or 200)),
        "list_external_directory": lambda a: list_external_directory(require_str(a, "path"), int(a.get("limit") or 200)),
        "browse_external_directory": lambda a: browse_external_directory(require_str(a, "path"), int(a.get("limit") or 500)),
        "get_recent_workspace_activity": lambda a: get_recent_workspace_activity(int(a.get("limit") or 20)),
        "read_markdown_preview": lambda a: read_markdown_preview(require_str(a, "path")),
        "list_outputs": lambda _args: get_outputs_summary(),
        "list_plans": lambda _args: get_plans_summary(),
        "list_shares": lambda _args: get_shares_summary(),
        "get_sessions": lambda _args: get_sessions(),
        "create_thread": lambda a: create_thread(str(a.get("title") or "").strip() or None),
        "rename_thread": lambda a: rename_thread(require_str(a, "id"), require_str(a, "title")),
        "delete_thread": lambda a: delete_thread(require_str(a, "id")),
        "save_session": lambda a: save_session(a["session"] if isinstance(a.get("session"), dict) else {}),
        "get_setting": lambda a: {"key": require_str(a, "key"), "value": get_setting(require_str(a, "key"))},
        "set_setting": lambda a: set_setting(require_str(a, "key"), require_str(a, "value")),
        "run_prime": run_prime,
        "run_task": run_task,
        "transcribe_audio": transcribe_audio,
        "restore_context_template": restore_context_template,
        "write_binary_file": write_binary_file,
        "list_imports": list_imports,
        "delete_import": delete_import,
        "list_import_folder": list_import_folder,
        "create_import_folder": create_import_folder,
        "delete_import_folder": delete_import_folder,
        "toggle_import_marker": toggle_import_marker,
        "list_marked_import_folders": list_marked_import_folders_handler,
        "link_folder": link_folder_handler,
        "unlink_folder": unlink_folder_handler,
        "list_linked_folders": list_linked_folders_handler,
        "update_claude_mcp": update_claude_mcp,
        "rotate_device_user_id": rotate_device_user_id_handler,
        "list_connector_status": lambda _a: list_connector_status(),
        "list_auto_tasks": lambda _a: list_auto_tasks(),
        "create_auto_task": lambda a: create_auto_task(
            require_str(a, "name"), require_str(a, "prompt"), require_str(a, "schedule")
        ),
        "update_auto_task": lambda a: update_auto_task(
            int(require_str(a, "id") if isinstance(a.get("id"), str) else a["id"]),
            name=a.get("name") if isinstance(a.get("name"), str) else None,
            prompt=a.get("prompt") if isinstance(a.get("prompt"), str) else None,
            schedule=a.get("schedule") if isinstance(a.get("schedule"), str) else None,
        ),
        "delete_auto_task": lambda a: delete_auto_task(int(a["id"])),
        "toggle_auto_task": lambda a: toggle_auto_task(int(a["id"]), bool(a.get("enabled"))),
        "list_recent_auto_runs": lambda a: list_recent_auto_runs(int(a.get("limit") or 10)),
        "list_due_auto_tasks": lambda _a: {"tasks": due_auto_tasks()},
        "begin_auto_task_run": lambda a: begin_auto_task_run(int(a["taskId"])),
        "finish_auto_task_run": lambda a: finish_auto_task_run(
            int(a["runId"]),
            status=require_str(a, "status"),
            output_path=a.get("outputPath") if isinstance(a.get("outputPath"), str) else None,
            cost_usd=float(a["costUsd"]) if a.get("costUsd") is not None else None,
            error=a.get("error") if isinstance(a.get("error"), str) else None,
        ),
        "advance_auto_task": lambda a: (advance_auto_task(int(a["taskId"])) or {"id": int(a["taskId"])}),
        "delete_workspace_file": lambda a: delete_workspace_file(require_str(a, "path")),
        "get_today_brief_status": lambda a: get_today_brief_status(require_str(a, "localDate")),
        "generate_daily_brief": generate_daily_brief,
        "list_daily_briefs": lambda a: list_daily_briefs(int(a.get("limit") or 60)),
        "mark_brief_seen": lambda a: mark_brief_seen(require_str(a, "localDate")),
        # Agents — 9 built-in personas (CEO + 8 departments) plus custom agents
        # the CEO can spawn at runtime via [SPAWN_AGENT: ...].
        "list_agents": lambda _a: agents_mod.list_agents(),
        "get_agent": lambda a: agents_mod.get_agent(require_str(a, "id")),
        "update_agent_prompt": lambda a: agents_mod.update_agent_prompt(
            require_str(a, "id"), require_str(a, "prompt")
        ),
        "reset_agent_prompt": lambda a: agents_mod.reset_agent_prompt(require_str(a, "id")),
        "delete_agent": lambda a: agents_mod.delete_agent(require_str(a, "id")),
        # Voice control sidecar (v0.2.0+) — see screen_capture / voice_*
        # functions above. Mac will get a Swift sidecar later; pyautogui is
        # the Windows production path and Mac dev fallback.
        "screen_capture": screen_capture,
        "screen_ax_tree": screen_ax_tree,
        "voice_click": voice_click,
        "voice_type": voice_type,
        "voice_hotkey": voice_hotkey,
        "voice_scroll": voice_scroll,
        "voice_move": voice_move,
        "voice_open": voice_open,
        "voice_drag": voice_drag,
        "voice_clipboard_get": voice_clipboard_get,
        "voice_clipboard_set": voice_clipboard_set,
        "voice_wait": voice_wait,
        "voice_check_environment": voice_check_environment,
        "voice_get_cursor_type": voice_get_cursor_type,
        "mac_check_permissions": mac_check_permissions,
        "mac_request_permission": mac_request_permission,
        "create_custom_agent": lambda a: agents_mod.create_custom_agent(
            name=require_str(a, "name"),
            role=str(a.get("role") or "").strip() or "Custom agent",
            prompt=require_str(a, "prompt"),
            parent_id=str(a.get("parentId") or "").strip() or "ceo",
        ),
        # Tasks — local Kanban store. The runner that spawns Claude per task
        # lands in Phase 2 (v0.1.17). For now the queue accepts work and
        # persists it; status stays at "pending" until the runner exists.
        "list_tasks": lambda a: tasks_store.list_tasks(
            status_filter=a.get("status") if isinstance(a.get("status"), str) else None,
            agent_id=a.get("agentId") if isinstance(a.get("agentId"), str) else None,
            limit=int(a.get("limit") or 500),
        ),
        "get_task": lambda a: tasks_store.get_task(require_str(a, "id")) or {},
        "delete_task": lambda a: tasks_store.delete_task(require_str(a, "id")),
        "create_task": lambda a: tasks_store.create_task(
            name=str(a.get("name") or "").strip() or "",
            message=require_str(a, "message"),
            agent_id=require_str(a, "agentId"),
            priority=int(a.get("priority") or 3),
        ),
        "task_action": lambda a: tasks_store.task_action(
            require_str(a, "id"),
            require_str(a, "action"),
            note=a.get("note") if isinstance(a.get("note"), str) else None,
        ),
        "cancel_task": lambda a: tasks_store.cancel_task(require_str(a, "id")),
        "cancel_chat_stream": lambda a: cancel_chat_stream(require_str(a, "streamId")),
    }
    handler = handlers.get(cmd)
    if not handler:
        raise HostError("UNKNOWN_COMMAND", f"Command is not allowed: {cmd}")
    return handler(args)


def respond(message_id: str, ok: bool, data: Any = None, code: str | None = None, message: str | None = None) -> None:
    payload: dict[str, Any] = {"id": message_id, "ok": ok}
    if ok:
        payload["data"] = data
    else:
        payload["error"] = {"code": code or "ERROR", "message": message or "Unknown error"}
    with _STDOUT_LOCK:
        print(json.dumps(payload), flush=True)


def _handle_request(line: str) -> None:
    """Process a single JSON-RPC request. Run in a worker thread so multiple
    in-flight commands don't block each other — critical because run_task
    spawns Claude CLI which can take 10-25s per call. With serial dispatch,
    a single Claude task froze every other IPC behind it."""
    message_id = ""
    try:
        request = json.loads(line)
        message_id = str(request.get("id") or "")
        cmd = str(request.get("cmd") or "")
        args = request.get("args") if isinstance(request.get("args"), dict) else {}
        args["_requestId"] = message_id
        respond(message_id, True, dispatch(cmd, args))
    except HostError as error:
        respond(message_id, False, code=error.code, message=error.message)
    except Exception as error:
        respond(message_id, False, code="HOST_ERROR", message=str(error))


def _smoke_import() -> int:
    """Two-phase bundle health check, run inside the freshly-built
    PyInstaller binary in CI (via `aios-host --smoke-import`).

    Phase 1: every package imports — catches "ModuleNotFoundError"
             regressions like v0.2.13's SR-on-Mac crash.
    Phase 2: every package responds to a basic API call — catches
             "imports fine but breaks when actually called" failures
             (the example we burned hours on: SR's flac binary
             stripped for notarization, recognize_google fails at
             runtime even though import speech_recognition passed).

    Each phase 2 probe avoids:
      - hitting external networks
      - requiring a graphics server (CI Mac runners are headless)
      - real input simulation

    Hard-fails on the first error per phase and exits non-zero so the
    workflow log surfaces the exact culprit. Keep the package list in
    sync with python/requirements.txt + hiddenimports in
    build/aios-host.spec."""
    is_mac = sys.platform == "darwin"
    is_win = sys.platform == "win32"
    # (package_name, importable_attribute_or_None)
    # We list only the packages our runtime code actually imports —
    # NOT every transitive dep PyInstaller happens to bundle. mouseinfo
    # / pygetwindow / pytweening / pyperclip / rubicon-objc are bundled
    # because pyautogui depends on them, but our code never calls
    # pyautogui.position() / .alert() / .getActiveWindow() that would
    # reach them. mouseinfo specifically does `import tkinter` at
    # module load, and we exclude tkinter from the bundle (~20MB
    # savings) — so checking mouseinfo would report a false failure
    # for code we never execute.
    packages: list[tuple[str, str | None]] = [
        ("speech_recognition", "Recognizer"),
        ("pyautogui", None),
        ("PIL", "Image"),
        ("PIL.Image", None),
        ("mss", None),
        ("pyscreeze", None),
    ]
    if is_mac:
        packages.extend([
            ("objc", None),
            ("AppKit", None),
            ("Foundation", None),
            ("Quartz", None),
            ("ApplicationServices", None),
            # AVFoundation — used by mac_check_permissions and
            # mac_request_permission for AVCaptureDevice mic auth.
            # Bundle regression here = first-launch permission chain
            # silently skips mic, popup mic never works.
            ("AVFoundation", "AVCaptureDevice"),
        ])
    if is_win:
        packages.extend([
            ("uiautomation", None),
            ("comtypes", None),
        ])
    # Also our own internal modules, so a missing workspace/agents/etc
    # surfaces here instead of when the user opens the app.
    packages.extend([
        ("workspace", None),
        ("agents", None),
        ("tasks_store", None),
        ("tasks_runner", None),
        ("claude_runtime", None),
    ])

    fail = 0
    for name, attr in packages:
        try:
            module = __import__(name, fromlist=[attr] if attr else [])
            if attr is not None and not hasattr(module, attr):
                raise AttributeError(f"{name} has no attribute {attr!r}")
            print(f"OK  import {name}")
        except Exception as exc:
            fail += 1
            print(f"FAIL import {name}: {type(exc).__name__}: {exc}", file=sys.stderr)
    print(f"\nphase 1 (import): {len(packages) - fail}/{len(packages)} ok, {fail} failed")

    # Phase 2 — runtime probes. Each block is wrapped in its own
    # try/except so one failure doesn't hide the next one.
    print("\nphase 2 (runtime probes):")
    rt_fail = 0

    # 2a. SpeechRecognition: AudioData creation + flac binary reachable.
    # SR.recognize_google shells to flac to convert WAV → FLAC before
    # posting to Google. If flac is missing, recognize_google fails at
    # runtime even though import speech_recognition passes phase 1.
    # This check is the canary for the v0.2.13 transcription bug.
    try:
        import shutil
        import speech_recognition as sr
        # Validate the C-level audio data path
        _ = sr.AudioData(b"\x00\x00" * 1600, 16000, 2)
        _ = sr.Recognizer()
        # Locate the flac binary SR will invoke at recognize_google time
        sr_dir = os.path.dirname(sr.__file__)
        if sys.platform == "darwin":
            bundled = os.path.join(sr_dir, "flac-mac")
        elif sys.platform == "win32":
            bundled = os.path.join(sr_dir, "flac-win32.exe")
        else:
            bundled = os.path.join(sr_dir, "flac-linux-x86_64")
        bundled_exists = os.path.exists(bundled)
        system_flac = shutil.which("flac")
        if bundled_exists:
            print(f"OK  speech_recognition runtime (flac bundled at {bundled})")
        elif system_flac:
            print(f"OK  speech_recognition runtime (flac on PATH at {system_flac})")
        else:
            rt_fail += 1
            print(
                f"FAIL speech_recognition runtime: no flac binary "
                f"(checked {bundled} + PATH). recognize_google will fail "
                f"at the moment users press the mic.",
                file=sys.stderr,
            )
    except Exception as exc:
        rt_fail += 1
        print(f"FAIL speech_recognition runtime: {type(exc).__name__}: {exc}", file=sys.stderr)

    # 2b. pyautogui.size() — light call that exercises the platform
    # screen-info backend (ctypes GetSystemMetrics on Win, AppKit
    # NSScreen on Mac). Works on headless macOS runners.
    try:
        import pyautogui
        size = pyautogui.size()
        print(f"OK  pyautogui.size() -> {size.width}x{size.height}")
    except Exception as exc:
        rt_fail += 1
        print(f"FAIL pyautogui.size(): {type(exc).__name__}: {exc}", file=sys.stderr)

    # 2c. PIL: create + encode a tiny PNG. Forces _imaging C extension
    # to load AND its codec path to execute.
    try:
        from io import BytesIO
        from PIL import Image
        img = Image.new("RGB", (16, 16), (200, 100, 50))
        buf = BytesIO()
        img.save(buf, format="PNG")
        print(f"OK  PIL encode PNG ({buf.tell()} bytes)")
    except Exception as exc:
        rt_fail += 1
        print(f"FAIL PIL encode: {type(exc).__name__}: {exc}", file=sys.stderr)

    # 2d. mss: enumerate monitors. May return 0 on headless Mac CI;
    # we treat 0 as a soft warning (works on user machines) but a
    # raised exception as a hard fail (C extension broken).
    try:
        import mss
        with mss.mss() as sct:
            n = len(sct.monitors)
        if n == 0 and sys.platform == "darwin":
            print(f"WARN mss enumeration returned 0 monitors (headless CI, OK)")
        else:
            print(f"OK  mss.mss() -> {n} monitor entries")
    except Exception as exc:
        rt_fail += 1
        print(f"FAIL mss runtime: {type(exc).__name__}: {exc}", file=sys.stderr)

    # 2e. Windows-only: UIA root control.
    if is_win:
        try:
            import uiautomation as auto
            root = auto.GetRootControl()
            if root is None:
                rt_fail += 1
                print("FAIL uiautomation.GetRootControl() returned None", file=sys.stderr)
            else:
                print(f"OK  uiautomation.GetRootControl() -> {root.Name or '<root>'}")
        except Exception as exc:
            rt_fail += 1
            print(f"FAIL uiautomation runtime: {type(exc).__name__}: {exc}", file=sys.stderr)

    # 2f. Mac-only: AppKit + Quartz framework calls. NSScreen works
    # on headless; CGMainDisplayID may return 0 there — info-only.
    if is_mac:
        try:
            import AppKit
            screens = AppKit.NSScreen.screens()
            print(f"OK  AppKit.NSScreen.screens() -> {len(screens)} screen(s)")
        except Exception as exc:
            rt_fail += 1
            print(f"FAIL AppKit runtime: {type(exc).__name__}: {exc}", file=sys.stderr)
        try:
            import Quartz
            disp = Quartz.CGMainDisplayID()
            print(f"INFO Quartz.CGMainDisplayID() -> {disp} (0 expected on headless CI)")
        except Exception as exc:
            # Don't hard-fail; headless Mac may not have a main display
            print(f"INFO Quartz.CGMainDisplayID: {type(exc).__name__}: {exc}")
        # CGEventTap modifier-only voice shortcut listener (v0.2.17+)
        # needs these specific symbols from Quartz. If any is missing
        # in the bundle, the listener silently no-ops at runtime and
        # the user is stuck on the Cmd+Ctrl+V fallback. Hard-fail the
        # CI so we know BEFORE shipping.
        try:
            from Quartz import (
                CGEventTapCreate,
                CGEventTapEnable,
                CGEventGetFlags,
                kCGSessionEventTap,
                kCGHeadInsertEventTap,
                kCGEventTapOptionListenOnly,
                kCGEventFlagsChanged,
                kCGEventKeyDown,
                kCGEventFlagMaskCommand,
                kCGEventFlagMaskControl,
                kCGEventFlagMaskShift,
                kCGEventFlagMaskAlternate,
                CFMachPortCreateRunLoopSource,
                CFRunLoopAddSource,
                CFRunLoopGetCurrent,
                kCFRunLoopCommonModes,
                CFRunLoopRun,
            )
            print("OK  Quartz CGEventTap + CFRunLoop symbols import cleanly")
        except Exception as exc:
            rt_fail += 1
            print(
                f"FAIL Quartz CGEventTap symbols: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )

        # AVFoundation runtime probe — bare import passes even when
        # framework data files were stripped, but
        # AVCaptureDevice.authorizationStatusForMediaType_("soun") only
        # returns a valid status if the framework is fully wired up.
        # On a stripped bundle this raises AttributeError (the bridge
        # never built the method). Catches the v0.2.19 class of bug
        # where pyobjc-framework-AVFoundation wasn't even in
        # requirements.txt — first-launch permission chain silently
        # skipped mic, popup mic never worked.
        try:
            from AVFoundation import AVCaptureDevice  # type: ignore
            status = AVCaptureDevice.authorizationStatusForMediaType_("soun")
            print(f"OK  AVFoundation.AVCaptureDevice auth check -> {status}")
        except Exception as exc:
            rt_fail += 1
            print(
                f"FAIL AVFoundation runtime: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )

    total = len(packages) + 6 + (1 if is_win else 0) + (3 if is_mac else 0)
    print(f"\nphase 2 (runtime): {rt_fail} failure(s)")
    print(f"smoke-import: {total - fail - rt_fail}/{total} ok, {fail + rt_fail} failed")
    return 1 if (fail + rt_fail) else 0


def _start_mac_voice_shortcut_listener() -> None:
    """Detect a clean Cmd+Ctrl tap on macOS (both held + both released
    without any other key pressed in between) and broadcast a
    `voice_shortcut_triggered` event. This is the modifier-only chord
    the user asked for — Electron's `globalShortcut` can't register
    modifier-only accelerators, so we do it natively via CGEventTap.

    Requires the macOS Accessibility permission (which AIOS already
    needs for voice-control clicks / typing). If permission isn't
    granted, `CGEventTapCreate` returns NULL and we exit gracefully —
    the user can still use Cmd+Ctrl+V (registered through Electron's
    globalShortcut) as a fallback that doesn't need accessibility.

    Runs in a daemon thread with its own CFRunLoop so it doesn't
    block the main JSON-RPC stdin loop."""
    if sys.platform != "darwin":
        return

    def listener_thread() -> None:
        try:
            from Quartz import (
                CGEventTapCreate,
                CGEventTapEnable,
                CGEventGetFlags,
                kCGSessionEventTap,
                kCGHeadInsertEventTap,
                kCGEventTapOptionListenOnly,
                kCGEventFlagsChanged,
                kCGEventKeyDown,
                kCGEventFlagMaskCommand,
                kCGEventFlagMaskControl,
                kCGEventFlagMaskShift,
                kCGEventFlagMaskAlternate,
                CFMachPortCreateRunLoopSource,
                CFRunLoopAddSource,
                CFRunLoopGetCurrent,
                kCFRunLoopCommonModes,
                CFRunLoopRun,
            )
        except Exception as exc:
            print(
                f"[voice-shortcut] failed to import Quartz: {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            return

        # State machine across flagsChanged + keyDown events.
        # idle    : no relevant keys held
        # holding : Cmd+Option both held with no Ctrl/Shift and no
        #           non-modifier keypresses observed yet
        # aborted : was holding but a non-modifier key got pressed —
        #           release will NOT fire (so Cmd+Option+C still copies
        #           cleanly without our listener intercepting)
        state = {"name": "idle"}

        def callback(_proxy, type_, event, _refcon):
            try:
                flags = CGEventGetFlags(event)
                cmd = bool(flags & kCGEventFlagMaskCommand)
                ctrl = bool(flags & kCGEventFlagMaskControl)
                shift = bool(flags & kCGEventFlagMaskShift)
                alt = bool(flags & kCGEventFlagMaskAlternate)

                if type_ == kCGEventKeyDown:
                    # Any non-modifier press while holding the chord
                    # aborts so we don't fire on release.
                    if state["name"] == "holding":
                        state["name"] = "aborted"
                elif type_ == kCGEventFlagsChanged:
                    # Cmd+Option only — no Ctrl or Shift mixed in.
                    pure_chord = cmd and alt and not ctrl and not shift
                    if pure_chord and state["name"] == "idle":
                        state["name"] = "holding"
                    elif not (cmd and alt):
                        # One or both modifiers released.
                        if state["name"] == "holding":
                            try:
                                broadcast_event("voice_shortcut_triggered", {})
                            except Exception as bexc:
                                print(
                                    f"[voice-shortcut] broadcast failed: {bexc}",
                                    file=sys.stderr,
                                    flush=True,
                                )
                        state["name"] = "idle"
            except Exception as exc:
                print(
                    f"[voice-shortcut] callback err: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
            return event

        # listen-only tap: we don't consume events, so the user's
        # Cmd+Ctrl+other-letter combos still reach their target app.
        mask = (1 << kCGEventFlagsChanged) | (1 << kCGEventKeyDown)
        tap = CGEventTapCreate(
            kCGSessionEventTap,
            kCGHeadInsertEventTap,
            kCGEventTapOptionListenOnly,
            mask,
            callback,
            None,
        )
        if not tap:
            print(
                "[voice-shortcut] CGEventTapCreate returned NULL — "
                "Accessibility permission likely not granted to AIOS. "
                "Cmd+Ctrl+V (fallback) still works.",
                file=sys.stderr,
                flush=True,
            )
            return

        source = CFMachPortCreateRunLoopSource(None, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes)
        CGEventTapEnable(tap, True)
        try:
            CFRunLoopRun()
        except Exception as exc:
            print(
                f"[voice-shortcut] run loop err: {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )

    threading.Thread(target=listener_thread, daemon=True).start()


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "--smoke-import":
        sys.exit(_smoke_import())
    # Initialize the database early so startup failures are visible.
    get_workspace_info()
    # Start the background task runner after stdout locking/event helpers exist.
    try:
        import tasks_runner
        tasks_runner.start_runner(broadcast_event)
    except Exception as runner_err:
        print(f"[host] tasks_runner failed to start: {runner_err}", file=sys.stderr, flush=True)
    # Mac-only: register the Cmd+Ctrl tap listener so users can open
    # the mic from any app without a letter key. Silently no-ops on
    # Windows.
    _start_mac_voice_shortcut_listener()
    for line in sys.stdin:
        threading.Thread(target=_handle_request, args=(line,), daemon=True).start()


if __name__ == "__main__":
    main()
