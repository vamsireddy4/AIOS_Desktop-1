import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  FileText,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  Trash2,
  X
} from "lucide-react";
import { invoke } from "../lib/api";
import { ConfirmModal } from "../components/ui";
import type { AgentInfo, TaskInfo } from "../types";

type Bucket = "queued" | "running" | "completed" | "failed";

const KANBAN_COLUMNS: Array<{ id: Bucket; title: string; statuses: Set<TaskInfo["status"]>; tone: Bucket }> = [
  { id: "queued",    title: "Queued",      statuses: new Set(["pending"]),                                                                                                tone: "queued"    },
  { id: "running",   title: "In progress", statuses: new Set(["in_progress", "blocked", "awaiting_connection", "awaiting_approval", "awaiting_children"]),                 tone: "running"   },
  { id: "completed", title: "Completed",   statuses: new Set(["completed"]),                                                                                              tone: "completed" },
  { id: "failed",    title: "Failed",      statuses: new Set(["failed", "cancelled"]),                                                                                    tone: "failed"    }
];

// User-facing label override for statuses where the raw DB value reads as
// jargon. "Blocked" sounds like a system error — but in practice it just
// means the agent has a question for the user and is waiting for guidance.
// "Needs your input" sets the right expectation: this is on you, not broken.
// "Awaiting approval" → "Waiting for review" matches the language the user
// actually thinks in ("review and approve") and reads as a calmer state.
const STATUS_LABEL_OVERRIDES: Record<string, string> = {
  blocked: "Needs your input",
  awaiting_approval: "Waiting for review",
};

function formatStatusLabel(status: string): string {
  if (STATUS_LABEL_OVERRIDES[status]) return STATUS_LABEL_OVERRIDES[status];
  const normalized = status.replace(/_/g, " ").trim();
  return normalized ? normalized.replace(/\b\w/g, (ch) => ch.toUpperCase()) : "Unknown";
}

function summarizeTaskNote(task: TaskInfo): string {
  if (task.blocked_reason) return task.blocked_reason;
  if (task.result) return task.result;
  if (task.needs_connector) return `Awaiting ${task.needs_connector} connection.`;
  return task.message || "No notes yet.";
}

