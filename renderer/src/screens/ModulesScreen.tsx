import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Loader2,
  Lock,
  Plug,
  RefreshCw,
  Sparkles,
  Zap
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "../lib/api";
import type { ConnectionStatus, FilePreview, ModuleInfo } from "../types";

// Pretty display name for each connector slug. Short variants for the inline
// pills in the Modules screen (long names like "Google Analytics" overflow
// when DataOS lists 4 of them in one row). Keep in sync with
// ConnectorsScreen.tsx CONNECTOR_CATALOG.
const CONNECTOR_LABEL: Record<string, string> = {
  gmail: "Gmail",
  "google-calendar": "Calendar",
  slack: "Slack",
  clickup: "ClickUp",
  notion: "Notion",
  github: "GitHub",
  stripe: "Stripe",
  youtube: "YouTube",
  "google-analytics": "Analytics",
  "google-sheets": "Sheets",
  outlook: "Outlook",
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp",
  "whatsapp-personal": "WA Personal",
  twitter: "X",
  telegram: "Telegram",
  facebook: "Facebook",
  instagram: "Instagram",
  // v0.1.26 connectors expansion
  supabase: "Supabase",
  "google-drive": "Drive",
  airtable: "Airtable",
  firecrawl: "Firecrawl",
  discord: "Discord",
  onedrive: "OneDrive",
  exa: "Exa",
  elevenlabs: "11Labs",
  salesforce: "Salesforce",
  calendly: "Calendly",
  "google-meet": "Meet",
  zoho: "Zoho",
  dropbox: "Dropbox",
  heygen: "HeyGen",
  yousearch: "You.com",
  retellai: "Retell",
  canva: "Canva",
  "cal-com": "Cal.com",
  telnyx: "Telnyx",
  cloudflare: "Cloudflare",
  reddit: "Reddit",
  cloudinary: "Cloudinary",
  convex: "Convex",
  dockerhub: "Docker",
  excel: "Excel",
  "google-maps": "Maps"
};

type ConnectorStatusMap = Record<string, { connected: boolean; label: string | null }>;

const NAME_MAP: Record<string, string> = {
  "context-os": "ContextOS",
  "data-os": "DataOS",
  "intel-os": "IntelOS",
  "infra-os": "InfraOS",
  "productivity-os": "ProductivityOS",
  "daily-brief": "Daily Brief"
};

function prettyName(id: string): string {
  return NAME_MAP[id] || id;
}

