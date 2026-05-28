"""Local task store — CRUD for the tasks Kanban.

Storage: rows in the local SQLite at workspace/data/settings.db (table `tasks`).
Tasks are NEVER sent anywhere. They are work items the user has created for
their agents to execute locally via the runner (Phase 2).

This module is intentionally dumb: it only persists and queries. The runner
(`tasks_runner.py`, Phase 2) is responsible for actually spawning Claude.
"""

from __future__ import annotations

import json
from contextlib import closing
from typing import Any
from uuid import uuid4

import workspace


VALID_STATUSES = {
    "pending",             # waiting for the runner to pick it up
    "in_progress",         # runner has spawned Claude; work is ongoing
    "awaiting_children",   # CEO delegated; waiting on child tasks before synthesis
    "completed",           # finished successfully
    "failed",              # Claude errored out / unrecoverable
    "blocked",             # agent emitted [BLOCKED: ...]; needs user input
    "awaiting_connection", # agent emitted [NEEDS_CONNECTOR: ...]
    "awaiting_approval",   # reserved for explicit approval flows
    "cancelled",           # user cancelled
}

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}

# Columns we always select. Defined once so list/get/claim queries stay in sync.
_TASK_COLUMNS = (
    "id, name, message, agent_id, priority, status, result_json, "
    "narrative_json, claude_session_id, blocked_reason, needs_connector, "
    "created_at, updated_at, started_at, completed_at, "
    "parent_task_id, synthesis_pass, synthesis_round"
)


