from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


# Module registry.
#
# `requiredConnectors` is the set of Connectors-page service slugs that the
# module MUST have configured before install. Claude's /install command reads
# this and refuses to proceed if any are missing, telling the user to open the
# Connectors page first. This eliminates the duplicate-auth experience —
# modules never ask the user to paste API keys for services we already
# manage via Composio.
#
# Modules with empty `requiredConnectors` either don't need external services
# (ContextOS, ProductivityOS) or use services we don't have a connector for
# (Daily Brief: Gemini + Telegram — neither is in Composio's catalog).
MODULE_REGISTRY: dict[str, dict[str, Any]] = {
    "context-os": {
        "name": "ContextOS",
        "phase": 1,
        "capability": "Builds the business brain Claude uses in every session.",
        "requires": [],
        "requiredConnectors": [],
        "artifacts": ["context/"],
        "connections": [],
        # ContextOS is built into the app — the Context page IS the install flow.
        # Always treated as installed so dependents (DataOS, IntelOS, etc.) aren't blocked.
        "installedMarkers": [],
        "alwaysInstalled": True,
        "builtIn": True,
        "builtInRoute": "context",
        "builtInButtonLabel": "Open Context",
    },
    "infra-os": {
        "name": "InfraOS",
        "phase": 3,
        "capability": "Adds Git, GitHub backup, the /commit command, and a docs system.",
        "requires": [],
        "requiredConnectors": ["github"],
        "artifacts": [".git/", ".claude/commands/commit.md", "HISTORY.md"],
        "connections": ["GitHub"],
        # /commit ships pre-installed with the workspace from v0.2.25; it's no
        # longer used as an install marker — InfraOS is "installed" only once
        # git is initialized and HISTORY.md exists.
        "installedMarkers": [
            ".git",
            "HISTORY.md",
        ],
    },
    "data-os": {
        "name": "DataOS",
        "phase": 4,
        "capability": "Pulls numbers from external sources and turns them into usable metrics.",
        "requires": ["context-os"],
        # All four DataOS connectors are Composio-managed. Bitly is an optional
        # add-on (no connector) — see INSTALL.md.
        "requiredConnectors": ["stripe", "youtube", "google-analytics", "google-sheets"],
        "artifacts": ["data/", "context/current-data.md"],
        "connections": ["Stripe", "Analytics", "Sheets"],
        "installedMarkers": [
            "scripts/collect.py",
            "scripts/data/collect.py",
            "scripts/data/db.py",
            "data/business.db",
            "data/data.db",
        ],
    },
    "intel-os": {
        "name": "IntelOS",
        "phase": 5,
        "capability": "Captures signals from meetings and team communication.",
        "requires": ["context-os"],
        # Slack is the only required connector; Fireflies/Fathom meeting
        # recorders are optional API-key integrations (no connector).
        "requiredConnectors": ["slack"],
        "artifacts": ["data/", "scripts/"],
        "connections": ["Fireflies / Fathom", "Slack"],
        "installedMarkers": [
            "scripts/collect_all.py",
            "scripts/intel/collect_all.py",
            "scripts/intel/db.py",
            "data/intel.db",
        ],
    },
    "productivity-os": {
        "name": "ProductivityOS",
        "phase": 6,
        "capability": "Adds a GTD system: inbox, projects, next actions, weekly review.",
        "requires": ["context-os"],
        "requiredConnectors": [],
        "artifacts": ["gtd/", ".claude/commands/process.md"],
        "connections": [],
        "installedMarkers": [
            "gtd/dashboard.md",
            "gtd/inbox.md",
            "scripts/refresh_dashboard.py",
            ".claude/commands/process.md",
        ],
    },
    "daily-brief": {
        "name": "Daily Brief",
        "phase": 2,
        "capability": "A friendly morning briefing — what's on your plate today, automatically.",
        "requires": [],
        "requiredConnectors": [],
        "artifacts": ["outputs/daily-brief/"],
        "connections": [],
        # Daily Brief is built into the app — it auto-pops every morning and lives on the Brief page.
        "installedMarkers": [],
        "alwaysInstalled": True,
        "builtIn": True,
        "builtInRoute": "briefs",
        "builtInButtonLabel": "Open Brief",
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


MOJIBAKE_MARKERS = ("Ã", "Â", "â€", "â€œ", "â€˜", "â‚¬", "Гў")
MOJIBAKE_REPLACEMENTS = {
    "\u00c3\u00a2\u00e2\u201a\u00ac\u2014": "—",
    "\u00c3\u00a2\u00e2\u201a\u00ac\u00e2\u20ac": "—",
    "\u00c3\u00a2\u00e2\u201a\u00ac": "—",
    "\u00c3\u00a2\u201a\u00ac\u2014": "—",
    "\u00c3\u00a2\u201a\u00ac\u00e2\u20ac": "—",
    "\u00c3\u00a2\u201a\u00ac": "—",
    "Гўв‚¬вЂќ": "—",
    "Гўв‚¬—": "—",
    "Гўв‚¬вЂњ": "–",
    "Гўв‚¬в„ў": "’",
    "Гўв‚¬Е“": "“",
    "Гўв‚¬Вќ": "”",
    "Гўв‚¬В¦": "…",
    "â€”": "—",
    "â€“": "–",
    "â€˜": "‘",
    "â€™": "’",
    "â€œ": "“",
    "â€": "”",
    "â€¦": "…",
    "Â ": " ",
    "Â": "",
}


def mojibake_score(value: str) -> int:
    return sum(value.count(marker) for marker in MOJIBAKE_MARKERS)


def repair_text_encoding(value: str) -> str:
    repaired = value
    for _ in range(4):
        changed = False
        for bad in ("\u00e2\u20ac\udc9d", "\u00e2\u20ac\ufffd"):
            if bad in repaired:
                repaired = repaired.replace(bad, "—")
                changed = True
        cleaned = "".join(ch for ch in repaired if not 0xD800 <= ord(ch) <= 0xDFFF)
        if cleaned != repaired:
            repaired = cleaned
            changed = True
        for encoding in ("cp1252", "latin1"):
            try:
                candidate = repaired.encode(encoding).decode("utf-8")
            except UnicodeError:
                continue
            if mojibake_score(candidate) <= mojibake_score(repaired):
                repaired = candidate
                changed = True
        for bad, good in MOJIBAKE_REPLACEMENTS.items():
            if bad in repaired:
                repaired = repaired.replace(bad, good)
                changed = True
        if not changed:
            break
    return repaired


def repair_json_text(value: Any) -> Any:
    if isinstance(value, str):
        return repair_text_encoding(value)
    if isinstance(value, list):
        return [repair_json_text(item) for item in value]
    if isinstance(value, dict):
        return {key: repair_json_text(item) for key, item in value.items()}
    return value


def workspace_root() -> Path:
    root = os.environ.get("AIOS_WORKSPACE_ROOT")
    if root:
        return Path(root).expanduser().resolve()
    return Path.cwd().resolve()


def safe_path(relative_path: str) -> Path:
    root = workspace_root()
    target = (root / relative_path).resolve()
    if root != target and root not in target.parents:
        raise ValueError("Path escapes workspace")
    return target


def db_path() -> Path:
    return workspace_root() / "data" / "settings.db"


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS onboarding (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            current_step INTEGER DEFAULT 0,
            answers TEXT DEFAULT '{}',
            completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS modules (
            id TEXT PRIMARY KEY,
            name TEXT,
            version TEXT,
            installed_at TEXT,
            enabled INTEGER DEFAULT 1,
            config TEXT DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            messages TEXT DEFAULT '[]',
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS auto_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            schedule TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            last_run TEXT,
            next_run TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS auto_task_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            status TEXT NOT NULL,
            output_path TEXT,
            cost_usd REAL,
            error TEXT,
            FOREIGN KEY (task_id) REFERENCES auto_tasks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_auto_task_runs_task ON auto_task_runs(task_id, started_at);

        CREATE TABLE IF NOT EXISTS daily_briefs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            brief_date TEXT NOT NULL UNIQUE,
            generated_at TEXT NOT NULL,
            headline TEXT,
            content TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            default_prompt TEXT NOT NULL,
            custom_prompt TEXT,
            parent_id TEXT,
            is_builtin INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            message TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 3,
            status TEXT NOT NULL DEFAULT 'pending',
            result_json TEXT,
            narrative_json TEXT DEFAULT '[]',
            claude_session_id TEXT,
            blocked_reason TEXT,
            needs_connector TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            parent_task_id TEXT,
            synthesis_pass INTEGER NOT NULL DEFAULT 0,
            synthesis_round INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status_priority
            ON tasks(status, priority DESC, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_agent
            ON tasks(agent_id, status);

        CREATE TABLE IF NOT EXISTS import_markers (
            folder_name TEXT PRIMARY KEY,
            marked_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS linked_folders (
            absolute_path TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            added_at      TEXT NOT NULL
        );
        """
    )
    conn.execute("INSERT OR IGNORE INTO onboarding (id, current_step, answers) VALUES (1, 0, '{}')")
    # Lightweight migration: add claude_session_id to sessions if missing.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
    if "claude_session_id" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT")
    if "permission_mode" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN permission_mode TEXT")
    if "goal_state" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN goal_state TEXT")
    # Migrations for the tasks table (added v0.1.16 → extended for CEO synthesis)
    task_cols = {row[1] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    if task_cols and "parent_task_id" not in task_cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT")
    if task_cols and "synthesis_pass" not in task_cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN synthesis_pass INTEGER DEFAULT 0")
    if task_cols and "synthesis_round" not in task_cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN synthesis_round INTEGER NOT NULL DEFAULT 0")
        # Backfill: existing legacy "in synthesis" rows (synthesis_pass=1) move
        # to round 1 so they don't suddenly look like round 0 on the UI.
        conn.execute("UPDATE tasks SET synthesis_round = synthesis_pass WHERE synthesis_round = 0 AND synthesis_pass > 0")
    conn.commit()


def get_setting(key: str) -> str | None:
    with closing(connect()) as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return None if row is None else row["value"]


def set_setting(key: str, value: str) -> dict[str, Any]:
    with closing(connect()) as conn:
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, value, utc_now()),
        )
        conn.commit()
    return {"key": key, "value": value}


def get_workspace_info() -> dict[str, Any]:
    root = workspace_root()
    return {
        "workspaceRoot": str(root),
        "hasClaudeMd": (root / "CLAUDE.md").exists(),
        "platform": sys.platform,
        "settingsDb": str(db_path()),
        "modules": list_modules(),
        "deviceUserId": get_or_create_device_user_id(),
        # Cached Claude info from prior session — lets the renderer skip a
        # subprocess-spawning find_claude call on cold start. Background
        # verification still runs after splash dismisses.
        "claudePath": get_setting("claude_path"),
        "claudeVersion": get_setting("claude_version"),
    }


def get_onboarding_state() -> dict[str, Any]:
    with closing(connect()) as conn:
        row = conn.execute("SELECT current_step, answers, completed_at FROM onboarding WHERE id = 1").fetchone()
    answers = json.loads(row["answers"] or "{}")
    return {"currentStep": row["current_step"], "answers": answers, "completedAt": row["completed_at"]}


def save_onboarding_answer(question_id: str, value: str, step: int | None = None) -> dict[str, Any]:
    state = get_onboarding_state()
    answers = state["answers"]
    answers[question_id] = value
    current_step = int(step if step is not None else state["currentStep"])
    with closing(connect()) as conn:
        conn.execute(
            "UPDATE onboarding SET current_step = ?, answers = ? WHERE id = 1",
            (current_step, json.dumps(answers)),
        )
        conn.commit()
    return get_onboarding_state()


def reset_onboarding() -> dict[str, Any]:
    """Clear the onboarding row so the welcome flow runs again. We keep
    the user's saved answers so they don't have to retype, but null the
    completed_at and rewind current_step so `setupRequired` flips back
    on in the renderer."""
    with closing(connect()) as conn:
        conn.execute(
            "UPDATE onboarding SET current_step = 0, completed_at = NULL WHERE id = 1"
        )
        conn.commit()
    return get_onboarding_state()


def reset_workspace() -> dict[str, Any]:
    """Wipe ALL user data: context files, plans, outputs, shares, gtd, imports,
    module-installs (it'll be re-copied from the starter kit on next launch),
    and the SQLite tables that hold sessions / onboarding / modules / auto-tasks
    / daily briefs.

    Preserves: settings (claude_path, theme, anthropic_api_key, connector
    labels) so the user doesn't have to reconnect Claude. Preserves
    device_user_id so already-connected services stay bound at the relay.

    Removes the CLAUDE.md marker so `ensureRuntimeWorkspace` re-copies the
    full starter kit on the next app start (renderer triggers via
    window.location.reload after this returns).
    """
    root = workspace_root()
    user_dirs = ["context", "outputs", "plans", "shares", "gtd", "imports", "module-installs"]
    for d in user_dirs:
        target = root / d
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)

    with closing(connect()) as conn:
        for table in ("sessions", "onboarding", "modules", "auto_tasks", "auto_task_runs", "daily_briefs"):
            try:
                conn.execute(f"DELETE FROM {table}")
            except sqlite3.OperationalError:
                pass  # table may not exist yet on a brand-new workspace
        conn.execute("INSERT OR IGNORE INTO onboarding (id, current_step, answers) VALUES (1, 0, '{}')")
        conn.execute(
            "DELETE FROM app_state WHERE key IN ('first_install_date', 'last_brief_seen_date')"
        )
        conn.commit()

    marker = root / "CLAUDE.md"
    if marker.exists():
        try:
            marker.unlink()
        except OSError:
            pass

    return {"reset": True, "root": str(root)}


def complete_onboarding(answers: dict[str, Any] | None = None) -> dict[str, Any]:
    state = get_onboarding_state()
    merged_answers = state["answers"]
    if answers:
        merged_answers.update(answers)
    write_context_files(merged_answers)
    completed_at = utc_now()
    with closing(connect()) as conn:
        conn.execute(
            "UPDATE onboarding SET current_step = ?, answers = ?, completed_at = ? WHERE id = 1",
            (999, json.dumps(merged_answers), completed_at),
        )
        conn.commit()
    return {"completedAt": completed_at, "context": get_context_summary()}


def complete_onboarding_freeform(text: str, seed_folder_path: str = "", seed_folder_name: str = "") -> dict[str, Any]:
    """v0.2.63 — replaces the 8-question form with a single paragraph.
    v0.2.64 — optionally accepts a seed folder during onboarding.
    v0.2.65 — `text` is now just a display name (Claude.ai-style: take a
    name, drop to chat, conversation does the rest). The form param keeps
    its name for IPC compat but stores `user_display_name` setting + a
    tiny "Call them X" note in intro.md. Long-paragraph freeform support
    is preserved (handled identically — written to intro.md verbatim)."""
    text = (text or "").strip()
    folder_path = (seed_folder_path or "").strip()
    folder_name = (seed_folder_name or "").strip()

    # Treat a short single-line input as a display name; multi-line or long
    # text is freeform. Heuristic: <= 60 chars + no newlines.
    is_display_name = bool(text) and "\n" not in text and len(text) <= 60

    if text or folder_path:
        context_dir = workspace_root() / "context"
        context_dir.mkdir(parents=True, exist_ok=True)
        intro_lines = [
            "# Intro",
            "",
            f"Captured during onboarding · {utc_now()}",
            "",
        ]
        if is_display_name:
            intro_lines.extend([
                f"Call them **{text}**.",
                "",
                "_The user hasn't shared more yet — Claude should naturally invite_",
                "_them to share what they're working on as the conversation unfolds._",
                "",
            ])
        elif text:
            intro_lines.extend([
                "> Freeform self-introduction. Claude reads this on /prime and uses",
                "> it to ground every session. Edit anytime from Context → intro.md.",
                "",
                text,
                "",
            ])
        if folder_path:
            intro_lines.extend([
                "## Seed folder",
                "",
                f"The user attached `{folder_name or folder_path}` during onboarding.",
                f"Path: `{folder_path}`",
                "",
                "Use Glob/Read to skim its contents on the next /prime so you have",
                "concrete grounding (project shape, recent changes, business context).",
                "Don't read every file — sample broadly first.",
                "",
            ])
        (context_dir / "intro.md").write_text("\n".join(intro_lines), encoding="utf-8")

    if is_display_name:
        set_setting("user_display_name", text)
    if folder_path:
        set_setting("onboarding_seed_folder", folder_path)

    answers_update: dict[str, Any] = {}
    if is_display_name:
        answers_update["display_name"] = text
    elif text:
        answers_update["freeform_intro"] = text
    if folder_path:
        answers_update["seed_folder"] = folder_path
    return complete_onboarding(answers_update or None)


def write_context_files(answers: dict[str, Any]) -> None:
    context_dir = workspace_root() / "context"
    context_dir.mkdir(parents=True, exist_ok=True)
    groups = {
        "personal-info.md": ["role", "team", "six_month_goal", "ideal_week", "ai_experience", "work_preference"],
        "business-info.md": ["offer", "revenue_model", "acquisition", "differentiation", "revenue_range", "daily_tools"],
        "strategy.md": ["north_star_metric", "hidden_blocker", "ninety_day_success", "active_decisions", "ideal_customer", "growth_fear"],
        "current-data.md": ["payments", "lead_tracking", "meetings", "team_chat", "crm", "content_platform", "extra_context"],
    }
    headings = {
        "personal-info.md": "Personal Context",
        "business-info.md": "Business Context",
        "strategy.md": "Strategy And Priorities",
        "current-data.md": "Current Data Sources",
    }
    labels = QUESTION_LABELS
    for filename, keys in groups.items():
        lines = [f"# {headings[filename]}", "", f"Updated: {utc_now()}", ""]
        for key in keys:
            value = str(answers.get(key, "")).strip() or "Not answered yet."
            lines.extend([f"## {labels.get(key, key)}", "", value, ""])
        (context_dir / filename).write_text("\n".join(lines), encoding="utf-8")

    funnel = [
        "# Funnel",
        "",
        f"Updated: {utc_now()}",
        "",
        f"- Offer: {answers.get('offer', 'Not answered yet.')}",
        f"- Customer: {answers.get('ideal_customer', 'Not answered yet.')}",
        f"- Acquisition: {answers.get('acquisition', 'Not answered yet.')}",
        f"- Revenue model: {answers.get('revenue_model', 'Not answered yet.')}",
        f"- North-star metric: {answers.get('north_star_metric', 'Not answered yet.')}",
    ]
    (context_dir / "funnel.md").write_text("\n".join(funnel), encoding="utf-8")


def read_file(path: str) -> dict[str, Any]:
    target = safe_path(path)
    return {"path": path, "content": target.read_text(encoding="utf-8") if target.exists() else ""}


def write_file(path: str, content: str) -> dict[str, Any]:
    target = safe_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {"path": path, "bytes": len(content.encode("utf-8"))}


def append_file(path: str, content: str) -> dict[str, Any]:
    target = safe_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    existing = target.read_text(encoding="utf-8") if target.exists() else ""
    separator = "\n\n" if existing.strip() and content.strip() else ""
    target.write_text(f"{existing}{separator}{content}", encoding="utf-8")
    return {"path": path, "bytes": len(content.encode("utf-8"))}


def move_file(from_path: str, to_path: str) -> dict[str, Any]:
    source = safe_path(from_path)
    target = safe_path(to_path)
    if not source.exists():
        raise ValueError(f"Source file does not exist: {from_path}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    return {"fromPath": from_path, "toPath": to_path}


def file_kind(relative_path: str) -> str:
    normalized = relative_path.replace("\\", "/")
    if normalized.startswith("context/import/"):
        return "import"
    if normalized.startswith("context/"):
        return "context"
    if normalized.startswith("outputs/"):
        return "output"
    if normalized.startswith("plans/"):
        return "plan"
    if normalized.startswith("shares/"):
        return "share"
    if normalized.startswith("reference/"):
        return "reference"
    if normalized.startswith("scripts/"):
        return "script"
    if normalized.startswith("module-installs/"):
        return "module"
    return "file"


def read_preview(target: Path, limit: int = 240) -> str:
    if not target.exists() or not target.is_file():
        return ""
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return "Binary or unsupported file preview."
    return " ".join(content.split())[:limit]


def entry_for_path(target: Path) -> dict[str, Any]:
    relative = str(target.relative_to(workspace_root())).replace("\\", "/")
    stat = target.stat()
    return {
        "path": relative,
        "kind": file_kind(relative),
        "name": target.name,
        "extension": target.suffix.lower(),
        "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "size": stat.st_size,
        "preview": read_preview(target),
        "isDir": target.is_dir(),
    }


def _list_files(base: Path, recursive: bool = False, limit: int = 200) -> list[dict[str, Any]]:
    if not base.exists():
        return []
    iterator = base.rglob("*") if recursive else base.glob("*")
    entries: list[dict[str, Any]] = []
    for target in iterator:
        if target.name in {".DS_Store", "__MACOSX"}:
            continue
        if target.is_file():
            entries.append(entry_for_path(target))
    entries.sort(key=lambda item: item["modifiedAt"], reverse=True)
    return entries[:limit]


def list_directory(path: str, recursive: bool = False, limit: int = 200) -> dict[str, Any]:
    target = safe_path(path)
    return {"path": path, "entries": _list_files(target, recursive=recursive, limit=limit)}


def list_external_directory(path: str, limit: int = 200) -> dict[str, Any]:
    """List files at an arbitrary absolute path on the user's machine —
    used to peek inside folder attachments picked from the OS dialog.
    Bypasses safe_path because the user explicitly granted access by
    picking the folder. Read-only; refuses to list non-existent or
    non-directory paths."""
    target = Path(path).expanduser()
    if not target.is_absolute():
        return {"path": path, "entries": [], "error": "Path must be absolute"}
    if not target.exists() or not target.is_dir():
        return {"path": path, "entries": [], "error": "Folder not found"}
    return {"path": str(target), "entries": _list_files(target, recursive=False, limit=limit)}


def browse_external_directory(path: str, limit: int = 500) -> dict[str, Any]:
    """List BOTH files and subfolders at an arbitrary absolute path —
    backs the in-app file browser for linked folders on the Imports page.
    Folders sort first (alphabetical), then files (alphabetical). Each
    entry carries an absolute `path` so the renderer can drill in or
    hand off to shell.openPath. Hidden Mac cruft (.DS_Store, __MACOSX)
    is skipped. Read-only; refuses non-existent or non-directory paths.
    """
    target = Path(path).expanduser()
    if not target.is_absolute():
        return {"path": path, "entries": [], "error": "Path must be absolute"}
    if not target.exists() or not target.is_dir():
        return {"path": path, "entries": [], "error": "Folder not found"}
    folders: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    try:
        iterator = target.iterdir()
    except PermissionError:
        return {"path": str(target), "entries": [], "error": "Permission denied"}
    for child in iterator:
        if child.name in {".DS_Store", "__MACOSX"}:
            continue
        try:
            stat = child.stat()
        except (OSError, PermissionError):
            continue
        modified = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
        if child.is_dir():
            folders.append({
                "name": child.name,
                "path": str(child),
                "kind": "folder",
                "size": 0,
                "extension": "",
                "modifiedAt": modified,
            })
        elif child.is_file():
            files.append({
                "name": child.name,
                "path": str(child),
                "kind": "file",
                "size": stat.st_size,
                "extension": child.suffix.lower().lstrip("."),
                "modifiedAt": modified,
            })
    folders.sort(key=lambda item: item["name"].lower())
    files.sort(key=lambda item: item["name"].lower())
    combined = folders + files
    truncated = len(combined) > limit
    return {
        "path": str(target),
        "entries": combined[:limit],
        "truncated": truncated,
        "totalCount": len(combined),
    }


def list_workspace_section(section: str) -> dict[str, Any]:
    mapping = {
        "context": ("context", False),
        "imports": ("context/import", False),
        "outputs": ("outputs", True),
        "plans": ("plans", False),
        "shares": ("shares", True),
        "reference": ("reference", True),
        "scripts": ("scripts", True),
        "workspace": (".", False),
    }
    relative_path, recursive = mapping.get(section, (section, False))
    return list_directory(relative_path, recursive=recursive, limit=300)


def list_workspace_files(limit: int = 400) -> dict[str, Any]:
    sections = ["context", "context/import", "outputs", "plans", "shares", "reference", "scripts"]
    entries: list[dict[str, Any]] = []
    for section in sections:
        entries.extend(_list_files(workspace_root() / section, recursive=True, limit=limit))
    entries.sort(key=lambda item: item["modifiedAt"], reverse=True)
    return {"entries": entries[:limit]}


def get_recent_workspace_activity(limit: int = 20) -> dict[str, Any]:
    entries = list_workspace_files(limit=limit * 10)["entries"]
    return {"entries": entries[:limit]}


def read_markdown_preview(path: str) -> dict[str, Any]:
    target = safe_path(path)
    content = target.read_text(encoding="utf-8") if target.exists() else ""
    return {
        "path": path,
        "content": content,
        "preview": " ".join(content.split())[:480],
        "modifiedAt": datetime.fromtimestamp(target.stat().st_mtime, timezone.utc).isoformat() if target.exists() else None,
        "kind": file_kind(path),
    }


def get_outputs_summary() -> dict[str, Any]:
    return list_directory("outputs", recursive=True, limit=300)


def get_plans_summary() -> dict[str, Any]:
    return list_directory("plans", recursive=False, limit=200)


def get_shares_summary() -> dict[str, Any]:
    return list_directory("shares", recursive=True, limit=200)


def get_context_summary() -> dict[str, Any]:
    files = ["personal-info.md", "business-info.md", "strategy.md", "current-data.md", "funnel.md"]
    result = []
    for filename in files:
        target = workspace_root() / "context" / filename
        content = target.read_text(encoding="utf-8") if target.exists() else ""
        preview = " ".join(content.split())[:360]
        result.append({"path": f"context/{filename}", "exists": target.exists(), "preview": preview})
    imports_dir = workspace_root() / "context" / "import"
    imports: list[dict[str, Any]] = []
    if imports_dir.exists():
        for target in sorted(imports_dir.iterdir(), key=lambda item: item.stat().st_mtime, reverse=True):
            if not target.is_file():
                continue
            try:
                content = target.read_text(encoding="utf-8")
                preview = " ".join(content.split())[:240]
            except UnicodeDecodeError:
                preview = "Binary or unsupported file preview."
            imports.append(
                {
                    "path": f"context/import/{target.name}",
                    "name": target.name,
                    "preview": preview,
                    "updatedAt": datetime.fromtimestamp(target.stat().st_mtime, timezone.utc).isoformat(),
                }
            )
    return {"files": result, "imports": imports}


def _parse_readme(readme_path: Path) -> tuple[str | None, str | None]:
    if not readme_path.exists():
        return (None, None)
    try:
        text = readme_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return (None, None)
    title: str | None = None
    description: str | None = None
    paragraph: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if title is None and line.startswith("# "):
            title = line.lstrip("# ").strip()
            continue
        if title is None:
            continue
        if line.startswith("#"):
            if paragraph:
                break
            continue
        if line.startswith(">"):
            line = line.lstrip("> ").strip()
        if not line:
            if paragraph:
                break
            continue
        paragraph.append(line)
        if sum(len(p) for p in paragraph) > 280:
            break
    if paragraph:
        description = " ".join(paragraph).strip()
        if len(description) > 240:
            description = description[:237].rstrip() + "…"
    return (title, description)


def _has_substantive_content(target: Path) -> bool:
    if not target.is_file() or target.stat().st_size < 200:
        return False
    placeholder_signals = (
        "[Describe",
        "[What",
        "[Any important",
        "Not answered yet",
    )
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    substantive_chars = 0
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#") or stripped.startswith(">") or stripped.startswith("-"):
            continue
        if stripped.startswith("Updated:") or stripped.startswith("_"):
            continue
        if any(signal in stripped for signal in placeholder_signals):
            continue
        if len(stripped) < 30:
            continue
        substantive_chars += len(stripped)
    return substantive_chars >= 200


def _module_installed(module_root: Path, markers: list[str], require_substantive: bool = False) -> bool:
    """ANY one of the marker paths existing counts as installed.
    For directory markers, just existing is enough.
    For file markers, file must exist AND be non-empty.
    If require_substantive is True (e.g. ContextOS), the file must also contain real prose,
    not just template placeholders."""
    if not markers:
        return False
    for marker in markers:
        target = module_root / marker
        if not target.exists():
            continue
        if target.is_dir():
            return True
        if target.is_file() and target.stat().st_size > 0:
            if require_substantive:
                if _has_substantive_content(target):
                    return True
                continue
            return True
    return False


def list_modules() -> list[dict[str, Any]]:
    root = workspace_root()
    installs_dir = root / "module-installs"
    with closing(connect()) as conn:
        registered = {
            row["id"]: dict(row)
            for row in conn.execute("SELECT id, installed_at, enabled FROM modules").fetchall()
        }
    output: list[dict[str, Any]] = []
    discovered_ids: set[str] = set()
    if installs_dir.exists():
        for child in sorted(installs_dir.iterdir(), key=lambda p: p.name.lower()):
            if not child.is_dir():
                continue
            install_md = child / "INSTALL.md"
            if not install_md.exists():
                continue
            module_id = child.name
            discovered_ids.add(module_id)
            registry = MODULE_REGISTRY.get(module_id, {})
            readme_title, readme_desc = _parse_readme(child / "README.md")
            name = registry.get("name") or readme_title or module_id.replace("-", " ").title()
            description = readme_desc or registry.get("capability") or ""
            installed_flag = bool(registry.get("alwaysInstalled")) or _module_installed(
                root,
                registry.get("installedMarkers", []),
                require_substantive=bool(registry.get("requireSubstantiveContent")),
            )
            registered_row = registered.get(module_id)
            output.append(
                {
                    "id": module_id,
                    "name": name,
                    "description": description,
                    "capability": registry.get("capability") or description,
                    "source": f"module-installs/{module_id}",
                    "installPath": f"module-installs/{module_id}",
                    "phase": registry.get("phase", 99),
                    "requires": registry.get("requires", []),
                    "artifacts": registry.get("artifacts", []),
                    "connections": registry.get("connections", []),
                    "requiredConnectors": registry.get("requiredConnectors", []),
                    "builtIn": bool(registry.get("builtIn")),
                    "builtInRoute": registry.get("builtInRoute"),
                    "builtInButtonLabel": registry.get("builtInButtonLabel"),
                    "sourceExists": True,
                    "installed": installed_flag or registered_row is not None,
                    "installedAt": registered_row["installed_at"] if registered_row else None,
                    "enabled": bool(registered_row["enabled"]) if registered_row else installed_flag,
                    "readiness": "ready" if installed_flag else "available",
                }
            )
    # Surface registry-known modules whose folders are missing (so the user can see them as "missing source")
    for module_id, registry in MODULE_REGISTRY.items():
        if module_id in discovered_ids:
            continue
        registered_row = registered.get(module_id)
        output.append(
            {
                "id": module_id,
                "name": registry.get("name", module_id),
                "description": registry.get("capability", ""),
                "capability": registry.get("capability", ""),
                "source": f"module-installs/{module_id}",
                "installPath": f"module-installs/{module_id}",
                "phase": registry.get("phase", 99),
                "requires": registry.get("requires", []),
                "artifacts": registry.get("artifacts", []),
                "connections": registry.get("connections", []),
                "requiredConnectors": registry.get("requiredConnectors", []),
                "sourceExists": False,
                "installed": registered_row is not None,
                "installedAt": registered_row["installed_at"] if registered_row else None,
                "enabled": bool(registered_row["enabled"]) if registered_row else False,
                "readiness": "missing",
            }
        )
    output.sort(key=lambda m: (m.get("phase", 99), m.get("name", "")))
    return output


def install_module(module_id: str) -> dict[str, Any]:
    root = workspace_root()
    source = root / "module-installs" / module_id
    if not source.exists():
        raise ValueError(f"Module source is missing: module-installs/{module_id}")
    registry = MODULE_REGISTRY.get(module_id, {})
    name = registry.get("name", module_id)
    with closing(connect()) as conn:
        conn.execute(
            "INSERT INTO modules (id, name, version, installed_at, enabled, config) VALUES (?, ?, ?, ?, 1, '{}') "
            "ON CONFLICT(id) DO UPDATE SET enabled = 1",
            (module_id, name, "1.0.0", utc_now()),
        )
        conn.commit()
    return {"module": module_id, "installed": True}


def get_sessions() -> list[dict[str, Any]]:
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT id, title, messages, updated_at, claude_session_id, permission_mode, goal_state FROM sessions ORDER BY updated_at DESC"
        ).fetchall()
    return [
        {
            "id": row["id"],
            "title": repair_text_encoding(row["title"]),
            "messages": repair_json_text(json.loads(row["messages"] or "[]")),
            "updatedAt": row["updated_at"],
            "claudeSessionId": row["claude_session_id"],
            "permissionMode": row["permission_mode"] or "default",
            "activeGoal": _decode_goal_state(row["goal_state"]),
        }
        for row in rows
    ]


def _decode_goal_state(raw: Any) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    # If the persisted status is "active", the orchestrator that owned it has
    # already been killed (we're loading from disk on a fresh app boot or
    # session refetch). Coerce to "aborted" + a clear reason so the banner
    # shows a Resume button instead of pretending the loop is live.
    if parsed.get("status") == "active":
        parsed["status"] = "aborted"
        parsed["lastReason"] = "App was closed — click Resume to continue."
    return parsed


def create_thread(title: str | None = None) -> dict[str, Any]:
    session_id = f"thread-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"
    session_title = (title or "New Thread").strip() or "New Thread"
    session = {
        "id": session_id,
        "title": session_title,
        "messages": [],
        "updatedAt": utc_now(),
        "claudeSessionId": None,
        "permissionMode": "default",
        "activeGoal": None,
    }
    save_session(session)
    return session


def delete_thread(session_id: str) -> dict[str, Any]:
    with closing(connect()) as conn:
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        conn.commit()
    return {"deleted": True, "id": session_id}


def rename_thread(session_id: str, title: str) -> dict[str, Any]:
    with closing(connect()) as conn:
        row = conn.execute("SELECT messages FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            raise ValueError(f"Unknown session: {session_id}")
        conn.execute("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", (title.strip() or "Untitled", utc_now(), session_id))
        conn.commit()
    return {"id": session_id, "title": title.strip() or "Untitled"}


_ALLOWED_PERMISSION_MODES = {"default", "plan", "acceptEdits"}


def save_session(session: dict[str, Any]) -> dict[str, Any]:
    session_id = str(session["id"])
    title = repair_text_encoding(str(session.get("title") or "Main"))
    messages = json.dumps(repair_json_text(session.get("messages") or []), ensure_ascii=False)
    updated_at = utc_now()
    raw_claude_id = session.get("claudeSessionId")
    claude_session_id = str(raw_claude_id) if isinstance(raw_claude_id, str) and raw_claude_id else None
    raw_perm = session.get("permissionMode")
    permission_mode = raw_perm if isinstance(raw_perm, str) and raw_perm in _ALLOWED_PERMISSION_MODES else "default"
    raw_goal = session.get("activeGoal")
    goal_state = json.dumps(raw_goal, ensure_ascii=False) if isinstance(raw_goal, dict) else None
    with closing(connect()) as conn:
        conn.execute(
            "INSERT INTO sessions (id, title, messages, updated_at, claude_session_id, permission_mode, goal_state) VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET "
            "title = excluded.title, "
            "messages = excluded.messages, "
            "updated_at = excluded.updated_at, "
            "claude_session_id = excluded.claude_session_id, "
            "permission_mode = excluded.permission_mode, "
            "goal_state = excluded.goal_state",
            (session_id, title, messages, updated_at, claude_session_id, permission_mode, goal_state),
        )
        conn.commit()
    return {"id": session_id, "updatedAt": updated_at}


def copy_module_assets(module_id: str) -> dict[str, Any]:
    return install_module(module_id)


QUESTION_LABELS = {
    "role": "Role, collaborators, and working context",
    "team": "Who else is in your business with you?",
    "six_month_goal": "What would make the next 6 months better",
    "ideal_week": "Ideal week",
    "ai_experience": "AI tools tried before",
    "work_preference": "Preferred working mode",
    "offer": "Offer, audience, and differentiation",
    "revenue_model": "Customer flow, revenue model, and operating tools",
    "acquisition": "How customers find you",
    "differentiation": "What makes you different",
    "revenue_range": "Current revenue range",
    "daily_tools": "Daily tools and platforms",
    "north_star_metric": "90-day goal or most important metric",
    "hidden_blocker": "Key blocker, decision, or risk",
    "ninety_day_success": "90-day success",
    "active_decisions": "Active decisions",
    "ideal_customer": "Ideal customer",
    "growth_fear": "Biggest fear about growth",
    "payments": "Important business data sources",
    "lead_tracking": "Lead and deal tracking",
    "meetings": "Meeting platform",
    "team_chat": "Team chat",
    "crm": "CRM",
    "content_platform": "Main content platform",
    "extra_context": "Anything else AIOS should remember",
}


# ─────────────────────────────────────────────────────────────────────────────
# Auto Tasks (in-app scheduler)
# ─────────────────────────────────────────────────────────────────────────────

SCHEDULE_PRESETS = {
    "every-15min": ("Every 15 minutes", 15 * 60),
    "every-hour": ("Every hour", 60 * 60),
    "every-6h": ("Every 6 hours", 6 * 60 * 60),
    "daily-7am": ("Daily at 7:00 AM", None),
    "daily-9am": ("Daily at 9:00 AM", None),
    "weekly-mon-9am": ("Mondays at 9:00 AM", None),
}


def compute_next_run(schedule: str, from_iso: str | None = None) -> str:
    base = (
        datetime.fromisoformat(from_iso.replace("Z", "+00:00"))
        if from_iso
        else datetime.now(timezone.utc)
    )
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)

    if schedule in SCHEDULE_PRESETS:
        _label, interval = SCHEDULE_PRESETS[schedule]
        if interval is not None:
            return (base + timedelta(seconds=interval)).isoformat()
        target_local = base.astimezone()
        if schedule == "daily-7am":
            target = target_local.replace(hour=7, minute=0, second=0, microsecond=0)
            if target <= target_local:
                target = target + timedelta(days=1)
        elif schedule == "daily-9am":
            target = target_local.replace(hour=9, minute=0, second=0, microsecond=0)
            if target <= target_local:
                target = target + timedelta(days=1)
        elif schedule == "weekly-mon-9am":
            target = target_local.replace(hour=9, minute=0, second=0, microsecond=0)
            days_ahead = (0 - target.weekday()) % 7  # Monday is 0
            if days_ahead == 0 and target <= target_local:
                days_ahead = 7
            target = target + timedelta(days=days_ahead)
        else:
            target = target_local + timedelta(hours=1)
        return target.astimezone(timezone.utc).isoformat()

    # Unknown schedule string — fall back to one hour from now to avoid runaway loops
    return (base + timedelta(hours=1)).isoformat()


def schedule_label(schedule: str) -> str:
    if schedule in SCHEDULE_PRESETS:
        return SCHEDULE_PRESETS[schedule][0]
    return schedule


def _row_to_task(row: sqlite3.Row, runs: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "prompt": row["prompt"],
        "schedule": row["schedule"],
        "scheduleLabel": schedule_label(row["schedule"]),
        "enabled": bool(row["enabled"]),
        "lastRun": row["last_run"],
        "nextRun": row["next_run"],
        "createdAt": row["created_at"],
        "recentRuns": runs or [],
    }


def _row_to_run(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "taskId": row["task_id"],
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
        "status": row["status"],
        "outputPath": row["output_path"],
        "costUsd": row["cost_usd"],
        "error": row["error"],
    }


def list_auto_tasks() -> dict[str, Any]:
    with closing(connect()) as conn:
        tasks = conn.execute(
            "SELECT * FROM auto_tasks ORDER BY enabled DESC, name ASC"
        ).fetchall()
        result: list[dict[str, Any]] = []
        for task in tasks:
            runs = conn.execute(
                """
                SELECT * FROM auto_task_runs
                WHERE task_id = ?
                ORDER BY started_at DESC
                LIMIT 5
                """,
                (task["id"],),
            ).fetchall()
            result.append(_row_to_task(task, [_row_to_run(r) for r in runs]))
    return {"tasks": result}


def create_auto_task(name: str, prompt: str, schedule: str) -> dict[str, Any]:
    name = name.strip() or "Untitled task"
    prompt = prompt.strip()
    if not prompt:
        raise ValueError("Prompt cannot be empty")
    now = datetime.now(timezone.utc).isoformat()
    next_run = compute_next_run(schedule)
    with closing(connect()) as conn:
        cur = conn.execute(
            """
            INSERT INTO auto_tasks (name, prompt, schedule, enabled, last_run, next_run, created_at)
            VALUES (?, ?, ?, 1, NULL, ?, ?)
            """,
            (name, prompt, schedule, next_run, now),
        )
        conn.commit()
        task = conn.execute(
            "SELECT * FROM auto_tasks WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    return _row_to_task(task, [])


def update_auto_task(task_id: int, *, name: str | None = None, prompt: str | None = None, schedule: str | None = None) -> dict[str, Any]:
    fields = []
    values: list[Any] = []
    if name is not None:
        fields.append("name = ?")
        values.append(name.strip() or "Untitled task")
    if prompt is not None:
        cleaned = prompt.strip()
        if not cleaned:
            raise ValueError("Prompt cannot be empty")
        fields.append("prompt = ?")
        values.append(cleaned)
    if schedule is not None:
        fields.append("schedule = ?")
        values.append(schedule)
        fields.append("next_run = ?")
        values.append(compute_next_run(schedule))
    if not fields:
        return list_auto_tasks()
    values.append(task_id)
    with closing(connect()) as conn:
        conn.execute(f"UPDATE auto_tasks SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
        task = conn.execute("SELECT * FROM auto_tasks WHERE id = ?", (task_id,)).fetchone()
    if not task:
        raise ValueError(f"Auto-task {task_id} not found")
    return _row_to_task(task, [])


def delete_auto_task(task_id: int) -> dict[str, Any]:
    with closing(connect()) as conn:
        conn.execute("DELETE FROM auto_task_runs WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM auto_tasks WHERE id = ?", (task_id,))
        conn.commit()
    return {"deleted": True, "id": task_id}


def toggle_auto_task(task_id: int, enabled: bool) -> dict[str, Any]:
    with closing(connect()) as conn:
        conn.execute(
            "UPDATE auto_tasks SET enabled = ? WHERE id = ?",
            (1 if enabled else 0, task_id),
        )
        if enabled:
            conn.execute(
                "UPDATE auto_tasks SET next_run = ? WHERE id = ? AND (next_run IS NULL OR next_run < ?)",
                (compute_next_run("every-hour"), task_id, datetime.now(timezone.utc).isoformat()),
            )
        conn.commit()
        task = conn.execute("SELECT * FROM auto_tasks WHERE id = ?", (task_id,)).fetchone()
    if not task:
        raise ValueError(f"Auto-task {task_id} not found")
    return _row_to_task(task, [])


def due_auto_tasks(now_iso: str | None = None) -> list[dict[str, Any]]:
    now = now_iso or datetime.now(timezone.utc).isoformat()
    with closing(connect()) as conn:
        rows = conn.execute(
            """
            SELECT * FROM auto_tasks
            WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?
            """,
            (now,),
        ).fetchall()
    return [_row_to_task(r) for r in rows]


def begin_auto_task_run(task_id: int) -> dict[str, Any]:
    started = datetime.now(timezone.utc).isoformat()
    with closing(connect()) as conn:
        cur = conn.execute(
            """
            INSERT INTO auto_task_runs (task_id, started_at, status)
            VALUES (?, ?, 'pending')
            """,
            (task_id, started),
        )
        conn.commit()
        run_id = cur.lastrowid
    return {"id": run_id, "taskId": task_id, "startedAt": started, "status": "pending"}


def finish_auto_task_run(
    run_id: int,
    *,
    status: str,
    output_path: str | None = None,
    cost_usd: float | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    finished = datetime.now(timezone.utc).isoformat()
    with closing(connect()) as conn:
        conn.execute(
            """
            UPDATE auto_task_runs
            SET finished_at = ?, status = ?, output_path = ?, cost_usd = ?, error = ?
            WHERE id = ?
            """,
            (finished, status, output_path, cost_usd, error, run_id),
        )
        run = conn.execute("SELECT * FROM auto_task_runs WHERE id = ?", (run_id,)).fetchone()
        conn.commit()
    return _row_to_run(run) if run else {"id": run_id, "status": status, "finishedAt": finished}


def advance_auto_task(task_id: int) -> None:
    with closing(connect()) as conn:
        row = conn.execute("SELECT schedule FROM auto_tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            return
        now_iso = datetime.now(timezone.utc).isoformat()
        next_run = compute_next_run(row["schedule"])
        conn.execute(
            "UPDATE auto_tasks SET last_run = ?, next_run = ? WHERE id = ?",
            (now_iso, next_run, task_id),
        )
        conn.commit()


def list_recent_auto_runs(limit: int = 10) -> dict[str, Any]:
    with closing(connect()) as conn:
        rows = conn.execute(
            """
            SELECT r.*, t.name AS task_name
            FROM auto_task_runs r
            LEFT JOIN auto_tasks t ON t.id = r.task_id
            ORDER BY r.started_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    out = []
    for row in rows:
        run = _row_to_run(row)
        run["taskName"] = row["task_name"] or f"Task #{row['task_id']}"
        out.append(run)
    return {"runs": out}


def delete_workspace_file(rel_path: str) -> dict[str, Any]:
    target = safe_path(rel_path)
    if target.exists() and target.is_file():
        target.unlink()
        return {"deleted": True, "path": rel_path}
    return {"deleted": False, "path": rel_path}


# ─── Daily Brief / app state ────────────────────────────────────────────────


def get_app_state(key: str) -> str | None:
    with closing(connect()) as conn:
        row = conn.execute("SELECT value FROM app_state WHERE key = ?", (key,)).fetchone()
    return None if row is None else row["value"]


def set_app_state(key: str, value: str) -> None:
    with closing(connect()) as conn:
        conn.execute(
            "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, value, utc_now()),
        )
        conn.commit()


def record_first_install_if_missing(local_date: str) -> str:
    existing = get_app_state("first_install_date")
    if existing:
        return existing
    set_app_state("first_install_date", local_date)
    return local_date


def get_or_create_device_user_id() -> str:
    """Stable per-device identity used as the Composio entity_id.
    Generated once on first launch, persisted in app_state, never rotated."""
    import uuid
    existing = get_app_state("device_user_id")
    if existing:
        return existing
    new_id = str(uuid.uuid4())
    set_app_state("device_user_id", new_id)
    return new_id


def rotate_device_user_id() -> str:
    """Blow away the current device_user_id and generate a brand-new one.
    Used to escape stuck Composio sessions/entities — when a tool router
    session is bound to a stale OAuth token and Composio offers no API to
    refresh it, rotating the user_id forces a fresh entity, fresh session,
    and fresh OAuth flow next time the user reconnects."""
    import uuid
    new_id = str(uuid.uuid4())
    set_app_state("device_user_id", new_id)
    return new_id


# All connector service slugs the AIOS Desktop knows about — used by
# list_connector_status to enumerate which connectors are configured. Keep in
# sync with renderer/src/screens/ConnectorsScreen.tsx::CONNECTOR_CATALOG.
KNOWN_CONNECTORS = [
    "gmail",
    "google-calendar",
    "slack",
    "clickup",
    "notion",
    "github",
    # DataOS connectors (added in the modules-connectors refactor)
    "stripe",
    "youtube",
    "google-analytics",
    "google-sheets",
    # Communication / social connectors (v0.1.11+)
    "outlook",
    "linkedin",
    # Messaging (v0.1.15+)
    "whatsapp",
    # Social (v0.1.16+)
    "twitter",
    # Messaging via API key (v0.1.16+)
    "telegram",
    # Social (v0.1.17+)
    "facebook",
    "instagram",
    # Local Baileys-based pairing (v0.1.19+)
    "whatsapp-personal",
    # v0.1.26 connectors expansion — productivity, storage, design, dev, voice
    "supabase",
    "google-drive",
    "airtable",
    "firecrawl",
    "discord",
    "onedrive",
    "exa",
    "elevenlabs",
    "salesforce",
    "calendly",
    "google-meet",
    "zoho",
    "dropbox",
    "heygen",
    "yousearch",
    "retellai",
    "canva",
    "cal-com",
    "telnyx",
    "cloudflare",
    "reddit",
    "cloudinary",
    "convex",
    "dockerhub",
    "excel",
    "google-maps",
]


# Pretty display names for the connector-scope-lock string injected into the
# Composio system prompt. Keep in sync with CONNECTOR_CATALOG.label in
# renderer/src/screens/ConnectorsScreen.tsx.
CONNECTOR_DISPLAY_NAMES = {
    "gmail": "Gmail",
    "google-calendar": "Google Calendar",
    "slack": "Slack",
    "clickup": "ClickUp",
    "notion": "Notion",
    "github": "GitHub",
    "stripe": "Stripe",
    "youtube": "YouTube",
    "google-analytics": "Google Analytics",
    "google-sheets": "Google Sheets",
    "outlook": "Outlook",
    "linkedin": "LinkedIn",
    "whatsapp": "WhatsApp Business",
    "twitter": "X (Twitter)",
    "telegram": "Telegram",
    "facebook": "Facebook",
    "instagram": "Instagram",
    "whatsapp-personal": "WhatsApp Personal",
    "supabase": "Supabase",
    "google-drive": "Google Drive",
    "airtable": "Airtable",
    "firecrawl": "Firecrawl",
    "discord": "Discord",
    "onedrive": "OneDrive",
    "exa": "Exa",
    "elevenlabs": "ElevenLabs",
    "salesforce": "Salesforce",
    "calendly": "Calendly",
    "google-meet": "Google Meet",
    "zoho": "Zoho",
    "dropbox": "Dropbox",
    "heygen": "HeyGen",
    "yousearch": "You.com",
    "retellai": "Retell AI",
    "canva": "Canva",
    "cal-com": "Cal.com",
    "telnyx": "Telnyx",
    "cloudflare": "Cloudflare",
    "reddit": "Reddit",
    "cloudinary": "Cloudinary",
    "convex": "Convex",
    "dockerhub": "DockerHub",
    "excel": "Excel",
    "google-maps": "Google Maps",
}


def list_connected_service_slugs() -> list[str]:
    """Return the slugs of connectors that the user has actually authorized
    (those with a populated `connector_label_<slug>` entry in app_state).
    Used by the host to inject a connector-scope-lock string into the
    Composio system prompt — the spawned Claude only references services that
    are wired AND connected.
    """
    connected: list[str] = []
    for service in KNOWN_CONNECTORS:
        if get_setting(f"connector_label_{service}"):
            connected.append(service)
    return connected


def list_connector_status() -> dict[str, Any]:
    """Return the configured state of every known connector. Used by the
    /install slash command and the Modules screen to decide whether a module's
    required connectors are ready.

    A connector is considered "connected" if its `connector_label_<service>`
    setting is populated — that label is written by ConnectorsScreen after
    Claude identifies the OAuth-authorized account.
    """
    statuses: dict[str, dict[str, Any]] = {}
    for service in KNOWN_CONNECTORS:
        label = get_setting(f"connector_label_{service}")
        statuses[service] = {
            "connected": bool(label),
            "label": label if label else None,
        }
    return {"connectors": statuses}


def mark_import_folder(folder_name: str) -> dict[str, Any]:
    """Mark an import folder as available for @mention in chat. Idempotent —
    re-marking refreshes marked_at. Returns the row state after the write."""
    name = (folder_name or "").strip()
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("Invalid folder name")
    marked_at = utc_now()
    with closing(connect()) as conn:
        conn.execute(
            "INSERT INTO import_markers (folder_name, marked_at) VALUES (?, ?) "
            "ON CONFLICT(folder_name) DO UPDATE SET marked_at = excluded.marked_at",
            (name, marked_at),
        )
        conn.commit()
    return {"name": name, "isMarked": True, "markedAt": marked_at}


def unmark_import_folder(folder_name: str) -> dict[str, Any]:
    """Remove the @mention marker for a folder. Safe to call when the row is
    already absent — returns the same shape either way."""
    name = (folder_name or "").strip()
    if not name:
        raise ValueError("Folder name is required")
    with closing(connect()) as conn:
        conn.execute("DELETE FROM import_markers WHERE folder_name = ?", (name,))
        conn.commit()
    return {"name": name, "isMarked": False, "markedAt": None}


def list_marked_import_folders() -> list[dict[str, Any]]:
    """Return marked import folders sorted by most-recently-marked first.
    Skips ghosts: if the folder was deleted on disk, we drop the row and
    don't surface it. Cleanup is best-effort — fail-quiet if delete races."""
    root = workspace_root() / "context" / "import"
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT folder_name, marked_at FROM import_markers ORDER BY marked_at DESC"
        ).fetchall()
        ghosts: list[str] = []
        result: list[dict[str, Any]] = []
        for row in rows:
            name = row["folder_name"]
            target = root / name
            if not target.exists() or not target.is_dir():
                ghosts.append(name)
                continue
            result.append({
                "name": name,
                "absolutePath": str(target.resolve()),
                "markedAt": row["marked_at"],
            })
        if ghosts:
            try:
                conn.executemany(
                    "DELETE FROM import_markers WHERE folder_name = ?",
                    [(n,) for n in ghosts],
                )
                conn.commit()
            except sqlite3.OperationalError:
                pass
    return result


def link_folder(absolute_path: str, display_name: str | None = None) -> dict[str, Any]:
    """Register an on-disk folder (anywhere outside the workspace) so it shows
    up on the Imports page and in the chat @ palette. The folder is referenced
    by absolute path — no copy happens, Claude reaches into it lazily via the
    --add-dir flag at run_task time."""
    raw = (absolute_path or "").strip()
    if not raw:
        raise ValueError("absolute_path is required")
    # Best-effort existence check at link time; ghosts are pruned on read.
    if not os.path.isdir(raw):
        raise ValueError(f"Folder does not exist: {raw}")
    segments = [seg for seg in raw.replace("\\", "/").split("/") if seg]
    fallback = segments[-1] if segments else raw
    name = (display_name or "").strip() or fallback
    added_at = utc_now()
    with closing(connect()) as conn:
        conn.execute(
            "INSERT INTO linked_folders (absolute_path, name, added_at) VALUES (?, ?, ?) "
            "ON CONFLICT(absolute_path) DO UPDATE SET name = excluded.name, added_at = excluded.added_at",
            (raw, name, added_at),
        )
        conn.commit()
    return {"absolutePath": raw, "name": name, "addedAt": added_at}


def unlink_folder(absolute_path: str) -> dict[str, Any]:
    raw = (absolute_path or "").strip()
    if not raw:
        raise ValueError("absolute_path is required")
    with closing(connect()) as conn:
        conn.execute("DELETE FROM linked_folders WHERE absolute_path = ?", (raw,))
        conn.commit()
    return {"absolutePath": raw, "removed": True}


def list_linked_folders() -> list[dict[str, Any]]:
    """Return picked-on-disk folders sorted by most-recently-added first.
    Prunes rows whose path no longer exists — keeps the Imports page honest
    when external drives are ejected or folders are deleted outside the app."""
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT absolute_path, name, added_at FROM linked_folders ORDER BY added_at DESC"
        ).fetchall()
        ghosts: list[str] = []
        result: list[dict[str, Any]] = []
        for row in rows:
            ap = row["absolute_path"]
            try:
                exists = os.path.isdir(ap)
            except OSError:
                exists = False
            if not exists:
                ghosts.append(ap)
                continue
            result.append({
                "absolutePath": ap,
                "name": row["name"],
                "addedAt": row["added_at"],
            })
        if ghosts:
            try:
                conn.executemany(
                    "DELETE FROM linked_folders WHERE absolute_path = ?",
                    [(p,) for p in ghosts],
                )
                conn.commit()
            except sqlite3.OperationalError:
                pass
    return result


def is_import_folder_marked(folder_name: str) -> bool:
    with closing(connect()) as conn:
        row = conn.execute(
            "SELECT 1 FROM import_markers WHERE folder_name = ?", (folder_name,)
        ).fetchone()
    return row is not None


def claude_settings_path() -> Path:
    """Resolve the path to Claude Code CLI's settings.json.
    Windows uses %USERPROFILE%, Mac/Linux use $HOME — Path.home() handles both."""
    return Path.home() / ".claude" / "settings.json"


def _sanitize_mcp_entry_for_storage(cfg: dict[str, Any]) -> dict[str, Any] | None:
    """Mirror of host._sanitize_mcp_entry — applied at WRITE time so the
    persisted ~/.claude/settings.json entry stays clean and never has Composio's
    extra SDK fields (auth, name, description, etc.) that Claude's strict
    inline parser rejects."""
    if not isinstance(cfg, dict):
        return None
    url = cfg.get("url")
    if not isinstance(url, str) or not url:
        return None
    headers = cfg.get("headers") if isinstance(cfg.get("headers"), dict) else {}
    server_type = cfg.get("type") if cfg.get("type") in ("http", "sse") else "http"
    return {"type": server_type, "url": url, "headers": headers}


def update_claude_mcp_config(name: str, config: dict[str, Any] | None) -> dict[str, Any]:
    """Merge a single MCP server entry into ~/.claude/settings.json.

    If config is None, the named server is removed. Other unrelated keys in
    settings.json are preserved untouched.

    HTTP/SSE configs are passed through `_sanitize_mcp_entry_for_storage` so we
    only persist `{type, url, headers}` — the strict Claude --mcp-config parser
    rejects entries with Composio's extra SDK fields. stdio configs (have
    `command`) bypass the sanitizer.
    """
    if not isinstance(name, str) or not name.strip():
        raise HostError("BAD_REQUEST", "MCP server name is required.") if "HostError" in globals() else ValueError("MCP server name is required")

    path = claude_settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    settings: dict[str, Any] = {}
    if path.exists():
        try:
            settings = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(settings, dict):
                settings = {}
        except (json.JSONDecodeError, OSError):
            settings = {}

    mcp_servers = settings.get("mcpServers")
    if not isinstance(mcp_servers, dict):
        mcp_servers = {}

    if config is None:
        mcp_servers.pop(name, None)
    else:
        # Sanitize HTTP/SSE entries; pass stdio (which has `command`) through unchanged.
        if isinstance(config, dict) and "command" not in config:
            sanitized = _sanitize_mcp_entry_for_storage(config)
            if sanitized is None:
                raise ValueError(
                    f"MCP entry for '{name}' is missing a usable URL — refusing to persist."
                )
            mcp_servers[name] = sanitized
        else:
            mcp_servers[name] = config

    settings["mcpServers"] = mcp_servers
    path.write_text(json.dumps(settings, indent=2), encoding="utf-8")

    return {
        "path": str(path),
        "name": name,
        "removed": config is None,
        "serverCount": len(mcp_servers),
    }


def _row_to_brief(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "briefDate": row["brief_date"],
        "generatedAt": row["generated_at"],
        "headline": row["headline"],
        "content": row["content"],
    }


def get_daily_brief(brief_date: str) -> dict[str, Any] | None:
    with closing(connect()) as conn:
        row = conn.execute(
            "SELECT * FROM daily_briefs WHERE brief_date = ?", (brief_date,)
        ).fetchone()
    return _row_to_brief(row) if row else None


def save_daily_brief(brief_date: str, headline: str | None, content: str) -> dict[str, Any]:
    with closing(connect()) as conn:
        conn.execute(
            "INSERT INTO daily_briefs (brief_date, generated_at, headline, content) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(brief_date) DO UPDATE SET generated_at = excluded.generated_at, headline = excluded.headline, content = excluded.content",
            (brief_date, utc_now(), headline, content),
        )
        conn.commit()
    # Also persist a markdown file in outputs/daily-brief/
    try:
        target = workspace_root() / "outputs" / "daily-brief" / f"{brief_date}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        body = f"# Daily Brief — {brief_date}\n\n"
        if headline:
            body += f"_{headline}_\n\n"
        body += content.strip() + "\n"
        target.write_text(body, encoding="utf-8")
    except OSError:
        pass
    brief = get_daily_brief(brief_date)
    return brief if brief else {"briefDate": brief_date, "headline": headline, "content": content}


def list_daily_briefs(limit: int = 60) -> dict[str, Any]:
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT * FROM daily_briefs ORDER BY brief_date DESC LIMIT ?", (limit,)
        ).fetchall()
    return {"briefs": [_row_to_brief(row) for row in rows]}


def get_today_brief_status(local_date: str) -> dict[str, Any]:
    first_install = record_first_install_if_missing(local_date)
    last_seen = get_app_state("last_brief_seen_date")
    existing = get_daily_brief(local_date)
    if first_install == local_date:
        should_show = False
    elif last_seen == local_date:
        should_show = False
    else:
        should_show = True
    return {
        "shouldShow": should_show,
        "todayDate": local_date,
        "firstInstallDate": first_install,
        "lastBriefSeenDate": last_seen,
        "existingBrief": existing,
    }


def mark_brief_seen(local_date: str) -> dict[str, Any]:
    set_app_state("last_brief_seen_date", local_date)
    return {"ok": True, "lastBriefSeenDate": local_date}


def build_daily_brief_prompt(local_date: str) -> str:
    """Build the user prompt body Claude should answer to produce the daily brief.
    The prompt instructs Claude to read context files itself via tool calls."""
    from datetime import datetime as _dt
    try:
        dt = _dt.strptime(local_date, "%Y-%m-%d")
        weekday = dt.strftime("%A")
        date_pretty = dt.strftime("%B %-d, %Y") if os.name != "nt" else dt.strftime("%B %#d, %Y")
    except ValueError:
        weekday = ""
        date_pretty = local_date
    return (
        f"Write a short, friendly **daily brief** for the user of this AIOS workspace.\n"
        f"Today is {weekday}, {date_pretty} ({local_date}).\n\n"
        f"Read the relevant context to ground the brief:\n"
        f"- context/business-info.md, context/personal-info.md, context/strategy.md (who they are, what they're working on)\n"
        f"- plans/ folder (what's pending or in-progress)\n"
        f"- outputs/ folder, the 3-5 most recent files (what they've produced lately)\n"
        f"- gtd/ folder if it exists (current next-actions and inbox)\n\n"
        f"Then respond with markdown ONLY in this exact structure (no preamble, no closing remarks):\n\n"
        f"## {{One-line headline — what today is mostly about}}\n\n"
        f"**Focus today**\n"
        f"- {{3 to 5 short bullets — concrete things to do today}}\n\n"
        f"**Worth a glance**\n"
        f"- {{0 to 3 short bullets: anything waiting, blocked, or worth noticing}}\n\n"
        f"Keep it under 200 words total. Tone: calm, encouraging, no jargon. Speak directly to the user as 'you'.\n"
        f"If the workspace is mostly empty (no plans, no outputs, no context yet), just say 'Your workspace is fresh — start by filling in your business context (Context page) so tomorrow's brief has something to work with.' and nothing else."
    )