export function ModulesScreen({
  modules,
  connections,
  onAskClaude,
  onNavigate
}: {
  modules: ModuleInfo[];
  connections: ConnectionStatus[];
  onChanged: () => Promise<void>;
  onAskClaude: (prompt: string) => void;
  onNavigate: (screen: string) => void;
}) {
  const installedIds = useMemo(
    () => new Set(modules.filter((m) => m.installed).map((m) => m.id)),
    [modules]
  );

  // Connector status fetched from the sidecar — drives the "Required Connectors"
  // chips below each module's row. Refreshes whenever the Modules screen
  // re-mounts so newly-connected services show up without an app reload.
  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatusMap>({});
  useEffect(() => {
    invoke<{ connectors: ConnectorStatusMap }>("list_connector_status")
      .then((res) => { if (res?.connectors) setConnectorStatus(res.connectors); })
      .catch(() => undefined);
  }, [modules]);

  // Claude-native Skills installed in .claude/skills/. Unlike modules, skills
  // need no install and no slash command — Claude invokes them automatically
  // when the user's intent matches. Surfaced here so the user can SEE what
  // their AIOS already does on its own.
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string }>>([]);
  useEffect(() => {
    invoke<Array<{ id: string; name: string; description: string }>>("list_skills")
      .then((res) => { if (Array.isArray(res)) setSkills(res); })
      .catch(() => undefined);
  }, []);

  // Saved dynamic workflows in .claude/workflows/ — rerunnable multi-agent
  // processes. The directory only exists once the user saves a workflow on a
  // capable CLI (2.1.154+), so this stays empty (and the panel hidden) on
  // older setups — no dead UI. Each runs via its `/<name>` slash command.
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string; description: string }>>([]);
  useEffect(() => {
    invoke<Array<{ id: string; name: string; description: string }>>("list_workflows")
      .then((res) => { if (Array.isArray(res)) setWorkflows(res); })
      .catch(() => undefined);
  }, []);

  const installedCount = modules.filter((m) => m.installed).length;
  const totalCount = modules.length;
  const progressPct = totalCount > 0 ? Math.round((installedCount / totalCount) * 100) : 0;

  const recommendedNext = useMemo(() => {
    const sorted = [...modules].sort((a, b) => a.phase - b.phase);
    return sorted.find(
      (m) =>
        !m.installed &&
        !m.builtIn &&
        m.sourceExists &&
        (m.requires ?? []).every((r) => installedIds.has(r))
    );
  }, [modules, installedIds]);

  return (
    <section className="modules-screen">
      <div className="modules-shell">
        <header className="modules-hero">
          <div className="modules-hero-left">
            <p className="modules-eyebrow">Layer · Modules</p>
            <h1>AIOS <em>modules</em></h1>
            <p className="modules-hero-detail">
              Plug-and-play building blocks for your AIOS. Install them one at a time, in order — each unlocks
              a new capability, and Claude walks you through the setup.
            </p>
          </div>
          <div className="modules-progress-card">
            <div className="modules-progress-numbers">
              <span className="modules-progress-big">{installedCount}</span>
              <span className="modules-progress-of">of {totalCount}</span>
            </div>
            <span className="modules-progress-label">installed</span>
            <div className="modules-progress-bar">
              <div className="modules-progress-bar-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </header>

        {recommendedNext ? (
          <div className="modules-next">
            <div className="modules-next-text">
              <span className="modules-next-eyebrow">
                <Sparkles size={12} />
                Recommended next
              </span>
              <h2>{recommendedNext.name}</h2>
              <p>{recommendedNext.description || recommendedNext.capability}</p>
            </div>
            <button
              type="button"
              className="modules-next-cta"
              onClick={() => onAskClaude(`/install ${recommendedNext.installPath}`)}
            >
              Install {recommendedNext.name}
              <ArrowRight size={14} />
            </button>
          </div>
        ) : null}

        {skills.length > 0 ? (
          <div className="modules-skills-panel">
            <div className="modules-skills-head">
              <span className="modules-skills-eyebrow">
                <Sparkles size={12} />
                Skills · always on
              </span>
              <p className="modules-skills-detail">
                No install, no commands to remember. Claude reaches for these automatically when what
                you ask for matches — just describe what you need.
              </p>
            </div>
            <div className="modules-skills-grid">
              {skills.map((skill) => (
                <div className="modules-skill-card" key={skill.id}>
                  <strong>{skill.name.replace(/-/g, " ")}</strong>
                  <span>{skill.description}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {workflows.length > 0 ? (
          <div className="modules-skills-panel">
            <div className="modules-skills-head">
              <span className="modules-skills-eyebrow">
                <Sparkles size={12} />
                Workflows · saved processes
              </span>
              <p className="modules-skills-detail">
                Rerunnable multi-agent processes. Click Run to execute one again — Claude follows the
                saved orchestration across every step.
              </p>
            </div>
            <div className="modules-skills-grid">
              {workflows.map((wf) => (
                <button
                  type="button"
                  className="modules-skill-card modules-skill-card-run"
                  key={wf.id}
                  onClick={() => onAskClaude(`/${wf.id}`)}
                  title={`Run workflow: ${wf.name}`}
                >
                  <strong>{wf.name.replace(/-/g, " ")}</strong>
                  <span>{wf.description}</span>
                  <span className="modules-skill-run-cue"><ArrowRight size={13} /> Run</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="modules-list">
          {modules.map((module) => (
            <ModuleRow
              key={module.id}
              module={module}
              installedIds={installedIds}
              connectorStatus={connectorStatus}
              onAskClaude={onAskClaude}
              onNavigate={onNavigate}
            />
          ))}
        </div>

        {connections.length > 0 ? (
          <div className="modules-connections-panel">
            <div className="modules-connections-head">
              <span className="modules-connections-eyebrow">Runtime</span>
              <h3>Workspace readiness</h3>
            </div>
            <div className="modules-connections-list">
              {connections.map((connection) => (
                <div className="modules-connection-row" key={connection.id}>
                  <div>
                    <strong>{connection.label}</strong>
                    <span>{connection.detail}</span>
                  </div>
                  <span className={`modules-connection-pill is-${connection.status}`}>
                    {connection.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ModuleRow({
  module,
  installedIds,
  connectorStatus,
  onAskClaude,
  onNavigate
}: {
  module: ModuleInfo;
  installedIds: Set<string>;
  connectorStatus: ConnectorStatusMap;
  onAskClaude: (prompt: string) => void;
  onNavigate: (screen: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [readme, setReadme] = useState<string | null>(null);
  const [loadingReadme, setLoadingReadme] = useState(false);

  const requires = module.requires ?? [];
  const missingDeps = requires.filter((r) => !installedIds.has(r));
  const requiredConnectors = module.requiredConnectors ?? [];
  const missingConnectors = requiredConnectors.filter(
    (c) => !connectorStatus[c]?.connected
  );
  const sourceMissing = !module.sourceExists;
  // Once a module is installed, it can always be reinstalled — dependency check only blocks fresh installs.
  const blockedByDeps = missingDeps.length > 0 && !module.installed;
  const blockedByConnectors = missingConnectors.length > 0 && !module.installed;
  // Connectors no longer block installation — the user can add them manually later.
  const blocked = sourceMissing || blockedByDeps;

  const status: "builtin" | "installed" | "ready" | "locked" | "needs" | "missing" = module.builtIn
    ? "builtin"
    : sourceMissing
      ? "missing"
      : module.installed
        ? "installed"
        : blockedByDeps
          ? "locked"
          : blockedByConnectors
            ? "needs"
            : "ready";

  async function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (next && !readme && !sourceMissing) {
      setLoadingReadme(true);
      try {
        const data = await invoke<FilePreview>("read_markdown_preview", {
          path: `${module.installPath}/README.md`
        });
        setReadme(data?.content ?? "");
      } finally {
        setLoadingReadme(false);
      }
    }
  }

  function startInstall() {
    onAskClaude(`/install ${module.installPath}`);
  }

  return (
    <article className={`modules-row is-${status}`}>
      <button
        type="button"
        className="modules-row-main"
        onClick={toggleExpanded}
        aria-expanded={expanded}
      >
        <div className="modules-phase">
          <span className="modules-phase-number">{module.phase}</span>
        </div>
        <div className="modules-row-text">
          <div className="modules-row-title">
            <strong>{module.name}</strong>
            <StatusChip status={status} missingDeps={missingDeps} />
          </div>
          <p className="modules-row-desc">{module.description || module.capability}</p>
          <div className="modules-row-meta">
            {requires.length > 0 ? (
              <span className="modules-meta-item">
                <span className="modules-meta-label">Needs</span>
                {requires.map((r) => (
                  <span key={r} className={`modules-meta-dep ${installedIds.has(r) ? "ok" : "missing"}`}>
                    {prettyName(r)}
                  </span>
                ))}
              </span>
            ) : null}
            {requiredConnectors.length > 0 ? (
              <span className="modules-meta-item">
                <span className="modules-meta-label"><Plug size={10} /> Connectors</span>
                {requiredConnectors.map((c) => (
                  <span
                    key={c}
                    className={`modules-meta-dep ${connectorStatus[c]?.connected ? "ok" : "missing"}`}
                    title={connectorStatus[c]?.connected ? `Connected as ${connectorStatus[c]?.label ?? "unknown"}` : "Open Connectors to set this up"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onNavigate("connectors");
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    {CONNECTOR_LABEL[c] ?? c}
                  </span>
                ))}
              </span>
            ) : null}
            {module.skills && module.skills.length > 0 ? (
              <span className="modules-meta-item">
                <span className="modules-meta-label"><Sparkles size={10} /> {module.skills.length} skill{module.skills.length === 1 ? "" : "s"}</span>
              </span>
            ) : null}
          </div>
        </div>
        <span className="modules-row-chev">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      <div className="modules-row-action">
        {module.builtIn ? (
          <button
            type="button"
            className="modules-install-btn is-builtin"
            onClick={() => onNavigate(module.builtInRoute || "command")}
            title={module.builtInButtonLabel || "Open"}
          >
            <ExternalLink size={13} />
            <span>{module.builtInButtonLabel || "Open"}</span>
          </button>
        ) : (
          <button
            type="button"
            className={`modules-install-btn ${module.installed ? "is-reinstall" : ""}`}
            disabled={blocked}
            onClick={startInstall}
            title={
              blockedByDeps
                ? `Install ${missingDeps.map(prettyName).join(", ")} first`
                : sourceMissing
                  ? "Module source folder is missing on disk"
                  : undefined
            }
          >
            {sourceMissing ? <Lock size={13} /> : module.installed ? <RefreshCw size={13} /> : blocked ? <Lock size={13} /> : <Download size={13} />}
            <span>
              {sourceMissing
                ? "Source missing"
                : module.installed
                  ? "Reinstall"
                  : blockedByDeps
                    ? `Install ${prettyName(missingDeps[0])} first`
                    : "Install"}
            </span>
          </button>
        )}
      </div>

      {expanded ? (
        <div className="modules-row-expand">
          {module.skills && module.skills.length > 0 ? (
            <div className="modules-expand-skills">
              <span className="modules-meta-label">{module.skills.length} skill{module.skills.length === 1 ? "" : "s"} · always on</span>
              <div className="modules-skill-rows">
                {module.skills.map((sk) => (
                  <div className="modules-skill-row" key={sk.id}>
                    <span className="modules-skill-dot" title="Ready — loaded and auto-invoked by intent" />
                    <div className="modules-skill-text">
                      <strong>{sk.name.replace(/-/g, " ")}</strong>
                      <span>{sk.description}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {module.artifacts && module.artifacts.length > 0 ? (
            <div className="modules-expand-meta">
              <span className="modules-meta-label">Adds to workspace</span>
              <code className="modules-meta-mono">{module.artifacts.join("    ")}</code>
            </div>
          ) : null}
          <div className="modules-expand-readme">
            {loadingReadme ? (
              <div className="modules-readme-loading">
                <Loader2 size={14} className="spin" />
                Loading README…
              </div>
            ) : readme ? (
              <div className="aios-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{readme}</ReactMarkdown>
              </div>
            ) : sourceMissing ? (
              <p className="modules-readme-empty">Source folder is missing — nothing to preview.</p>
            ) : (
              <p className="modules-readme-empty">No README available.</p>
            )}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function StatusChip({
  status,
  missingDeps
}: {
  status: "builtin" | "installed" | "ready" | "locked" | "missing" | "needs";
  missingDeps: string[];
}) {
  if (status === "builtin") {
    return (
      <span className="modules-status is-builtin">
        <Zap size={11} />
        Built in
      </span>
    );
  }
  if (status === "installed") {
    return (
      <span className="modules-status is-installed">
        <Check size={11} />
        Installed
      </span>
    );
  }
  if (status === "missing") {
    return <span className="modules-status is-missing">Source missing</span>;
  }
  if (status === "locked") {
    return (
      <span className="modules-status is-locked">
        Needs {missingDeps.map(prettyName).join(", ")}
      </span>
    );
  }
  if (status === "needs") {
    return <span className="modules-status is-locked">Needs</span>;
  }
  return <span className="modules-status is-ready">Ready to install</span>;
}
