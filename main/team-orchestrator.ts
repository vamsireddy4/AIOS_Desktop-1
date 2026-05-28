// Team orchestrator — implements `/team <task>` in chat. Inspired by OpenClaw's
// coordinator + sub-agents pattern: a coordinator decomposes the task, N
// specialists run in PARALLEL with isolated sessions, an aggregator
// synthesizes a clean final answer.
//
// Phases:
//   1. Coordinator (Haiku, 1 call, ~3-5s) — decompose into {specialistId, subtask}
//   2. Fan-out (Sonnet, N calls in parallel, ~30s-3min) — each specialist
//      runs in own session with own system_prompt overlay
//   3. Aggregator (Sonnet, 1 call, ~5-15s) — synthesize specialist outputs

import { randomUUID } from "node:crypto";
import type { PythonHost } from "./python-host";
import { log } from "./logger";

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  effective_prompt: string;
}

export interface TeamSpecialistArtifact {
  kind: "plan" | "output";
  path: string;
  filename: string;
}

export interface TeamSpecialistResult {
  agentId: string;
  agentName: string;
  subtask: string;
  status: "pending" | "running" | "done" | "failed" | "timeout";
  reason?: string;
  durationMs?: number;
  reply?: string;
  artifacts?: TeamSpecialistArtifact[];
}

export interface TeamProgress {
  sessionId: string;
  task: string;
  phase: "decomposing" | "running" | "aggregating" | "done" | "aborted" | "error";
  specialists: TeamSpecialistResult[];
  startedAt: string;
  tokensSpent: number;
  costUsd: number;
  errorMessage?: string;
}

export interface TeamSpecialistMessage {
  sessionId: string;
  agentId: string;
  agentName: string;
  subtask: string;
  reply: string;
  artifacts: TeamSpecialistArtifact[];
}

export interface TeamAggregateMessage {
  sessionId: string;
  reply: string;
}

export type TeamEventBroadcast = (event:
  | { event: "team_progress"; data: TeamProgress }
  | { event: "team_specialist_message"; data: TeamSpecialistMessage }
  | { event: "team_aggregate_message"; data: TeamAggregateMessage }
) => void;

const MAX_SPECIALISTS = 6;
const SPECIALIST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per specialist
const MAX_TOKENS = 500_000;
const MAX_WALL_MS = 60 * 60 * 1000; // 1 hour absolute cap
const COORDINATOR_MODEL = "haiku";
const SPECIALIST_MODEL = "sonnet";
const AGGREGATOR_MODEL = "sonnet";

interface ActiveTeamRun {
  sessionId: string;
  runId: string;
  abort: AbortController;
  promise: Promise<void>;
}
const activeRuns = new Map<string, ActiveTeamRun>();

export function isTeamRunning(sessionId: string): boolean {
  return activeRuns.has(sessionId);
}

export async function abortTeamTask(sessionId: string, broadcast?: TeamEventBroadcast | null): Promise<void> {
  const run = activeRuns.get(sessionId);
  if (!run) return;
  run.abort.abort();
  try {
    await run.promise;
  } catch {
    /* swallow */
  }
  activeRuns.delete(sessionId);
}

export interface StartTeamTaskArgs {
  sessionId: string;
  task: string;
  agents: AgentSummary[];
  claudePath: string;
  host: PythonHost;
  broadcast: TeamEventBroadcast;
}

export async function startTeamTask({
  sessionId,
  task,
  agents,
  claudePath,
  host,
  broadcast,
}: StartTeamTaskArgs): Promise<{ ok: boolean; reason?: string }> {
  if (!sessionId) return { ok: false, reason: "missing_session_id" };
  const trimmed = task.trim();
  if (!trimmed) return { ok: false, reason: "empty_task" };
  if (!claudePath) return { ok: false, reason: "claude_not_configured" };
  if (!agents || agents.length === 0) return { ok: false, reason: "no_agents" };

  if (activeRuns.has(sessionId)) {
    await abortTeamTask(sessionId, broadcast);
  }

  const runId = randomUUID();
  const abort = new AbortController();
  const promise = runTeam({ sessionId, task: trimmed, agents, claudePath, host, broadcast, signal: abort.signal, runId });
  activeRuns.set(sessionId, { sessionId, runId, abort, promise });

  try {
    await promise;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    const current = activeRuns.get(sessionId);
    if (current?.runId === runId) activeRuns.delete(sessionId);
  }
}

