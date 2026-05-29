import { describe, it, expect } from "vitest";
import { mergeWorkflowProgress } from "../renderer/src/lib/workflow-progress";
import type { WorkflowProgressEvent } from "../renderer/src/types";

// Shapes mirror host.py:_workflow_event_from_system.
const started: WorkflowProgressEvent = {
  state: "started",
  name: "Lookup",
  description: "Find the contact",
  label: "Starting workflow: Lookup",
};

const richProgress: WorkflowProgressEvent = {
  state: "running",
  phase: "Lookup",
  phaseIndex: 0,
  phaseCount: 2,
  agents: [
    { label: "search", phase: "Lookup", state: "running" },
    { label: "read", phase: "Lookup", state: "running" },
    { label: "summarize", phase: "Lookup", state: "running" },
  ],
  running: 3,
  total: 3,
  description: "Working",
  label: "Lookup · 3 agents running",
};

// A task_notification carries no phase and no agents.
const sparseNotification: WorkflowProgressEvent = {
  state: "running",
  summary: "Still going",
  label: "Still going",
};

const completed: WorkflowProgressEvent = {
  state: "completed",
  summary: "Found the contact",
  tokens: 1200,
  toolUses: 4,
  durationMs: 8000,
  label: "Found the contact",
};

describe("mergeWorkflowProgress", () => {
  it("normalizes a null prev + first event", () => {
    const merged = mergeWorkflowProgress(null, richProgress);
    expect(merged.state).toBe("running");
    expect(merged.agents).toHaveLength(3);
    expect(merged.running).toBe(3);
    expect(merged.total).toBe(3);
    expect(merged.label).toBe("Lookup · 3 agents running");
  });

  it("keeps phase + agents when a sparse event arrives (no flicker)", () => {
    const afterRich = mergeWorkflowProgress(null, richProgress);
    const merged = mergeWorkflowProgress(afterRich, sparseNotification);

    // The sparse event has no agents/phase — they must survive untouched.
    expect(merged.agents).toEqual(richProgress.agents);
    expect(merged.phase).toBe("Lookup");
    expect(merged.phaseIndex).toBe(0);
    expect(merged.phaseCount).toBe(2);
    // Label stays the stable roster line, not the terse "Still going".
    expect(merged.label).toBe("Lookup · 3 agents running");
    // summary from the sparse event is still absorbed.
    expect(merged.summary).toBe("Still going");
  });

  it("never collapses running to 0 through a full -> sparse -> full sequence", () => {
    let state = mergeWorkflowProgress(null, richProgress);
    expect(state.running).toBe(3);

    state = mergeWorkflowProgress(state, sparseNotification);
    expect(state.running).toBe(3);
    expect(state.agents).toHaveLength(3);

    const secondPhase: WorkflowProgressEvent = {
      state: "running",
      phase: "Draft",
      phaseIndex: 1,
      phaseCount: 2,
      agents: [
        { label: "search", phase: "Lookup", state: "complete" },
        { label: "read", phase: "Lookup", state: "complete" },
        { label: "summarize", phase: "Lookup", state: "complete" },
        { label: "write", phase: "Draft", state: "running" },
      ],
      running: 1,
      total: 4,
      label: "Draft · 1 agent running",
    };
    state = mergeWorkflowProgress(state, secondPhase);
    expect(state.phase).toBe("Draft");
    expect(state.agents).toHaveLength(4);
    expect(state.running).toBe(1);
    expect(state.label).toBe("Draft · 1 agent running");
  });

  it("recomputes running/total from merged agents when the event omits them", () => {
    const afterRich = mergeWorkflowProgress(null, richProgress);
    const agentsOnly: WorkflowProgressEvent = {
      state: "running",
      phase: "Lookup",
      agents: [
        { label: "search", phase: "Lookup", state: "complete" },
        { label: "read", phase: "Lookup", state: "running" },
      ],
      label: "ignored",
    };
    const merged = mergeWorkflowProgress(afterRich, agentsOnly);
    expect(merged.total).toBe(2);
    expect(merged.running).toBe(1);
    expect(merged.label).toBe("Lookup · 1 agent running");
  });

  it("reaches a completed state with a sensible completion label", () => {
    let state = mergeWorkflowProgress(null, started);
    expect(state.label).toBe("Starting workflow: Lookup");

    state = mergeWorkflowProgress(state, richProgress);
    expect(state.label).toBe("Lookup · 3 agents running");

    state = mergeWorkflowProgress(state, completed);
    expect(state.state).toBe("completed");
    expect(state.label).toBe("Found the contact");
    // Terminal event metadata is absorbed; the prior roster is retained but the
    // label no longer advertises running agents.
    expect(state.tokens).toBe(1200);
    expect(state.toolUses).toBe(4);
    expect(state.durationMs).toBe(8000);
  });

  it("falls back to the completion default label when no summary is present", () => {
    const afterRich = mergeWorkflowProgress(null, richProgress);
    const bareComplete: WorkflowProgressEvent = { state: "completed", label: "" };
    const merged = mergeWorkflowProgress(afterRich, bareComplete);
    expect(merged.label).toBe("Workflow complete");
  });

  it("does not mutate its inputs", () => {
    const prev = mergeWorkflowProgress(null, richProgress);
    const prevSnapshot = JSON.parse(JSON.stringify(prev));
    const nextSnapshot = JSON.parse(JSON.stringify(sparseNotification));
    mergeWorkflowProgress(prev, sparseNotification);
    expect(prev).toEqual(prevSnapshot);
    expect(sparseNotification).toEqual(nextSnapshot);
  });
});