def _row_to_dict(row: Any) -> dict[str, Any]:
    narrative: list[Any] = []
    if row["narrative_json"]:
        try:
            parsed = json.loads(row["narrative_json"])
            if isinstance(parsed, list):
                narrative = parsed
        except json.JSONDecodeError:
            narrative = []
    return {
        "id": row["id"],
        "name": row["name"],
        "message": row["message"],
        "agent_id": row["agent_id"],
        "priority": row["priority"],
        "status": row["status"],
        "result": row["result_json"],
        "narrative": narrative,
        "claude_session_id": row["claude_session_id"],
        "blocked_reason": row["blocked_reason"],
        "needs_connector": row["needs_connector"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "started_at": row["started_at"],
        "completed_at": row["completed_at"],
        "parent_task_id": row["parent_task_id"],
        "synthesis_pass": bool(row["synthesis_pass"]) if row["synthesis_pass"] is not None else False,
        "synthesis_round": int(row["synthesis_round"]) if row["synthesis_round"] is not None else 0,
    }


def create_task(
    name: str,
    message: str,
    agent_id: str,
    priority: int = 3,
    parent_task_id: str | None = None,
) -> dict[str, Any]:
    """Insert a new pending task. Workers pick the highest-priority pending row.

    `parent_task_id` links a delegated task to the CEO task that spawned it,
    so when all children of a parent are terminal the runner can re-spawn the
    parent in 'synthesis' mode."""
    if not message.strip():
        raise ValueError("message is required")
    safe_priority = max(1, min(5, int(priority)))
    task_id = uuid4().hex
    now = workspace.utc_now()
    display_name = name.strip() or message.strip()[:60]
    with closing(workspace.connect()) as conn:
        conn.execute(
            "INSERT INTO tasks "
            "(id, name, message, agent_id, priority, status, result_json, "
            " narrative_json, claude_session_id, blocked_reason, needs_connector, "
            " created_at, updated_at, started_at, completed_at, "
            " parent_task_id, synthesis_pass, synthesis_round) "
            "VALUES (?, ?, ?, ?, ?, 'pending', NULL, '[]', NULL, NULL, NULL, ?, ?, NULL, NULL, ?, 0, 0)",
            (
                task_id,
                display_name,
                message.strip(),
                agent_id,
                safe_priority,
                now,
                now,
                parent_task_id,
            ),
        )
        conn.commit()
    fetched = get_task(task_id)
    if not fetched:
        raise ValueError("Task vanished mid-insert")
    return fetched


def list_tasks(
    status_filter: str | None = None,
    agent_id: str | None = None,
    limit: int = 500,
) -> dict[str, Any]:
    sql = (
        f"SELECT {_TASK_COLUMNS} FROM tasks WHERE 1=1"
    )
    params: list[Any] = []
    if status_filter:
        sql += " AND status = ?"
        params.append(status_filter)
    if agent_id:
        sql += " AND agent_id = ?"
        params.append(agent_id)
    sql += " ORDER BY datetime(created_at) DESC LIMIT ?"
    params.append(max(1, min(limit, 2000)))
    with closing(workspace.connect()) as conn:
        rows = conn.execute(sql, params).fetchall()
    return {"tasks": [_row_to_dict(r) for r in rows]}


def get_task(task_id: str) -> dict[str, Any] | None:
    with closing(workspace.connect()) as conn:
        row = conn.execute(
            f"SELECT {_TASK_COLUMNS} FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
    return None if row is None else _row_to_dict(row)


def list_child_tasks(parent_id: str) -> list[dict[str, Any]]:
    with closing(workspace.connect()) as conn:
        rows = conn.execute(
            f"SELECT {_TASK_COLUMNS} FROM tasks WHERE parent_task_id = ? "
            "ORDER BY datetime(created_at) ASC",
            (parent_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def set_synthesis_pass(task_id: str, flag: bool) -> None:
    """Toggle the synthesis_pass flag. Set True when re-queueing a parent
    for its synthesis run; cleared back to False when the runner claims it."""
    now = workspace.utc_now()
    with closing(workspace.connect()) as conn:
        conn.execute(
            "UPDATE tasks SET synthesis_pass = ?, updated_at = ? WHERE id = ?",
            (1 if flag else 0, now, task_id),
        )
        conn.commit()


def update_task_status(
    task_id: str,
    status: str,
    blocked_reason: str | None = None,
    needs_connector: str | None = None,
    result: str | None = None,
    claude_session_id: str | None = None,
) -> dict[str, Any]:
    if status not in VALID_STATUSES:
        raise ValueError(f"Invalid status: {status}")
    now = workspace.utc_now()
    fields = ["status = ?", "updated_at = ?"]
    params: list[Any] = [status, now]
    if status == "in_progress":
        fields.append("started_at = COALESCE(started_at, ?)")
        params.append(now)
    if status in ("completed", "failed", "cancelled"):
        fields.append("completed_at = ?")
        params.append(now)
    if blocked_reason is not None:
        fields.append("blocked_reason = ?")
        params.append(blocked_reason or None)
    if needs_connector is not None:
        fields.append("needs_connector = ?")
        params.append(needs_connector or None)
    if result is not None:
        fields.append("result_json = ?")
        params.append(result)
    if claude_session_id is not None:
        fields.append("claude_session_id = ?")
        params.append(claude_session_id)
    sql = f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?"
    params.append(task_id)
    with closing(workspace.connect()) as conn:
        conn.execute(sql, params)
        conn.commit()
    fetched = get_task(task_id)
    if not fetched:
        raise ValueError(f"Task disappeared mid-update: {task_id}")
    return fetched


def append_narrative_event(task_id: str, event: dict[str, Any]) -> None:
    """Append a JSON event to the task's narrative array. Used by the
    Phase 2 runner to stream agent activity into the UI."""
    now = workspace.utc_now()
    with closing(workspace.connect()) as conn:
        row = conn.execute(
            "SELECT narrative_json FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if not row:
            return
        try:
            current = json.loads(row["narrative_json"] or "[]")
            if not isinstance(current, list):
                current = []
        except json.JSONDecodeError:
            current = []
        current.append({**event, "ts": event.get("ts") or now})
        conn.execute(
            "UPDATE tasks SET narrative_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(current), now, task_id),
        )
        conn.commit()


def task_action(
    task_id: str,
    action: str,
    note: str | None = None,
) -> dict[str, Any]:
    """Operator action against a task. Returns the updated task."""
    task = get_task(task_id)
    if not task:
        raise ValueError(f"Unknown task: {task_id}")
    note = (note or "").strip()
    action = action.lower().strip()
    # All operator actions store the action marker in text so the runner
    # can tell approvals apart from retries when re-spawning. Format is
    # always "(<action>)" or "(<action>) <note>" — never just the note.
    if action == "retry":
        # Re-queue: clear blocked/connector reasons and bring back to pending.
        append_narrative_event(
            task_id,
            {"kind": "operator", "role": "user", "text": f"(retry) {note}".strip() if note else "(retry)", "agentId": "operator"},
        )
        return update_task_status(task_id, "pending", blocked_reason="", needs_connector="")
    if action == "approve":
        append_narrative_event(
            task_id,
            {"kind": "operator", "role": "user", "text": f"(approved) {note}".strip() if note else "(approved)", "agentId": "operator"},
        )
        return update_task_status(task_id, "pending", blocked_reason="")
    if action == "reject":
        append_narrative_event(
            task_id,
            {"kind": "operator", "role": "user", "text": f"(rejected) {note}".strip() if note else "(rejected)", "agentId": "operator"},
        )
        return update_task_status(task_id, "cancelled", blocked_reason="")
    if action == "cancel":
        return cancel_task(task_id)
    raise ValueError(f"Unknown action: {action}")


def cancel_task(task_id: str) -> dict[str, Any]:
    """Mark cancelled. The Phase 2 runner will see this on its next tick and
    kill the spawned Claude subprocess if one is still running."""
    return update_task_status(task_id, "cancelled")


def delete_task(task_id: str) -> dict[str, Any]:
    with closing(workspace.connect()) as conn:
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
    return {"ok": True, "id": task_id}


def reset_orphan_tasks() -> int:
    """Boot-time recovery: tasks left at 'in_progress' with no activity for
    more than 60 seconds are presumed orphaned (their Claude subprocess
    died with the previous sidecar). Mark them failed/retryable instead of
    auto-requeueing into another in-progress loop.

    Recently-active tasks (started within 60s) are left alone — if the
    sidecar restarts mid-task, we trust the running Claude to either finish
    or its output to update the row. Without this grace window, an unstable
    sidecar that bounces every 2s would yank legitimately-running tasks
    back to pending → infinite restart loop.

    Returns the number of tasks recovered."""
    from datetime import datetime, timedelta, timezone
    now_dt = datetime.now(timezone.utc)
    cutoff = (now_dt - timedelta(seconds=60)).isoformat()
    now_iso = workspace.utc_now()
    recovery_result = (
        "This task was interrupted because the local task runner restarted. "
        "Open the task and click retry to run it again."
    )
    with closing(workspace.connect()) as conn:
        result = conn.execute(
            "UPDATE tasks SET status = 'failed', updated_at = ?, completed_at = ?, result_json = ? "
            "WHERE status = 'in_progress' AND (started_at IS NULL OR started_at < ?)",
            (now_iso, now_iso, recovery_result, cutoff),
        )
        conn.commit()
        return result.rowcount or 0


def claim_next_pending_task() -> dict[str, Any] | None:
    """Atomically claim the highest-priority pending task. Returns the claimed
    task dict, or None if the queue is empty / another worker beat us.

    Two-statement SELECT + UPDATE races: with N workers polling the same DB,
    each could SELECT the same id before any of them UPDATEs. The losers'
    UPDATE matches 0 rows (because WHERE status='pending'), but the caller
    sees the row and runs the task anyway — leading to duplicate runs.

    Fix: ONE UPDATE statement that picks + flips atomically. We then check
    rowcount: if 0, somebody else got it. If 1, get_task() returns our row."""
    now = workspace.utc_now()
    with closing(workspace.connect()) as conn:
        cur = conn.execute(
            "UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ? "
            "WHERE id = ("
            "  SELECT id FROM tasks WHERE status = 'pending' "
            "  ORDER BY priority DESC, datetime(created_at) ASC LIMIT 1"
            ") AND status = 'pending'",
            (now, now),
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
        # Find the row we just flipped — it has the started_at we wrote, and
        # nothing else can have that exact timestamp because utc_now() is
        # millisecond-resolution and this is the only writer using it just now.
        row = conn.execute(
            "SELECT id FROM tasks WHERE status = 'in_progress' AND started_at = ? "
            "ORDER BY datetime(created_at) ASC LIMIT 1",
            (now,),
        ).fetchone()
    return get_task(row["id"]) if row else None


def maybe_trigger_parent_synthesis(child_task_id: str) -> bool:
    """Called by the runner whenever a child task hits a terminal state.

    If the child has a parent in `awaiting_children` state AND all siblings
    are also terminal, flip the parent back to `pending` with synthesis_pass=1
    so a worker picks it up and re-runs the parent's agent in synthesis mode.

    Returns True if a parent was triggered."""
    child = get_task(child_task_id)
    if not child or not child.get("parent_task_id"):
        return False
    parent_id = child["parent_task_id"]
    parent = get_task(parent_id)
    if not parent or parent["status"] != "awaiting_children":
        return False
    siblings = list_child_tasks(parent_id)
    if any(s["status"] not in TERMINAL_STATUSES for s in siblings):
        return False
    # All children terminal. Re-queue the parent for its synthesis pass.
    # synthesis_round bumps every time we re-queue (so round 1, 2, 3, ...
    # as the parent iterates with new sub-task spawns in synthesis).
    now = workspace.utc_now()
    with closing(workspace.connect()) as conn:
        cur = conn.execute(
            "UPDATE tasks SET status = 'pending', synthesis_pass = 1, "
            "synthesis_round = synthesis_round + 1, "
            "started_at = NULL, updated_at = ? "
            "WHERE id = ? AND status = 'awaiting_children'",
            (now, parent_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            # Race: somebody else flipped it already. Harmless.
            return False
    return True


def list_descendant_tasks(parent_id: str) -> list[dict[str, Any]]:
    """Recursively gather all descendants of a parent task (children +
    grandchildren + ...). Used by recursive cancel + cost summation +
    depth checks. Iterative BFS to avoid Python recursion limits on
    pathological chains. Hard ceiling at 200 nodes to prevent runaway."""
    seen: set[str] = set()
    descendants: list[dict[str, Any]] = []
    queue: list[str] = [parent_id]
    while queue and len(seen) < 200:
        cur_id = queue.pop(0)
        if cur_id in seen:
            continue
        seen.add(cur_id)
        children = list_child_tasks(cur_id)
        for child in children:
            descendants.append(child)
            queue.append(child["id"])
    return descendants


def get_task_depth(task_id: str) -> int:
    """Compute the delegation depth of a task: 0 = top-level, 1 = child of
    a top-level task, 2 = grandchild, etc. Walks up the parent_task_id
    chain. Hard ceiling at 10 hops to avoid infinite loops from bad data."""
    depth = 0
    cur_id = task_id
    for _ in range(10):
        task = get_task(cur_id)
        if not task or not task.get("parent_task_id"):
            return depth
        depth += 1
        cur_id = task["parent_task_id"]
    return depth


def cancel_task_recursive(task_id: str) -> dict[str, Any]:
    """Cancel a task AND all its in-flight descendants. Used when the user
    cancels a parent of a multi-agent fan-out — we don't want orphan child
    Claude processes left running. Only cancels children that aren't already
    terminal (completed/failed/cancelled stay where they are)."""
    descendants = list_descendant_tasks(task_id)
    for child in descendants:
        if child["status"] not in TERMINAL_STATUSES:
            try:
                update_task_status(child["id"], "cancelled", blocked_reason="parent cancelled")
            except Exception:
                pass
    return cancel_task(task_id)


def delete_task(task_id: str) -> bool:
    """Delete a task by ID. Returns True if a row was deleted."""
    with closing(workspace.connect()) as conn:
        cur = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
        return cur.rowcount > 0