function formatDetailTimestamp(value: any): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatShortTime(value: any): string {
  if (!value) return "now";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "now" : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusBucket(status: TaskInfo["status"]): Bucket {
  for (const col of KANBAN_COLUMNS) {
    if (col.statuses.has(status)) return col.id;
  }
  return "queued";
}

function agentNameById(agents: AgentInfo[], agentId: string): string {
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}

export function TasksScreen({ onNavigate }: { onNavigate?: (screen: import("../ui").Screen) => void } = {}) {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [recentOutputs, setRecentOutputs] = useState<Array<{ path: string; name?: string; modifiedAt?: string }>>([]);

  const [searchQuery, setSearchQuery] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newMessage, setNewMessage] = useState("");
  const [newPriority, setNewPriority] = useState(3);
  const [newAgentId, setNewAgentId] = useState("ceo");
  // Team mode: forces CEO routing with explicit multi-agent decomposition.
  // When on, the message gets prefixed with [TEAM_MODE] (a UI signal the
  // runner strips before passing to Claude — CEO's system prompt recognizes
  // it and MUST emit ≥2 [ASSIGN_TASK:] lines).
  const [newTeamMode, setNewTeamMode] = useState(false);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTask, setDetailsTask] = useState<TaskInfo | null>(null);
  const [detailsActionLoading, setDetailsActionLoading] = useState(false);
  const [detailsActionError, setDetailsActionError] = useState("");
  const [detailsActionNote, setDetailsActionNote] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refresh();
    }, 5_000);
    // Live updates — the runner broadcasts these events as tasks change
    // state. Without this, the Kanban only refreshes every 5s, making
    // status transitions feel laggy.
    const unsub = window.aios?.onHostEvent?.((event: any) => {
      const name = event?.event;
      if (name === "task_update" || name === "task_narrative" || name === "agents_changed") {
        void refresh();
      }
    });
    return () => {
      clearInterval(interval);
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    try {
      const [taskRes, agentRes, outputsRes] = await Promise.all([
        invoke<{ tasks: TaskInfo[] }>("list_tasks", {}),
        invoke<{ agents: AgentInfo[] }>("list_agents", {}),
        invoke<{ entries: Array<{ path: string; name?: string; modifiedAt?: string }> }>("list_outputs", {}).catch(() => ({ entries: [] })),
      ]);
      setTasks(taskRes?.tasks || []);
      setAgents(agentRes?.agents || []);
      // Top 5 most recently modified outputs — list_directory already
      // returns entries sorted by modifiedAt desc.
      setRecentOutputs((outputsRes?.entries || []).slice(0, 5));
    } catch (err) {
      console.error("Failed to load tasks/agents:", err);
    } finally {
      setLoading(false);
    }
  }

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) => t.name.toLowerCase().includes(q));
  }, [tasks, searchQuery]);

  async function handleCreateTask() {
    const message = newMessage.trim();
    if (!message) return;
    setSaving(true);
    try {
      // Team mode → force CEO + prepend [TEAM_MODE] marker. CEO's system
      // prompt sees the marker and MUST decompose into ≥2 specialists.
      const finalAgentId = newTeamMode ? "ceo" : newAgentId;
      const finalMessage = newTeamMode ? `[TEAM_MODE] ${message}` : message;
      await invoke<TaskInfo>("create_task", {
        name: `Task: ${message.slice(0, 60)}${message.length > 60 ? "…" : ""}`,
        message: finalMessage,
        agentId: finalAgentId,
        priority: Math.max(1, Math.min(5, Number(newPriority) || 3)),
      });
      setCreateOpen(false);
      setNewMessage("");
      setNewPriority(3);
      setNewAgentId("ceo");
      setNewTeamMode(false);
      void refresh();
    } catch (err) {
      console.error("Failed to create task:", err);
    } finally {
      setSaving(false);
    }
  }

  async function openDetails(task: TaskInfo) {
    if (!task.id) return;
    setDetailsOpen(true);
    setDetailsActionError("");
    setDetailsActionNote("");
    setDetailsTask(task);
    try {
      const fresh = await invoke<TaskInfo>("get_task", { id: task.id });
      if (fresh && fresh.id) setDetailsTask(fresh);
    } catch {
      // keep the cached row already shown
    }
  }

  function closeDetails() {
    setDetailsOpen(false);
    setDetailsTask(null);
    setDetailsActionLoading(false);
    setDetailsActionError("");
    setDetailsActionNote("");
  }

  async function handleTaskAction(action: string) {
    if (!detailsTask?.id) return;
    setDetailsActionLoading(true);
    setDetailsActionError("");
    try {
      const updated = await invoke<TaskInfo>("task_action", {
        id: detailsTask.id,
        action,
        note: detailsActionNote.trim() || undefined,
      });
      setDetailsActionNote("");
      if (updated && updated.id) setDetailsTask(updated);
      void refresh();
    } catch (err: any) {
      setDetailsActionError(err?.message || "Task action failed");
    } finally {
      setDetailsActionLoading(false);
    }
  }

  async function handleDeleteTask(taskId: string) {
    setConfirmDeleteId(taskId);
  }

  async function confirmDelete() {
    if (!confirmDeleteId) return;
    try {
      await invoke("delete_task", { id: confirmDeleteId });
      setDetailsOpen(false);
      setDetailsTask(null);
      setConfirmDeleteId(null);
      void refresh();
    } catch (err) {
      console.error("Failed to delete task:", err);
      alert("Failed to delete task. Error: " + (err instanceof Error ? err.message : String(err)));
      setConfirmDeleteId(null);
    }
  }

  if (loading) {
    return (
      <section className="tasks-v2-screen">
        <div className="tasks-v2-loading">
          <Loader2 size={16} className="spin" />
          Loading tasks…
        </div>
      </section>
    );
  }

  return (
    <section className="tasks-v2-screen">
      <header className="tasks-v2-hero">
        <div className="tasks-v2-hero-content">
          <div className="tasks-v2-hero-text">
            <p className="layer-badge">
              <span className="layer-dot" aria-hidden="true" />
              Layer · Tasks
            </p>
            <h1>Your <em>tasks</em></h1>
            <p className="tasks-v2-subtitle">Manage your team's workload and track mission progress.</p>
          </div>

          <div className="tasks-v2-toolbar">
            <div className="tasks-v2-toolbar-left">
              <div className="tasks-v2-search">
                <Search size={13} aria-hidden="true" />
                <input
                  type="text"
                  placeholder="Search tasks…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <button
                type="button"
                className="tasks-v2-create"
                onClick={() => setCreateOpen(true)}
                disabled={saving}
              >
                <Plus size={13} /> New mission
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="tasks-v2-body">
        {recentOutputs.length > 0 && onNavigate ? (
          <section className="tasks-v2-outputs-strip" aria-label="Recent outputs from chat">
            <header className="tasks-v2-outputs-head">
              <span className="eyebrow">Recent outputs from chat</span>
              <button type="button" className="tasks-v2-outputs-link" onClick={() => onNavigate("outputs")}>
                Open Outputs →
              </button>
            </header>
            <ul className="tasks-v2-outputs-list">
              {recentOutputs.map((entry) => {
                const filename = entry.name || entry.path.split(/[\\/]/).filter(Boolean).pop() || entry.path;
                return (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="tasks-v2-output-card"
                      onClick={() => onNavigate("outputs")}
                      title={entry.path}
                    >
                      <span className="tasks-v2-output-name">{filename}</span>
                      {entry.modifiedAt ? (
                        <span className="tasks-v2-output-time">{formatShortTime(entry.modifiedAt)}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {tasks.length === 0 ? (
          <div className="tasks-v2-empty-hero">
            <div className="tasks-v2-empty-hero-mark" aria-hidden="true">
              <Plus size={28} strokeWidth={1.5} />
            </div>
            <h2>No tasks yet</h2>
            <p>Tasks are missions you hand to AIOS agents to run on their own. Create one to see it land in the kanban.</p>
            <button
              type="button"
              className="btn-pill"
              onClick={() => setCreateOpen(true)}
              disabled={saving}
            >
              <Plus size={14} /> Create your first task
            </button>
          </div>
        ) : (
          <KanbanView tasks={filteredTasks} agents={agents} onOpen={openDetails} />
        )}
      </div>

      {createOpen && (
        <CreateTaskModal
          agents={agents}
          agentId={newAgentId}
          setAgentId={setNewAgentId}
          newMessage={newMessage}
          setNewMessage={setNewMessage}
          newPriority={newPriority}
          setNewPriority={setNewPriority}
          teamMode={newTeamMode}
          setTeamMode={setNewTeamMode}
          saving={saving}
          onCancel={() => setCreateOpen(false)}
          onCreate={handleCreateTask}
        />
      )}

      {detailsOpen && detailsTask && (
        <TaskDetailsModal
          task={detailsTask}
          agents={agents}
          allTasks={tasks}
          actionLoading={detailsActionLoading}
          actionError={detailsActionError}
          actionNote={detailsActionNote}
          setActionNote={setDetailsActionNote}
          onClose={closeDetails}
          onAction={handleTaskAction}
          onDelete={handleDeleteTask}
          onOpenTask={openDetails}
        />
      )}

      <ConfirmModal
        open={!!confirmDeleteId}
        title="Delete task?"
        message="Are you sure you want to delete this task? This action cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </section>
  );
}

function KanbanView({
  tasks,
  agents,
  onOpen
}: {
  tasks: TaskInfo[];
  agents: AgentInfo[];
  onOpen: (task: TaskInfo) => void;
}) {
  return (
    <div className="tasks-v2-kanban">
      {KANBAN_COLUMNS.map((column) => {
        const columnTasks = tasks.filter((t) => {
          if (!column.statuses.has(t.status)) return false;
          // In the Completed column, only the top-level (main-agent) task
          // surfaces. The parent's synthesis result already rolls up every
          // child's work, and the user can drill into the parent to see the
          // per-child breakdown via the "Delegated sub-tasks" section in the
          // details modal. Other columns keep every task visible so users
          // can watch children running in real time.
          if (column.id === "completed" && t.parent_task_id) return false;
          return true;
        });
        return (
          <div key={column.id} className={`tasks-v2-column tone-${column.tone}`}>
            <div className="tasks-v2-column-head">
              <span className="tasks-v2-column-dot" aria-hidden="true" />
              <h3>{column.title}</h3>
              <span className="tasks-v2-column-count">{columnTasks.length}</span>
            </div>
            <div className="tasks-v2-column-body">
              {columnTasks.length === 0 ? (
                <div className="tasks-v2-column-empty">Nothing here.</div>
              ) : (
                columnTasks.map((task) => {
                  const parent = task.parent_task_id
                    ? tasks.find((t) => t.id === task.parent_task_id)
                    : null;
                  // For top-level parent tasks, find their child tasks so
                  // the card can render the multi-agent team strip.
                  const children = !task.parent_task_id
                    ? tasks.filter((t) => t.parent_task_id === task.id)
                    : [];
                  return (
                    <TaskCard
                      key={task.id}
                      task={task}
                      agentName={agentNameById(agents, task.agent_id)}
                      parentAgentName={parent ? agentNameById(agents, parent.agent_id) : null}
                      children={children}
                      agents={agents}
                      onClick={() => onOpen(task)}
                    />
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  agentName,
  parentAgentName,
  children,
  agents,
  onClick
}: {
  task: TaskInfo;
  agentName: string;
  parentAgentName: string | null;
  children?: TaskInfo[];
  agents?: AgentInfo[];
  onClick: () => void;
}) {
  const bucket = statusBucket(task.status);
  const hasTeam = (children?.length ?? 0) > 0;
  const round = Math.max(1, Number(task.synthesis_round) || 1);
  const doneCount = (children ?? []).filter((c) =>
    c.status === "completed" || c.status === "failed" || c.status === "cancelled"
  ).length;
  // Cap the displayed pill row at 8; show +N for the overflow.
  const visibleChildren = (children ?? []).slice(0, 8);
  const overflowCount = (children?.length ?? 0) - visibleChildren.length;
  return (
    <article className={`tasks-v2-card tone-${bucket}`} onClick={onClick}>
      <h4 className="tasks-v2-card-title">{task.name}</h4>
      {parentAgentName && (
        <p className="tasks-v2-card-lineage">↳ from {parentAgentName}</p>
      )}
      <p className="tasks-v2-card-summary">{summarizeTaskNote(task)}</p>
      {hasTeam ? (
        <div className="tasks-v2-card-team-strip">
          <span className="tasks-v2-card-team-pill">
            <span className="tasks-v2-card-team-icon" aria-hidden="true">⚙</span>
            Round {round} · {doneCount} / {children?.length ?? 0} done
          </span>
          <div className="tasks-v2-card-team-specialists">
            {visibleChildren.map((c) => {
              const childBucket = statusBucket(c.status);
              const childName = agents ? agentNameById(agents, c.agent_id) : c.agent_id;
              return (
                <span key={c.id} className={`tasks-v2-card-specialist-pill tone-${childBucket}`} title={childName}>
                  <span className="tasks-v2-card-specialist-dot" aria-hidden="true" />
                  {childName}
                </span>
              );
            })}
            {overflowCount > 0 ? (
              <span className="tasks-v2-card-specialist-pill tone-queued">+{overflowCount}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      {hasTeam && task.status === "completed" && task.result ? (
        <div className="tasks-v2-card-result-preview">
          <span className="tasks-v2-card-result-preview-label">Synthesized result</span>
          {task.result.trim().slice(0, 160)}{task.result.trim().length > 160 ? "…" : ""}
        </div>
      ) : null}
      <div className="tasks-v2-card-foot">
        <div className="tasks-v2-card-assignee">
          <span className="tasks-v2-avatar" aria-hidden="true">
            {agentName.charAt(0).toUpperCase()}
          </span>
          <span>{agentName}</span>
        </div>
        <span className="tasks-v2-card-time">{formatShortTime(task.created_at)}</span>
      </div>
      <span className={`tasks-v2-status-pill tone-${bucket}`}>{formatStatusLabel(task.status)}</span>
    </article>
  );
}

function CreateTaskModal({
  agents,
  agentId,
  setAgentId,
  newMessage,
  setNewMessage,
  newPriority,
  setNewPriority,
  teamMode,
  setTeamMode,
  saving,
  onCancel,
  onCreate
}: {
  agents: AgentInfo[];
  agentId: string;
  setAgentId: (s: string) => void;
  newMessage: string;
  setNewMessage: (s: string) => void;
  newPriority: number;
  setNewPriority: (n: number) => void;
  teamMode: boolean;
  setTeamMode: (b: boolean) => void;
  saving: boolean;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="detail-modal-overlay" onClick={() => !saving && onCancel()}>
      <div className="detail-modal-card tasks-v2-modal" onClick={(e) => e.stopPropagation()}>
        <header className="detail-modal-head">
          <div className="detail-modal-head-left">
            <span className="detail-modal-icon"><Plus size={15} /></span>
            <div>
              <p className="detail-modal-eyebrow">Create task</p>
              <h2>New mission</h2>
            </div>
          </div>
          <button className="detail-modal-close" onClick={onCancel} aria-label="Close"><X size={16} /></button>
        </header>

        <div className="detail-modal-body tasks-v2-modal-body">
          <div className="tasks-v2-field">
            <span className="tasks-v2-field-label">Mode</span>
            <div className="tasks-v2-mode-toggle" role="tablist">
              <button
                type="button"
                role="tab"
                className={`tasks-v2-mode-option ${!teamMode ? "is-active" : ""}`}
                onClick={() => setTeamMode(false)}
                disabled={saving}
              >
                <strong>Solo</strong>
                <span>One agent works on it</span>
              </button>
              <button
                type="button"
                role="tab"
                className={`tasks-v2-mode-option ${teamMode ? "is-active" : ""}`}
                onClick={() => setTeamMode(true)}
                disabled={saving}
              >
                <strong>Team</strong>
                <span>CEO routes to multiple specialists in parallel</span>
              </button>
            </div>
          </div>

          {!teamMode ? (
            <label className="tasks-v2-field">
              <span className="tasks-v2-field-label">Assign to</span>
              <select
                className="tasks-v2-field-input"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                disabled={saving}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.role}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="tasks-v2-field tasks-v2-team-hint">
              <span className="tasks-v2-field-label">Routing</span>
              <p className="tasks-v2-field-hint">
                CEO will decompose into sub-tasks, assign each to the right specialist,
                run them in parallel, and synthesize a final answer. Up to 3 rounds if
                needed for big tasks.
              </p>
            </div>
          )}

          <label className="tasks-v2-field">
            <span className="tasks-v2-field-label">Task instructions</span>
            <textarea
              className="tasks-v2-field-textarea"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              placeholder="Describe the task…"
              disabled={saving}
            />
          </label>

          <label className="tasks-v2-field">
            <span className="tasks-v2-field-label">Priority</span>
            <select
              className="tasks-v2-field-input"
              value={newPriority}
              onChange={(e) => setNewPriority(Number(e.target.value) || 3)}
              disabled={saving}
            >
              <option value={5}>5 (highest)</option>
              <option value={4}>4</option>
              <option value={3}>3 (normal)</option>
              <option value={2}>2</option>
              <option value={1}>1 (lowest)</option>
            </select>
          </label>
        </div>

        <footer className="detail-modal-footer">
          <button className="button button-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
          <button
            className="button button-primary"
            onClick={onCreate}
            disabled={saving || !newMessage.trim()}
          >
            {saving ? "Creating…" : "Create task"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function TaskDetailsModal({
  task,
  agents,
  allTasks,
  actionLoading,
  actionError,
  actionNote,
  setActionNote,
  onClose,
  onAction,
  onDelete,
  onOpenTask
}: {
  task: TaskInfo;
  agents: AgentInfo[];
  allTasks: TaskInfo[];
  actionLoading: boolean;
  actionError: string;
  actionNote: string;
  setActionNote: (v: string) => void;
  onClose: () => void;
  onAction: (action: string) => void;
  onDelete: (taskId: string) => void;
  onOpenTask: (task: TaskInfo) => void;
}) {
  const childTasks = useMemo(
    () => allTasks.filter((t) => t.parent_task_id === task.id),
    [allTasks, task.id]
  );
  const parentTask = useMemo(
    () => (task.parent_task_id ? allTasks.find((t) => t.id === task.parent_task_id) || null : null),
    [allTasks, task.parent_task_id]
  );
  const bucket = statusBucket(task.status);
  const showActions =
    task.status === "blocked" ||
    task.status === "awaiting_connection" ||
    task.status === "awaiting_approval" ||
    task.status === "failed";

  const actionPlaceholder =
    task.status === "awaiting_approval"
      ? "Describe any changes the agent should make, or leave blank to approve as-is."
      : task.status === "awaiting_connection"
        ? "Optional update for the next run."
        : task.status === "blocked"
          ? "Describe what changed so the task can move again."
          : task.status === "failed"
            ? "Optional guidance for the retry."
            : "Optional operator note.";

  const retryLabel =
    task.status === "blocked"
      ? "Resolve and retry"
      : task.status === "awaiting_connection"
        ? "Retry after connect"
        : task.status === "failed"
          ? "Retry with guidance"
          : "Retry task";

  const blockedRetryNeedsInput = task.status === "blocked" && !actionNote.trim();
  const changesNeedsInput = task.status === "awaiting_approval" && !actionNote.trim();
  const comments = task.narrative || [];
  const agentName = agentNameById(agents, task.agent_id);

  return (
    <div className="detail-modal-overlay" onClick={() => !actionLoading && onClose()}>
      <div className="detail-modal-card detail-modal-large tasks-v2-modal" onClick={(e) => e.stopPropagation()}>
        <header className="detail-modal-head">
          <div className="detail-modal-head-left">
            <span className="detail-modal-icon"><FileText size={15} /></span>
            <div>
              <p className="detail-modal-eyebrow">Task details</p>
              <h2>{task.name}</h2>
            </div>
          </div>
          <button className="detail-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>

        <div className="detail-modal-body tasks-v2-details-body">
          {parentTask && (
            <button
              type="button"
              className="tasks-v2-breadcrumb"
              onClick={() => onOpenTask(parentTask)}
            >
              ← Back to parent: {agentNameById(agents, parentTask.agent_id)} — {parentTask.name.slice(0, 60)}
            </button>
          )}

          <section className="tasks-v2-request">
            <span className="eyebrow">Request</span>
            <p>{task.message || "—"}</p>
          </section>

          <section className="tasks-v2-meta-grid">
            <div className="tasks-v2-meta">
              <span className="eyebrow">Status</span>
              <span className={`tasks-v2-status-pill tone-${bucket}`}>{formatStatusLabel(task.status)}</span>
            </div>
            <div className="tasks-v2-meta">
              <span className="eyebrow">Assigned to</span>
              <strong>{agentName}</strong>
            </div>
            <div className="tasks-v2-meta">
              <span className="eyebrow">Priority</span>
              <strong>P{task.priority}</strong>
            </div>
            <div className="tasks-v2-meta">
              <span className="eyebrow">Last updated</span>
              <strong>{formatDetailTimestamp(task.updated_at)}</strong>
            </div>
          </section>

          {childTasks.length > 0 && (
            <section className="tasks-v2-subtasks">
              <div className="tasks-v2-subtasks-head">
                <span className="eyebrow">Delegated sub-tasks ({childTasks.length})</span>
                {(task.synthesis_round || 0) > 0 ? (
                  <span className="tasks-v2-subtasks-round">
                    Synthesis round {task.synthesis_round} of 3
                  </span>
                ) : null}
              </div>
              <div className="tasks-v2-subtasks-list">
                {[...childTasks].sort((a, b) =>
                  (a.created_at || "").localeCompare(b.created_at || "")
                ).map((child) => {
                  const childBucket = statusBucket(child.status);
                  return (
                    <button
                      type="button"
                      key={child.id}
                      className={`tasks-v2-subtask tone-${childBucket}`}
                      onClick={() => onOpenTask(child)}
                    >
                      <span className={`tasks-v2-status-pill tone-${childBucket}`}>
                        {formatStatusLabel(child.status)}
                      </span>
                      <span className="tasks-v2-subtask-agent">
                        {agentNameById(agents, child.agent_id)}
                      </span>
                      <span className="tasks-v2-subtask-name">{child.name}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {task.result && (
            <section className="tasks-v2-request">
              <span className="eyebrow">Result</span>
              <p style={{ whiteSpace: "pre-wrap" }}>{task.result}</p>
            </section>
          )}

          {showActions && (
            <section className="tasks-v2-action-box">
              <header>
                <AlertTriangle size={14} />
                <strong>{task.status === "awaiting_approval" ? "Review required" : "Action required"}</strong>
              </header>
              <p>
                {task.status === "awaiting_approval" &&
                  (task.blocked_reason
                    ? `The agent is ready to: ${task.blocked_reason}. Review the draft above, then approve or request changes.`
                    : "The agent has prepared a draft above and is waiting for your review before executing.")}
                {task.status === "awaiting_connection" &&
                  `${task.needs_connector ? `${task.needs_connector} isn't connected.` : "A required connector isn't connected."} Retry after connecting it.`}
                {task.status === "blocked" &&
                  (task.blocked_reason || "The agent has a question for you before it can keep going. Answer below and retry.")}
                {task.status === "failed" && "The last run failed. Provide guidance for the retry."}
              </p>
              <textarea
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
                placeholder={actionPlaceholder}
                disabled={actionLoading}
              />
              {actionError && <div className="tasks-v2-error">{actionError}</div>}
              <div className="tasks-v2-action-buttons">
                {task.status === "awaiting_approval" ? (
                  <>
                    <button
                      className="button button-primary compact"
                      disabled={actionLoading}
                      onClick={() => onAction("approve")}
                    >Approve &amp; continue</button>
                    <button
                      className="button button-ghost compact"
                      disabled={actionLoading || changesNeedsInput}
                      onClick={() => onAction("retry")}
                      title={changesNeedsInput ? "Describe what to change in the box above first." : undefined}
                    >Request changes</button>
                    <button
                      className="button button-danger-link compact"
                      disabled={actionLoading}
                      onClick={() => onAction("reject")}
                    >Cancel task</button>
                  </>
                ) : (
                  <button
                    className="button button-primary compact"
                    disabled={actionLoading || blockedRetryNeedsInput}
                    onClick={() => onAction("retry")}
                  >
                    {retryLabel}
                  </button>
                )}
              </div>
            </section>
          )}

          <section className="tasks-v2-narrative">
            <span className="eyebrow">Agent narrative</span>
            {comments.length === 0 ? (
              <div className="tasks-v2-narrative-empty">
                <MessageSquare size={22} aria-hidden="true" />
                <p>{task.status === "pending" ? "Waiting for the runner to start this task." : "No narrative logs yet."}</p>
              </div>
            ) : (
              <div className="tasks-v2-narrative-list">
                {comments.map((c, idx) => {
                  const kind = c.kind || "worker";
                  const agentId = c.agentId || "agent";
                  return (
                    <div key={idx} className={`tasks-v2-comment kind-${kind}`}>
                      <header>
                        <span className="tasks-v2-avatar small" aria-hidden="true">
                          {agentId.charAt(0).toUpperCase()}
                        </span>
                        <strong>{agentId}</strong>
                        <span className="tasks-v2-comment-kind">{kind}</span>
                        <span className="tasks-v2-comment-time">{formatDetailTimestamp(c.ts)}</span>
                      </header>
                      <p>{c.text || ""}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <footer className="detail-modal-footer">
          <div className="detail-modal-footer-left">
            <button className="button button-ghost" onClick={onClose}>Close</button>
            <button className="button button-danger-link" onClick={() => onDelete(task.id)}>Delete task</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
