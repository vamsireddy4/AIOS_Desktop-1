import type { WorkflowProgressEvent, WorkflowAgentProgress } from "../types";

// Workflow progress merge. host.py emits three event shapes off the CLI's
// dynamic-workflow stream: a rich task_progress (phase + cumulative deduped
// agent roster) interleaved with sparse task_notification / single-agent
// updates that carry no phase and no agents. Replacing state wholesale on every
// event made the activity row flicker between the full roster ("Lookup · 3
// agents running") and a thin label, so we merge each event into prior state
// instead — sparse events can only ADD information, never erase it.

// Mirror of host.py's active_states set: an agent that hasn't reached a terminal
// state still counts toward "running".
const ACTIVE_AGENT_STATES = new Set(["start", "progress", "queued", "running", ""]);

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

// Reproduces host.py's "N agents running" / "N agent(s)" wording so the UI reads
// the same whether the label came straight off a task_progress event or was
// recomputed here after a sparse event.
function runPart(running: number, total: number): string {
  if (running) {
    return `${running} agent${running !== 1 ? "s" : ""} running`;
  }
  return `${total} agent${total !== 1 ? "s" : ""}`;
}

function countRunning(agents: WorkflowAgentProgress[]): number {
  return agents.filter((agent) => ACTIVE_AGENT_STATES.has(agent.state)).length;
}

export function mergeWorkflowProgress(
  prev: WorkflowProgressEvent | null,
  next: WorkflowProgressEvent,
): WorkflowProgressEvent {
  if (!prev) {
    // First event for the run: normalize so downstream always has running/total
    // when an agent roster is present, and a label computed by the same rules a
    // later merge would use.
    return mergeWorkflowProgress(
      { state: next.state, label: "" },
      next,
    );
  }

  const state = next.state;

  // The agent array on a task_progress event is the cumulative deduped roster;
  // a sparse event omits it entirely. Keep the prior roster unless the incoming
  // one actually carries agents.
  const agents =
    next.agents && next.agents.length > 0 ? next.agents : prev.agents;

  const phase = isDefined(next.phase) ? next.phase : prev.phase;
  const phaseIndex = isDefined(next.phaseIndex) ? next.phaseIndex : prev.phaseIndex;
  const phaseCount = isDefined(next.phaseCount) ? next.phaseCount : prev.phaseCount;

  const total = isDefined(next.total)
    ? next.total
    : agents
      ? agents.length
      : prev.total;
  const running = isDefined(next.running)
    ? next.running
    : agents
      ? countRunning(agents)
      : prev.running;

  const name = isDefined(next.name) ? next.name : prev.name;
  const description = isDefined(next.description) ? next.description : prev.description;
  const summary = isDefined(next.summary) ? next.summary : prev.summary;
  const tokens = isDefined(next.tokens) ? next.tokens : prev.tokens;
  const toolUses = isDefined(next.toolUses) ? next.toolUses : prev.toolUses;
  const durationMs = isDefined(next.durationMs) ? next.durationMs : prev.durationMs;

  // Prefer a stable computed label over a sparse next.label. A mid-run update
  // that only carries a terse label must not collapse the visible "phase · N
  // agents running" line.
  let label: string;
  if (state === "completed") {
    label = next.summary || next.label || "Workflow complete";
  } else if (state === "started" && !phase) {
    label = next.label || `Starting workflow${name ? `: ${name}` : ""}`;
  } else if (phase && agents && agents.length > 0) {
    label = `${phase} · ${runPart(running ?? 0, total ?? agents.length)}`;
  } else {
    label = next.label || prev.label;
  }

  return {
    state,
    label,
    name,
    description,
    phase,
    phaseIndex,
    phaseCount,
    agents,
    running,
    total,
    summary,
    tokens,
    toolUses,
    durationMs,
  };
}
