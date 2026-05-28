import React from "react";
import { Users, X, Loader2, Check, AlertTriangle, Clock } from "lucide-react";
import type { ActiveTeam, SpecialistStatus } from "../types";

interface TeamProgressBannerProps {
  team: ActiveTeam | null | undefined;
  onAbort: () => void;
  onDismiss: () => void;
}

export function TeamProgressBanner({ team, onAbort, onDismiss }: TeamProgressBannerProps) {
  if (!team) return null;
  const phase = team.phase;
  const cost = team.costUsd ? `~$${team.costUsd.toFixed(2)}` : null;
  const tokens = formatTokens(team.tokensSpent);

  return (
    <div className={`aios-team-banner status-${phase}`} data-testid="team-banner">
      <div className="aios-team-banner-icon">
        {phase === "running" || phase === "decomposing" || phase === "aggregating" ? (
          <span className="aios-goal-pulse" aria-hidden="true" />
        ) : (
          <Users size={14} />
        )}
      </div>
      <div className="aios-team-banner-body">
        <div className="aios-team-banner-line1">
          <span className="aios-team-banner-eyebrow">{phaseLabel(phase, team.specialists.length)}</span>
          <span className="aios-team-banner-task" title={team.task}>{team.task}</span>
        </div>
        {team.specialists.length > 0 ? (
          <ul className="aios-team-banner-list">
            {team.specialists.map((s) => (
              <li key={`${s.agentId}-${s.subtask.slice(0, 24)}`} className={`aios-team-banner-specialist status-${s.status}`}>
                <span className="aios-team-banner-specialist-icon" aria-hidden="true">
                  {iconFor(s.status)}
                </span>
                <span className="aios-team-banner-specialist-name">{s.agentName}</span>
                <span className="aios-team-banner-specialist-task">{s.subtask}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="aios-team-banner-meta">
          <span>{tokens} tokens</span>
          {cost ? <><span>·</span><span>{cost}</span></> : null}
          {team.errorMessage ? <><span>·</span><span className="aios-team-banner-error">{team.errorMessage}</span></> : null}
        </div>
      </div>
      <div className="aios-team-banner-actions">
        {phase === "decomposing" || phase === "running" || phase === "aggregating" ? (
          <button
            type="button"
            className="aios-goal-banner-button"
            onClick={onAbort}
            title="Stop the team task"
          >
            Stop
          </button>
        ) : null}
        <button
          type="button"
          className="aios-goal-banner-close"
          onClick={onDismiss}
          title="Dismiss banner"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function phaseLabel(phase: ActiveTeam["phase"], specialistCount: number): string {
  switch (phase) {
    case "decomposing": return "Decomposing task";
    case "running": return `${specialistCount} specialists working`;
    case "aggregating": return "Synthesizing final answer";
    case "done": return "Team task complete";
    case "aborted": return "Team task aborted";
    case "error": return "Team task failed";
    default: return "Team task";
  }
}

function iconFor(status: SpecialistStatus): React.ReactNode {
  switch (status) {
    case "pending": return <Clock size={11} />;
    case "running": return <Loader2 size={11} className="spin" />;
    case "done": return <Check size={11} />;
    case "failed": return <AlertTriangle size={11} />;
    case "timeout": return <AlertTriangle size={11} />;
    default: return <Clock size={11} />;
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