async function runTeam({
  sessionId,
  task,
  agents,
  claudePath,
  host,
  broadcast,
  signal,
  runId,
}: {
  sessionId: string;
  task: string;
  agents: AgentSummary[];
  claudePath: string;
  host: PythonHost;
  broadcast: TeamEventBroadcast;
  signal: AbortSignal;
  runId: string;
}): Promise<void> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let tokensSpent = 0;
  let costUsd = 0;
  let specialists: TeamSpecialistResult[] = [];

  const publish = (
    phase: TeamProgress["phase"],
    errorMessage?: string
  ) => {
    if (activeRuns.get(sessionId)?.runId !== runId) return; // stale
    try {
      broadcast({
        event: "team_progress",
        data: {
          sessionId,
          task,
          phase,
          specialists: specialists.map((s) => ({ ...s, reply: undefined })), // keep banner light
          startedAt,
          tokensSpent,
          costUsd,
          errorMessage,
        },
      });
    } catch { /* swallow */ }
  };

  const guardCaps = (): { exceeded: boolean; reason?: string } => {
    if (tokensSpent >= MAX_TOKENS) return { exceeded: true, reason: `Reached token cap (${MAX_TOKENS.toLocaleString()}).` };
    if (Date.now() - startMs >= MAX_WALL_MS) return { exceeded: true, reason: "Reached 1-hour cap." };
    return { exceeded: false };
  };

  // ---- PHASE 1: COORDINATOR (decomposition) ----
  publish("decomposing");

  const agentDirectory = agents
    .map((a) => `- ${a.id} (${a.name}, ${a.role}): ${(a.effective_prompt || "").slice(0, 200)}`)
    .join("\n");

  const coordinatorPrompt =
    `You are coordinating a team of specialists for a user task.\n\n` +
    `User task: ${task}\n\n` +
    `Available specialists:\n${agentDirectory}\n\n` +
    `Decompose this task into the SMALLEST set of independent sub-tasks the ` +
    `specialists should work on in parallel. Prefer fewer specialists; only include ` +
    `a specialist if their angle genuinely adds value. Maximum ${MAX_SPECIALISTS} specialists.\n\n` +
    `Reply with ONLY a JSON object on a single line, no other text, no markdown ` +
    `fences:\n` +
    `{"decomposition": [{"specialistId": "<id from list above>", "subtask": "<concrete instruction for that specialist>", "why": "<one sentence>"}]}`;

  let decomposition: { specialistId: string; subtask: string; why: string }[] = [];

  try {
    const result = (await host.invoke("run_task", {
      prompt: coordinatorPrompt,
      claudePath,
      model: COORDINATOR_MODEL,
      permissionMode: "bypassPermissions",
    })) as any;
    if (signal.aborted) { publish("aborted"); return; }
    const data = result?.data ?? result;
    const reply = typeof data?.response === "string" ? data.response : "";
    if (typeof data?.costUsd === "number") {
      costUsd += data.costUsd;
      tokensSpent += Math.round(data.costUsd * 67_000);
    }
    decomposition = parseDecomposition(reply, agents);
  } catch (err) {
    log("team-orchestrator", `coordinator failed: ${err instanceof Error ? err.message : String(err)}`);
    publish("error", `Coordinator failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (decomposition.length === 0) {
    publish("error", "Coordinator returned no specialists. Try rephrasing the task or @-mention a specific specialist.");
    return;
  }

  // Truncate to cap
  decomposition = decomposition.slice(0, MAX_SPECIALISTS);

  // Initialize specialists in pending state
  specialists = decomposition.map((d) => {
    const agent = agents.find((a) => a.id === d.specialistId) ?? agents[0];
    return {
      agentId: agent.id,
      agentName: agent.name,
      subtask: d.subtask,
      status: "running" as const,
      reason: d.why,
    };
  });

  const caps1 = guardCaps();
  if (caps1.exceeded) { publish("aborted", caps1.reason); return; }
  publish("running");

  // ---- PHASE 2: PARALLEL FAN-OUT ----
  const fanout = specialists.map(async (spec, idx) => {
    const turnStart = Date.now();
    if (signal.aborted) {
      specialists[idx].status = "failed";
      specialists[idx].durationMs = Date.now() - turnStart;
      return;
    }
    const agent = agents.find((a) => a.id === spec.agentId);
    if (!agent) {
      specialists[idx].status = "failed";
      return;
    }
    try {
      const result = await Promise.race([
        host.invoke("run_task", {
          prompt: spec.subtask,
          claudePath,
          model: SPECIALIST_MODEL,
          systemPrompt: agent.effective_prompt,
          permissionMode: "bypassPermissions",
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("specialist_timeout")), SPECIALIST_TIMEOUT_MS)),
      ]) as any;
      const data = result?.data ?? result;
      const reply = typeof data?.response === "string" ? data.response : "";
      if (typeof data?.costUsd === "number") {
        costUsd += data.costUsd;
        tokensSpent += Math.round(data.costUsd * 67_000);
      }
      const artifacts = parseArtifacts(reply);
      const cleaned = stripMarkers(reply);
      specialists[idx].status = "done";
      specialists[idx].reply = cleaned;
      specialists[idx].artifacts = artifacts;
      specialists[idx].durationMs = Date.now() - turnStart;
      // Emit the per-specialist message as it lands so the chat thread
      // updates progressively, not all at once at the end.
      try {
        broadcast({
          event: "team_specialist_message",
          data: {
            sessionId,
            agentId: spec.agentId,
            agentName: spec.agentName,
            subtask: spec.subtask,
            reply: cleaned,
            artifacts,
          },
        });
      } catch { /* swallow */ }
      publish("running");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      specialists[idx].status = message === "specialist_timeout" ? "timeout" : "failed";
      specialists[idx].reason = `${specialists[idx].reason ?? ""} — ${message}`.trim();
      specialists[idx].durationMs = Date.now() - turnStart;
      log("team-orchestrator", `specialist ${spec.agentName} failed: ${message}`);
      publish("running");
    }
  });

  await Promise.allSettled(fanout);

  if (signal.aborted) { publish("aborted"); return; }
  const caps2 = guardCaps();
  if (caps2.exceeded) { publish("aborted", caps2.reason); return; }

  // ---- PHASE 3: AGGREGATOR ----
  publish("aggregating");

  const successes = specialists.filter((s) => s.status === "done" && s.reply);
  if (successes.length === 0) {
    publish("error", "All specialists failed. See banner for individual statuses.");
    return;
  }

  const aggregatorBody = successes
    .map((s) => {
      const truncated = (s.reply ?? "").length > 3000 ? (s.reply ?? "").slice(0, 3000) + "\n…(truncated)" : s.reply ?? "";
      return `### ${s.agentName} (${s.subtask})\n\n${truncated}`;
    })
    .join("\n\n---\n\n");

  const aggregatorPrompt =
    `You are synthesizing a team's work for the user.\n\n` +
    `Original user task: ${task}\n\n` +
    `Each specialist's reply below. Produce ONE clean, unified response to the user. ` +
    `Cite which specialist contributed each section if natural. Drop their fluff; keep their substance.\n\n` +
    `${aggregatorBody}\n\n` +
    `Now write the unified response:`;

  try {
    const result = (await host.invoke("run_task", {
      prompt: aggregatorPrompt,
      claudePath,
      model: AGGREGATOR_MODEL,
      permissionMode: "bypassPermissions",
    })) as any;
    if (signal.aborted) { publish("aborted"); return; }
    const data = result?.data ?? result;
    const reply = typeof data?.response === "string" ? data.response : "";
    if (typeof data?.costUsd === "number") {
      costUsd += data.costUsd;
      tokensSpent += Math.round(data.costUsd * 67_000);
    }
    const cleaned = stripMarkers(reply);
    try {
      broadcast({
        event: "team_aggregate_message",
        data: { sessionId, reply: cleaned },
      });
    } catch { /* swallow */ }
    publish("done");
  } catch (err) {
    log("team-orchestrator", `aggregator failed: ${err instanceof Error ? err.message : String(err)}`);
    publish("error", `Aggregator failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseDecomposition(
  reply: string,
  agents: AgentSummary[]
): { specialistId: string; subtask: string; why: string }[] {
  // Try to extract a JSON object from the reply. Be permissive — Claude
  // sometimes wraps in fences or adds prose. Strip fences and trim before parse.
  const cleaned = reply
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  // Find first { and last } to extract object
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  const slice = cleaned.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    const arr = Array.isArray(parsed?.decomposition) ? parsed.decomposition : [];
    return arr
      .filter((d: any) =>
        d && typeof d.specialistId === "string" &&
        typeof d.subtask === "string" &&
        agents.some((a) => a.id === d.specialistId)
      )
      .map((d: any) => ({
        specialistId: String(d.specialistId),
        subtask: String(d.subtask).slice(0, 4000),
        why: String(d.why ?? "").slice(0, 200),
      }));
  } catch {
    return [];
  }
}

function parseArtifacts(response: string): TeamSpecialistArtifact[] {
  const out: TeamSpecialistArtifact[] = [];
  const re = /\[AIOS_ARTIFACT:\s*((?:plans|outputs)\/[A-Za-z0-9._\/-]+\.[A-Za-z0-9]+)\s*\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    const path = m[1];
    const filename = path.split("/").pop() ?? path;
    const kind: "plan" | "output" = path.startsWith("plans/") ? "plan" : "output";
    out.push({ kind, path, filename });
  }
  return out;
}

function stripMarkers(response: string): string {
  return response
    .replace(/\[AIOS_ARTIFACT:[^\]\r\n]+\]/gi, "")
    .replace(/\[AIOS_EXPORT_PDF:[^\]\r\n]+\]/gi, "")
    .replace(/\[AIOS_ASK:[^\]\r\n]+\]/gi, "")
    .replace(/\[AIOS_CONNECT:[^\]\r\n]+\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
