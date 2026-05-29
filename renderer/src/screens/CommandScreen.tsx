import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  Boxes,
  Briefcase,
  Building2,
  ChevronDown,
  Check,
  ClipboardList,
  Clock,
  Command,
  Copy,
  Cpu,
  Crown,
  DollarSign,
  Eraser,
  FileText,
  Folder,
  FolderOpen,
  HelpCircle,
  Inbox,
  Layers,
  Lightbulb,
  ListChecks,
  Loader2,
  Megaphone,
  MessageSquare,
  Mic,
  Microscope,
  Paperclip,
  PenLine,
  Plug,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Target,
  TrendingUp,
  Users,
  Wand2,
  Wrench,
  X,
  Zap,
  FileCheck
} from "lucide-react";
import { invoke, newId } from "../lib/api";
import { track } from "../lib/analytics";
import { formatRelativeTime } from "../lib/workspace-view";
import { PanelHeader, StatusBadge } from "../components/ui";
import { GoalProgressBanner } from "../components/GoalProgressBanner";
import { TeamProgressBanner } from "../components/TeamProgressBanner";
import type {
  AgentInfo,
  ChatMessage,
  ChatSession,
  ClaudeStreamEvent,
  ClaudeStatus,
  ConnectionStatus,
  ContextSummary,
  ModuleInfo,
  RecentActivityEntry,
  WorkspaceEntry
} from "../types";
import type { OnboardingState, Screen } from "../ui";

// Mirror-renderer for the composer overlay. Walks the prompt text and emits
// a styled <span> for every @AgentName / @ConnectorName token that matches a
// known entity. Agents render in sage, connectors render in slate. Other
// text is emitted as plain text so it renders identically to what's in the
// textarea underneath (which has transparent text + visible caret).
type MirrorEntity = { name: string; kind: "agent" | "connector" | "folder" };
function renderHighlightedPrompt(
  text: string,
  entities: MirrorEntity[],
  slashIds: string[] = []
): React.ReactNode[] {
  if (!text) return [];
  const parts: React.ReactNode[] = [];
  let key = 0;
  let scanStart = 0;
  // Leading slash command — only valid at the very start of the input. Match
  // the longest known command id (so `/go-context` wins over `/go`).
  if (text.startsWith("/") && slashIds.length > 0) {
    const sortedIds = [...slashIds].sort((a, b) => b.length - a.length);
    for (const id of sortedIds) {
      const token = `/${id}`;
      if (
        text.startsWith(token) &&
        (text.length === token.length || /[\s\W]/.test(text[token.length]))
      ) {
        parts.push(
          <span key={`c${key++}`} className="aios-mention-token is-command">
            {token}
          </span>
        );
        scanStart = token.length;
        break;
      }
    }
  }
  // @ mention scanning over the remaining text
  const sorted = [...entities].sort((a, b) => b.name.length - a.name.length);
  let bufferStart = scanStart;
  let i = scanStart;
  while (i < text.length) {
    if (text[i] === "@") {
      const rest = text.slice(i + 1);
      let matched: MirrorEntity | null = null;
      for (const entity of sorted) {
        if (rest.toLowerCase().startsWith(entity.name.toLowerCase())) {
          const boundary = rest[entity.name.length];
          if (boundary === undefined || /[\s\W]/.test(boundary)) {
            matched = entity;
            break;
          }
        }
      }
      if (matched) {
        if (bufferStart < i) {
          parts.push(<React.Fragment key={`t${key++}`}>{text.slice(bufferStart, i)}</React.Fragment>);
        }
        parts.push(
          <span key={`m${key++}`} className={`aios-mention-token is-${matched.kind}`}>
            @{matched.name}
          </span>
        );
        i += 1 + matched.name.length;
        bufferStart = i;
        continue;
      }
    }
    i++;
  }
  if (bufferStart < text.length) {
    parts.push(<React.Fragment key={`t${key++}`}>{text.slice(bufferStart)}</React.Fragment>);
  }
  return parts;
}

function friendlyActivityLabel(activity: { tool: string; summary: string }): string {
  const tool = activity.tool;
  switch (tool) {
    case "Bash":
    case "PowerShell":
      return "Running a command";
    case "Read":
      return "Reading a file";
    case "Write":
      return "Writing a file";
    case "Edit":
    case "MultiEdit":
      return "Editing a file";
    case "Glob":
      return "Searching files";
    case "Grep":
      return "Searching code";
    case "WebFetch":
      return "Fetching a web page";
    case "WebSearch":
      return "Searching the web";
    case "TodoWrite":
    case "Task":
      return "Updating to-do list";
    case "Agent":
      return "Spawning a sub-agent";
    case "NotebookEdit":
      return "Editing a notebook";
  }
  if (tool.startsWith("mcp__composio__")) {
    const action = tool.replace(/^mcp__composio__/, "").toUpperCase();
    // Composio meta-tools: the agent discovering + executing connector actions
    if (action === "COMPOSIO_SEARCH_TOOLS") return "Finding the right tool";
    if (action === "COMPOSIO_MULTI_EXECUTE_TOOL") return "Working with your apps";
    if (action === "COMPOSIO_RETRIEVE_ACTIONS") return "Looking up available actions";
    // Service-prefixed actions ("GMAIL_SEND_MESSAGE", "SLACK_LIST_CHANNELS", ...).
    // Service slug is everything before the first underscore.
    const underscore = action.indexOf("_");
    if (underscore > 0) {
      const service = action.slice(0, underscore);
      const verb = action.slice(underscore + 1).toLowerCase().replace(/_/g, " ");
      const niceService = service
        .toLowerCase()
        .replace(/^google/, "Google ")
        .replace(/^googlecalendar$/i, "Google Calendar")
        .replace(/^googlesheets$/i, "Google Sheets")
        .replace(/^googleanalytics$/i, "Google Analytics")
        .replace(/^googledrive$/i, "Google Drive")
        .replace(/^googlemeet$/i, "Google Meet")
        .replace(/^googlemaps$/i, "Google Maps")
        .replace(/\b(\w)/g, (m) => m.toUpperCase())
        .trim();
      return `${niceService}: ${verb}`;
    }
    return `Calling ${action.toLowerCase().replace(/_/g, " ")}`;
  }
  if (tool.startsWith("mcp__")) return `Calling ${tool.replace(/^mcp__/, "").replace(/__/g, " · ")}`;
  return `Running ${tool || "tool"}`;
}

function formatRunMeta(meta: { model?: string; durationMs?: number; costUsd?: number }): string {
  const parts: string[] = [];
  const modelLabel: Record<string, string> = {
    opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", default: "Claude"
  };
  if (meta.model) parts.push(modelLabel[meta.model] ?? meta.model);
  if (meta.durationMs && meta.durationMs > 0) {
    const s = meta.durationMs / 1000;
    parts.push(s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`);
  }
  if (typeof meta.costUsd === "number" && meta.costUsd > 0) {
    parts.push(meta.costUsd < 0.01 ? `<$0.01` : `$${meta.costUsd.toFixed(2)}`);
  }
  return parts.join(" · ");
}

// Dynamic workflows (the "Workflows" effort level) need Claude Code 2.1.154+.
// Returns true only when we can confirm the CLI is new enough — unknown /
// unparseable versions return false so we err toward showing the upgrade nudge.
const WORKFLOWS_MIN_VERSION = [2, 1, 154];
function cliSupportsWorkflows(version: string | null | undefined): boolean {
  if (!version) return false;
  const m = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (v[i] > WORKFLOWS_MIN_VERSION[i]) return true;
    if (v[i] < WORKFLOWS_MIN_VERSION[i]) return false;
  }
  return true;
}

const starterPrompts = [
  { label: "Generate my first workspace summary", icon: Command, prompt: "/prime" },
  { label: "Review my AIOS context files", icon: FileText, prompt: "Review my AIOS context files and tell me what is strong, thin, or missing." },
  { label: "Find the best next action", icon: Sparkles, prompt: "Summarize the workspace and tell me the single highest leverage next action." },
  { label: "Create a plan from my workspace", icon: Bot, prompt: "Create a practical plan from my current AIOS workspace context." }
];

// Model picker options. "default" omits --model from the spawn so Claude CLI
// uses whatever the user has configured. The other three pass the short alias
// that Claude Code CLI accepts. Opus is the AIOS default — smartest model
// produces the best demos and the best work product, which matters more
// than raw speed for AIOS's positioning. Sonnet/Haiku remain one click
// away in the pill for when speed beats depth.
const CHAT_MODELS = [
  { id: "opus",    label: "Opus 4.7",    description: "Smartest · the AIOS default" },
  { id: "sonnet",  label: "Sonnet 4.6",  description: "Balanced · faster, still strong" },
  { id: "haiku",   label: "Haiku 4.5",   description: "Fastest · for simple back-and-forth" },
  { id: "default", label: "CLI default", description: "Use whatever your Claude CLI is set to" }
] as const;

// Effort levels. "auto" passes no flag (CLI default). The rest map to the
// CLI's --effort flag. "ultracode" enables dynamic workflows (Claude writes
// an orchestration script and runs it across many agents) — needs Claude Code
// 2.1.154+; the sidecar degrades it to xhigh on older CLIs so it never errors.
const EFFORT_OPTIONS = [
  { id: "auto",      label: "Standard",  description: "Default — fast, no extra reasoning budget" },
  { id: "xhigh",     label: "Deep",      description: "Extra reasoning for harder, multi-step work" },
  { id: "max",       label: "Max",       description: "Maximum reasoning — slowest, most thorough" },
  { id: "ultracode", label: "Workflows", description: "Beta · Claude plans an orchestration and runs it across many agents" }
] as const;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button className="copy-code-btn" onClick={handleCopy} title="Copy code">
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function MessageActions({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="message-actions">
      <button
        className="message-action"
        onClick={async () => {
          await navigator.clipboard.writeText(content);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        }}
        title="Copy response"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

const CodeBlock = React.memo(function CodeBlock({ children, lang }: { children?: React.ReactNode; lang?: string }) {
  const text = useMemo(() => {
    if (typeof children === "string") return children;
    if (Array.isArray(children)) return children.map((c) => (typeof c === "string" ? c : "")).join("");
    return "";
  }, [children]);
  // Pass language as a data attribute so CSS can render the header label
  // without React having to mount an extra element per block.
  return (
    <div className="code-block-wrapper" data-lang={lang || undefined}>
      <pre>
        <code>{text}</code>
      </pre>
      <CopyButton text={text} />
    </div>
  );
});

// Stable components map so ReactMarkdown doesn't see a new prop reference each
// render — fresh object identity makes it re-instantiate plugins every time.
const MARKDOWN_COMPONENTS = {
  code({ className, children, ...props }: { className?: string; children?: React.ReactNode }) {
    const isInline = !className;
    if (isInline) return <code {...props}>{children}</code>;
    // ReactMarkdown sets className like "language-python" on fenced blocks
    // with a hint. Strip the prefix so CSS sees "python".
    const lang = className?.replace(/^language-/, "") || "";
    return <CodeBlock lang={lang}>{String(children).replace(/\n$/, "")}</CodeBlock>;
  },
  // Wrap tables in a scrollable container so wide tables get a horizontal
  // scroll instead of breaking the chat column layout. The <table> itself
  // stays a proper `display: table` element so cell-alignment works.
  table({ children, ...props }: { children?: React.ReactNode }) {
    return (
      <div className="aios-markdown-table-wrap">
        <table {...props}>{children}</table>
      </div>
    );
  }
} as const;
const MARKDOWN_PLUGINS = [remarkGfm] as const;

// Memoised so streaming a new chunk into the LAST message doesn't re-parse
// every prior message's markdown. Re-renders only when its content/role flips.
const MessageMarkdown = React.memo(function MessageMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS as any} components={MARKDOWN_COMPONENTS as any}>
      {content}
    </ReactMarkdown>
  );
});

export function CommandScreen({
  claude,
  onboarding,
  context,
  modules,
  outputs,
  plans,
  recent,
  connections,
  activeSession,
  onDetectClaude,
  onSessionsChange,
  onRefreshWorkspace,
  onNavigate,
  onNewChat,
  onOpenAttachment
}: {
  claude: ClaudeStatus | null;
  onboarding: OnboardingState | null;
  context: ContextSummary;
  modules: ModuleInfo[];
  outputs: WorkspaceEntry[];
  plans: WorkspaceEntry[];
  recent: RecentActivityEntry[];
  connections: ConnectionStatus[];
  activeSession: ChatSession | null;
  onDetectClaude: () => Promise<ClaudeStatus>;
  onSessionsChange: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  onRefreshWorkspace: () => Promise<void>;
  onNavigate: (screen: Screen) => void;
  onNewChat?: () => void | Promise<void>;
  onOpenAttachment?: (attachment: import("../types").ChatAttachment) => void;
}) {
  const [runtimeMeta, setRuntimeMeta] = useState<{ sessionId?: string; durationMs?: number; costUsd?: number } | null>(null);
  const [prompt, setPrompt] = useState("");
  // Local "we just kicked off a send" flag — covers the ~50ms between the
  // optimistic message insert and the first stream event from the host. The
  // visible busy state is OR'd with "activeSession has any streaming message"
  // (see streamingBusy below) so returning to chat mid-stream correctly shows
  // the typing indicator instead of falling back to false.
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const voiceBasePromptRef = useRef("");
  const recognitionRef = useRef<any>(null);
  const activeStreamRef = useRef<{ streamId: string; assistantId: string } | null>(null);
  const [activity, setActivity] = useState<{ tool: string; summary: string } | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  // Chat attachments. Files are uploaded into context/import/ and referenced
  // by workspace-relative path; folders are picked via the OS dialog and
  // referenced by absolute path (no copy — Claude gets --add-dir scope so it
  // can Read/Glob/Grep the folder in place). `requiresTccPrompt` is set on
  // Mac when the picked folder lives under a TCC-protected root.
  type ChatAttachmentInput = {
    kind: "file" | "folder";
    name: string;
    path: string;
    size?: number;
    requiresTccPrompt?: boolean;
  };
  const [attachments, setAttachments] = useState<ChatAttachmentInput[]>([]);
  // Messages typed while a Claude turn is in flight are pushed here and
  // auto-sent in FIFO order when the current turn finishes. Lets the user
  // queue up follow-ups without waiting for the agent to finish thinking.
  const [pendingQueue, setPendingQueue] = useState<Array<{ text: string; attachments: ChatAttachmentInput[] }>>([]);
  const lastBusyRef = useRef(false);
  const [previewFolder, setPreviewFolder] = useState<ChatAttachmentInput | null>(null);
  // Display name from onboarding (v0.2.65) — used to personalize the chat
  // empty state. null = not set or onboarding skipped.
  const [displayName, setDisplayName] = useState<string | null>(null);
  useEffect(() => {
    invoke<{ key: string; value: string | null }>("get_setting", { key: "user_display_name" })
      .then((res) => { if (res?.value) setDisplayName(res.value); })
      .catch(() => undefined);
  }, []);
  // Has ContextOS actually written real content yet? Drives the empty-chat
  // state: brand-new workspaces get the onboarding cards (import / interview
  // / prime), workspaces with real context get personalized "do work" chips.
  // We treat any of the four core context files carrying >120 chars of
  // non-template prose as "ready" — same bar as the host-side context brief.
  const [contextReady, setContextReady] = useState<boolean>(false);
  useEffect(() => {
    invoke<{ files: Array<{ path: string; exists: boolean; preview: string }> }>("get_context_summary")
      .then((res) => {
        const files = res?.files ?? [];
        const ready = files.some((f) => {
          if (!f.exists) return false;
          const p = (f.preview || "").trim();
          if (p.length < 120) return false;
          const lower = p.toLowerCase();
          return !lower.includes("placeholder") && !lower.includes("your business does");
        });
        setContextReady(ready);
      })
      .catch(() => undefined);
  }, []);
  const [dragActive, setDragActive] = useState(false);
  const dragCounterRef = useRef(0);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const sourceMenuRef = useRef<HTMLDivElement | null>(null);
  // Marked import folders surfaced in the @ palette. Cached at mount and
  // re-fetched whenever the Python sidecar broadcasts `imports_changed`.
  type MarkedFolder = { name: string; absolutePath: string; markedAt: string };
  const [markedFolders, setMarkedFolders] = useState<MarkedFolder[]>([]);
  // Opus is the AIOS default — see CHAT_MODELS rationale.
  // Returning users with a persisted `chat_model` setting override this on
  // mount in the useEffect below.
  const [selectedModel, setSelectedModel] = useState<string>("opus");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelButtonRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  // Effort / reasoning level. Auto = no flag (CLI default). Deep = xhigh,
  // Max = max, Workflows = ultracode (dynamic workflows; host.py degrades it
  // to xhigh on a pre-2.1.154 CLI so it never errors). Persisted in SQLite.
  const [selectedEffort, setSelectedEffort] = useState<string>("auto");
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const effortButtonRef = useRef<HTMLButtonElement | null>(null);
  const effortMenuRef = useRef<HTMLDivElement | null>(null);
  // Permission mode pill (default / plan / acceptEdits). Mirrors Claude Code
  // CLI's Shift+Tab cycle. Persisted per session in SQLite via save_session.
  // Default = today's behavior (bypassPermissions); Plan = read-only + plan
  // card with Accept; Accept Edits = edits flow freely, shell blocked.
  type ModeId = "default" | "plan" | "acceptEdits";
  const [mode, setMode] = useState<ModeId>((activeSession?.permissionMode as ModeId) ?? "default");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeButtonRef = useRef<HTMLButtonElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  // One-time plan-mode discoverability hint. Shows the first time Claude asks
  // a clarifying question (an AIOS_ASK message) while the user is in default
  // mode — the exact moment Plan mode becomes relevant. Dismissed forever via
  // localStorage once seen or acted on.
  const [planHintSeen, setPlanHintSeen] = useState<boolean>(
    () => { try { return localStorage.getItem("aios.hint.planmode") === "1"; } catch { return true; } }
  );
  const dismissPlanHint = () => {
    setPlanHintSeen(true);
    try { localStorage.setItem("aios.hint.planmode", "1"); } catch { /* ignore */ }
  };
  // Plan card capture — when Claude calls ExitPlanMode mid-stream we stash
  // the plan markdown here. On run_task resolve we attach it to the assistant
  // message as planProposal so the renderer shows a Plan card. Ref (not state)
  // so capture doesn't trigger re-render mid-stream.
  const pendingPlanRef = useRef<string | null>(null);
  // User can dismiss the goal banner via the X button. Reset when a new
  // session is selected OR when a new goal starts (latter handled by the
  // host-event listener below).
  const [goalBannerDismissed, setGoalBannerDismissed] = useState(false);
  // Same pattern for the team banner.
  const [teamBannerDismissed, setTeamBannerDismissed] = useState(false);

  // Composer slash / @ palette state. `from` is the character offset of the
  // trigger character (the "/" or "@") in the current prompt — we need it so
  // commit can splice the right range out without confusing tokens elsewhere
  // in the message body.
  type PaletteState =
    | { kind: "none" }
    | { kind: "slash"; query: string; from: number }
    | { kind: "at"; query: string; from: number };
  const [palette, setPalette] = useState<PaletteState>({ kind: "none" });
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  // Combined entity list the mirror + chat-bubble highlighter uses to detect
  // @mentions. Sage chips for agents, slate chips for connected services.
  const mirrorEntities = useMemo<MirrorEntity[]>(() => {
    const a = agents.map<MirrorEntity>((agent) => ({ name: agent.name, kind: "agent" }));
    const c = (connections || [])
      .filter((conn) => conn.status === "connected")
      .map<MirrorEntity>((conn) => ({ name: conn.label, kind: "connector" }));
    const f = markedFolders.map<MirrorEntity>((folder) => ({ name: folder.name, kind: "folder" }));
    return [...a, ...c, ...f];
  }, [agents, connections, markedFolders]);
  // When set, the next chat send addresses this agent — its effective_prompt
  // is overlaid as a system prompt so the response comes back in-character.
  // Chip lives above the textarea with an × to remove. One agent at a time.

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await invoke<{ agents: AgentInfo[] }>("list_agents", {});
        if (!cancelled && Array.isArray(res?.agents)) setAgents(res.agents);
      } catch {
        /* agents page will recover; this is best-effort for the @ palette */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const installedCount = modules.filter((module) => module.installed).length;
  const contextCount = context.files.filter((file) => file.exists).length;
  const realMessages = activeSession?.messages ?? [];
  const hasRealMessages = realMessages.length > 0;
  const visibleMessages = hasRealMessages ? realMessages : [];
  const renderedMessages = visibleMessages;

  useEffect(() => {
    const onSetPrompt = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setPrompt(detail);
      window.setTimeout(() => composerRef.current?.focus(), 0);
    };
    document.addEventListener("aios:set-prompt", onSetPrompt as EventListener);
    return () => document.removeEventListener("aios:set-prompt", onSetPrompt as EventListener);
  }, []);

  // Load persisted model choice on mount.
  useEffect(() => {
    invoke<{ key: string; value: string | null }>("get_setting", { key: "chat_model" })
      .then((r) => {
        if (r?.value && CHAT_MODELS.some((m) => m.id === r.value)) {
          setSelectedModel(r.value);
        }
      })
      .catch(() => undefined);
  }, []);

  // Load persisted effort choice on mount.
  useEffect(() => {
    invoke<{ key: string; value: string | null }>("get_setting", { key: "chat_effort" })
      .then((r) => {
        if (r?.value && EFFORT_OPTIONS.some((e) => e.id === r.value)) {
          setSelectedEffort(r.value);
        }
      })
      .catch(() => undefined);
  }, []);

  // Chat-referenceable folder palette source. Combines:
  //   - starred local import folders (context/import/<name>) from
  //     list_marked_import_folders
  //   - on-disk linked folders the user picked via Imports → Pick folder,
  //     from list_linked_folders
  // Both kinds carry an absolutePath so the renderer can forward them as
  // --add-dir to run_task without further translation. Fetched at mount and
  // refreshed on every imports_changed host event (link/unlink/star/delete).
  useEffect(() => {
    let cancelled = false;
    const reload = async () => {
      try {
        const [markedRes, linkedRes] = await Promise.all([
          invoke<{ folders: MarkedFolder[] }>("list_marked_import_folders"),
          invoke<{ folders: MarkedFolder[] }>("list_linked_folders"),
        ]);
        if (cancelled) return;
        // Dedup by absolutePath — a linked folder that happens to live under
        // context/import/ shouldn't appear twice. The marked list wins for
        // name collisions (preserves the local-import label).
        const seen = new Set<string>();
        const combined: MarkedFolder[] = [];
        for (const f of markedRes?.folders ?? []) {
          if (!f?.absolutePath || seen.has(f.absolutePath)) continue;
          seen.add(f.absolutePath);
          combined.push(f);
        }
        for (const f of linkedRes?.folders ?? []) {
          if (!f?.absolutePath || seen.has(f.absolutePath)) continue;
          seen.add(f.absolutePath);
          combined.push({ name: f.name, absolutePath: f.absolutePath, markedAt: (f as any).addedAt ?? "" });
        }
        setMarkedFolders(combined);
      } catch {
        /* best-effort — leave the previous list in place */
      }
    };
    void reload();
    const unsubscribe = window.aios.onHostEvent((event) => {
      const e = event as { event?: string } | null;
      if (e?.event === "imports_changed") void reload();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Click-away to close the Sources file/folder menu.
  useEffect(() => {
    if (!sourceMenuOpen) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sourceMenuRef.current?.contains(target)) return;
      setSourceMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [sourceMenuOpen]);

  // Click-away to close the model dropdown.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modelButtonRef.current?.contains(target)) return;
      if (modelMenuRef.current?.contains(target)) return;
      setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modelMenuOpen]);

  async function pickModel(id: string) {
    setSelectedModel(id);
    setModelMenuOpen(false);
    await invoke("set_setting", { key: "chat_model", value: id }).catch(() => undefined);
  }

  async function pickEffort(id: string) {
    setSelectedEffort(id);
    setEffortMenuOpen(false);
    await invoke("set_setting", { key: "chat_effort", value: id }).catch(() => undefined);
  }

  useEffect(() => {
    if (!effortMenuOpen) return;
    const onDoc = (event: MouseEvent) => {
      if (effortMenuRef.current?.contains(event.target as Node)) return;
      if (effortButtonRef.current?.contains(event.target as Node)) return;
      setEffortMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [effortMenuOpen]);

  // Click-away for the mode dropdown.
  useEffect(() => {
    if (!modeMenuOpen) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modeButtonRef.current?.contains(target)) return;
      if (modeMenuRef.current?.contains(target)) return;
      setModeMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modeMenuOpen]);

  // Sync local mode state when the user switches between chat sessions.
  // Each session has its own persisted mode; switching threads should reflect.
  useEffect(() => {
    const sessionMode = (activeSession?.permissionMode as ModeId) ?? "default";
    setMode(sessionMode);
    setGoalBannerDismissed(false);
    setTeamBannerDismissed(false);
  }, [activeSession?.id]);

  function pickMode(id: ModeId) {
    setMode(id);
    setModeMenuOpen(false);
    if (!activeSession) return;
    // Update session in parent state + persist via save_session IPC. Mirrors
    // the pattern used elsewhere (claudeSessionId updates after each turn).
    const updated = { ...activeSession, permissionMode: id };
    onSessionsChange((current) => current.map((s) => (s.id === updated.id ? updated : s)));
    void invoke("save_session", { session: updated }).catch(() => undefined);
  }

  function cycleMode() {
    const order: ModeId[] = ["default", "plan", "acceptEdits"];
    const next = order[(order.indexOf(mode) + 1) % order.length];
    pickMode(next);
  }

  // Plan card actions. Three options matching Claude Code CLI's interactive
  // plan-approval flow: "yes auto" / "yes edits only" / "no keep planning".
  // Accepting also switches the session into that mode so the next message
  // doesn't replan — exactly what the CLI's "switch mode going forward" does.
  function acceptPlanWithMode(message: ChatMessage, newMode: ModeId) {
    const sessionId = activeSession?.id;
    if (!sessionId || !message.planProposal) return;
    const replay = message.planProposal.promptToReplay;
    onSessionsChange((current) => current.map((s) => {
      if (s.id !== sessionId) return s;
      return {
        ...s,
        permissionMode: newMode,
        messages: s.messages.map((m) => m.id === message.id && m.planProposal
          ? { ...m, planProposal: { ...m.planProposal, status: "accepted" as const } }
          : m
        ),
      };
    }));
    setMode(newMode);
    // Persist mode change asynchronously (best-effort; harmless on failure).
    void invoke("save_session", { session: { ...activeSession, permissionMode: newMode } }).catch(() => undefined);
    void sendPrompt(replay, { permissionModeOverride: modeToWire(newMode) });
  }

  function rejectPlan(message: ChatMessage) {
    const sessionId = activeSession?.id;
    if (!sessionId) return;
    onSessionsChange((current) => current.map((s) => {
      if (s.id !== sessionId) return s;
      return {
        ...s,
        messages: s.messages.map((m) => m.id === message.id && m.planProposal
          ? { ...m, planProposal: { ...m.planProposal, status: "rejected" as const } }
          : m
        ),
      };
    }));
  }

  // Translate the renderer-side mode name into the value the Python sidecar
  // wants on the wire. "default" maps to the historical bypassPermissions
  // flag — keep that string so any future cross-check against
  // _ALLOWED_PERMISSION_MODES in host.py succeeds.
  function modeToWire(id: ModeId): "bypassPermissions" | "plan" | "acceptEdits" {
    if (id === "plan") return "plan";
    if (id === "acceptEdits") return "acceptEdits";
    return "bypassPermissions";
  }

  const MODE_OPTIONS: { id: ModeId; label: string; description: string; Icon: React.ComponentType<{ size?: number }> }[] = [
    { id: "default", label: "Auto", description: "Claude runs everything for you — fastest, no prompts", Icon: Zap },
    { id: "plan", label: "Plan", description: "Claude proposes a plan first — you review before anything runs", Icon: ClipboardList },
    { id: "acceptEdits", label: "Edits only", description: "Claude can edit files but won't run shell commands", Icon: FileCheck },
  ];

  // Are any messages in the active session still streaming? If yes, the chat
  // is busy even after CommandScreen remounts (the local `busy` flag would be
  // false on a fresh mount). This keeps the Send button disabled and the
  // typing indicator correct when the user navigates away and returns.
  const streamingBusy = useMemo(
    () => activeSession?.messages.some((m) => m.role === "assistant" && m.streamId) ?? false,
    [activeSession?.messages]
  );
  const effectiveBusy = busy || streamingBusy;

  // No-op (previously used for showFullHistory)

  // After any prompt change (typing, paste, slash-command insert), keep the
  // caret in view inside the composer textarea. Browsers handle this for
  // single-character typing, but programmatic value changes (paste of a
  // long block, paste from clipboard via cmd, palette insert) leave
  // scrollTop at 0 and the caret below the visible area. v0.2.54 made the
  // textarea scrollable; this makes it auto-track the caret on paste.
  useEffect(() => {
    const ta = composerRef.current;
    if (!ta) return;
    // Only snap when caret is at the end — don't interrupt mid-edit scrolling.
    if (ta.selectionStart === ta.value.length) {
      ta.scrollTop = ta.scrollHeight;
      if (mirrorRef.current) mirrorRef.current.scrollTop = mirrorRef.current.scrollHeight;
    }
  }, [prompt]);

  // Auto-grow the textarea height with content. Reset to "auto" first so
  // scrollHeight reflects the actual content (not the previously-set
  // explicit height), then clamp to the CSS max-height. Past the cap, the
  // textarea's overflow-y: auto takes over and a scrollbar appears.
  // Empty prompt → clear the inline height so CSS min-height (32px) wins.
  // The mirror layer is `position: absolute; inset: 0` inside the input-line
  // parent, so it tracks the textarea's height automatically — no need to
  // set it explicitly.
  useEffect(() => {
    const ta = composerRef.current;
    if (!ta) return;
    if (!prompt) {
      ta.style.height = "";
      return;
    }
    const MAX_HEIGHT = 240;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT)}px`;
  }, [prompt]);

  // Smart auto-scroll. Previous behavior smooth-scrolled to bottom on EVERY
  // message/delta change — even when the user had scrolled UP to read
  // history mid-stream. That yanked them back to the bottom every ~200ms
  // during streaming. Now: detect if the user was already near the bottom
  // (within 80px); only auto-scroll if they were. If they scrolled up,
  // leave them alone — they can hit End or click into the composer to
  // jump back manually.
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const distanceFromBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    if (distanceFromBottom <= 80) {
      // Use "auto" during streaming (instant follow), "smooth" on completion
      // for a nicer settling animation.
      thread.scrollTo({ top: thread.scrollHeight, behavior: busy ? "auto" : "smooth" });
    }
  }, [activeSession?.messages, busy]);

  useEffect(() => {
    if (!window.aios?.onHostEvent) return () => undefined;
    // App.tsx now owns the content-writing path for claude_stream events
    // (matching messages by streamId). This local listener only updates UI
    // side-effects that depend on the screen being open: the activity
    // indicator + runtime meta footer. When CommandScreen is unmounted these
    // are irrelevant anyway.
    return window.aios.onHostEvent((event) => {
      if (event.event === "goal_progress") {
        const data = event.data as (import("../types").ActiveGoal & { sessionId?: string }) | undefined;
        if (!data || !data.sessionId) return;
        const targetSessionId = data.sessionId;
        // Strip sessionId before storing; ActiveGoal type doesn't carry it.
        const { sessionId: _strip, ...goalState } = data;
        onSessionsChange((current) => current.map((s) =>
          s.id === targetSessionId ? { ...s, activeGoal: goalState as import("../types").ActiveGoal } : s
        ));
        // A new active goal should always show the banner (un-dismiss).
        if (goalState.status === "active" && goalState.turn <= 1) {
          setGoalBannerDismissed(false);
        }
        return;
      }
      if (event.event === "team_progress") {
        const data = event.data as (import("../types").ActiveTeam & { sessionId?: string }) | undefined;
        if (!data || !data.sessionId) return;
        const targetSessionId = data.sessionId;
        const { sessionId: _strip, ...teamState } = data;
        onSessionsChange((current) => current.map((s) =>
          s.id === targetSessionId ? { ...s, activeTeam: teamState as import("../types").ActiveTeam } : s
        ));
        // When a fresh team task starts, un-dismiss the banner.
        if (teamState.phase === "decomposing") {
          setTeamBannerDismissed(false);
        }
        return;
      }
      if (event.event === "team_specialist_message") {
        const data = event.data as {
          sessionId: string;
          agentId: string;
          agentName: string;
          subtask: string;
          reply: string;
          artifacts?: { kind: "plan" | "output"; path: string; filename: string }[];
        } | undefined;
        if (!data || !data.sessionId) return;
        const attachments: import("../types").ChatAttachment[] = (data.artifacts ?? []).map((a) => ({
          kind: a.kind, path: a.path, filename: a.filename,
        }));
        const note: ChatMessage = {
          id: newId("msg"),
          role: "assistant",
          content: `**${data.agentName}** — ${data.subtask}\n\n${data.reply}`,
          createdAt: new Date().toISOString(),
          attachments: attachments.length ? attachments : undefined,
        };
        onSessionsChange((current) => current.map((s) => {
          if (s.id !== data.sessionId) return s;
          const updated = { ...s, messages: [...s.messages, note], updatedAt: new Date().toISOString() };
          void invoke("save_session", { session: updated }).catch(() => undefined);
          return updated;
        }));
        return;
      }
      if (event.event === "team_aggregate_message") {
        const data = event.data as { sessionId: string; reply: string } | undefined;
        if (!data || !data.sessionId) return;
        const note: ChatMessage = {
          id: newId("msg"),
          role: "assistant",
          content: data.reply,
          createdAt: new Date().toISOString(),
        };
        onSessionsChange((current) => current.map((s) => {
          if (s.id !== data.sessionId) return s;
          const updated = { ...s, messages: [...s.messages, note], updatedAt: new Date().toISOString() };
          void invoke("save_session", { session: updated }).catch(() => undefined);
          return updated;
        }));
        return;
      }
      if (event.event === "goal_turn_message") {
        const data = event.data as {
          sessionId: string;
          turn: number;
          role: "assistant";
          content: string;
          artifacts?: { kind: "plan" | "output"; path: string; filename: string }[];
          verifierReason?: string;
        } | undefined;
        if (!data || !data.sessionId) return;
        const attachments: import("../types").ChatAttachment[] = (data.artifacts ?? []).map((a) => ({
          kind: a.kind,
          path: a.path,
          filename: a.filename,
        }));
        const note: ChatMessage = {
          id: newId("msg"),
          role: "assistant",
          content: data.content,
          createdAt: new Date().toISOString(),
          attachments: attachments.length ? attachments : undefined,
        };
        onSessionsChange((current) => current.map((s) => {
          if (s.id !== data.sessionId) return s;
          const updated = { ...s, messages: [...s.messages, note], updatedAt: new Date().toISOString() };
          // Persist asynchronously inside the setter so we have the freshest
          // session reference (including any prior turn's just-appended msgs).
          void invoke("save_session", { session: updated }).catch(() => undefined);
          return updated;
        }));
        return;
      }
      if (event.event !== "claude_stream") return;
      const payload = event.data as ClaudeStreamEvent;
      const activeStream = activeStreamRef.current;
      if (!activeStream || payload.streamId !== activeStream.streamId) return;
      if (payload.sessionId || payload.durationMs || payload.costUsd) {
        setRuntimeMeta((current) => ({
          sessionId: payload.sessionId ?? current?.sessionId,
          durationMs: payload.durationMs ?? current?.durationMs,
          costUsd: payload.costUsd ?? current?.costUsd
        }));
      }
      if (payload.toolUse) {
        setActivity({ tool: payload.toolUse.name, summary: payload.toolUse.summary });
        // Plan-mode: ExitPlanMode tool call carries the plan markdown in
        // input.plan. Stash for the turn's resolver to wrap into a Plan card
        // on the assistant message. Last write wins if Claude proposes
        // multiple plans in one turn (rare).
        if (payload.toolUse.name === "ExitPlanMode" && payload.toolUse.plan) {
          pendingPlanRef.current = payload.toolUse.plan;
        }
      }
      if (payload.toolResult) {
        setActivity(null);
      }
      if (payload.done || payload.response) {
        setActivity(null);
        onRefreshWorkspace().catch(() => undefined);
      }
    });
  }, [onRefreshWorkspace]);

  useEffect(() => {
    if (!busy) composerRef.current?.focus();
  }, [busy, activeSession?.id]);

  // When the active session changes (sidebar pick, "New chat" button, history
  // open), reset the local `busy` flag. `busy` is a component-level boolean
  // that bridges the ~50ms gap between optimistic send and first stream chunk
  // (see comment on the useState above). Without this reset, clicking "New
  // chat" while the previous session was mid-stream would carry the TRUE
  // value over — the fresh chat would render with its input disabled even
  // though it has no in-flight work. The actual in-flight stream from the
  // previous session keeps running in the background and lands correctly via
  // the App-level listener; per-session "is this chat working right now"
  // state is derived from `streamingBusy` which reads messages directly.
  useEffect(() => {
    setBusy(false);
  }, [activeSession?.id]);

  // Elapsed-seconds counter for the activity strip. Resets when busy
  // toggles on, ticks every 1s while busy, clears when busy goes false.
  // Gives users an "the app is alive and working" signal during long
  // turns instead of a blank wait.
  useEffect(() => {
    if (!busy) { setElapsedSeconds(0); return; }
    const started = Date.now();
    const id = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  // Drain the queue when a turn finishes. We detect the busy true→false
  // transition via lastBusyRef so we don't accidentally fire on first mount
  // (busy starts false). FIFO order: take the head, restore its snapshotted
  // attachments, send.
  useEffect(() => {
    if (lastBusyRef.current && !busy && pendingQueue.length > 0) {
      const [next, ...rest] = pendingQueue;
      setPendingQueue(rest);
      setAttachments(next.attachments);
      void sendPrompt(next.text);
    }
    lastBusyRef.current = busy;
  }, [busy, pendingQueue]);

  useEffect(() => {
    return () => {
      try { mediaRecorderRef.current?.stop(); } catch { /* noop */ }
      audioStreamRef.current?.getTracks().forEach((track) => track.stop());
      try { recognitionRef.current?.stop(); } catch { /* noop */ }
    };
  }, []);

  async function audioBlobToWavBase64(blob: Blob): Promise<string> {
    const arrayBuffer = await blob.arrayBuffer();
    const AudioCtx = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;
    const ctx = new AudioCtx();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    await ctx.close().catch(() => undefined);

    // Mix down to mono and resample-pass through (speech_recognition handles any sample rate)
    const numChannels = 1;
    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const samples = new Float32Array(length);
    if (audioBuffer.numberOfChannels === 1) {
      samples.set(audioBuffer.getChannelData(0));
    } else {
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      for (let i = 0; i < length; i += 1) samples[i] = (left[i] + right[i]) / 2;
    }

    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 8 * bytesPerSample, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }

    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return window.btoa(binary);
  }

  async function transcribeBlob(blob: Blob): Promise<string> {
    const wavBase64 = await audioBlobToWavBase64(blob);
    const result = await invoke<{ text: string; engine: string }>("transcribe_audio", {
      audio: wavBase64,
      engine: "google",
      language: "en-US"
    });
    return (result?.text ?? "").trim();
  }

  // Build a complete PCM 16-bit WAV from float32 samples and base64-encode it.
  // We can call this mid-recording because we control the entire format.
  function samplesToWavBase64(samples: Float32Array, sampleRate: number): string {
    const numChannels = 1;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = samples.length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 8 * bytesPerSample, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return window.btoa(binary);
  }

  async function toggleVoiceInput() {
    // Stop path: finalize via the mediaRecorderRef alias we keep for the running session.
    if (listening && mediaRecorderRef.current) {
      const stopFn = (mediaRecorderRef.current as any)._aiosStop as (() => void) | undefined;
      if (stopFn) stopFn();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Microphone is unavailable in this runtime.");
      return;
    }

    setVoiceError(null);
    voiceBasePromptRef.current = prompt.trim();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Microphone permission was denied.");
      return;
    }
    audioStreamRef.current = stream;

    const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const audioCtx = new AudioCtx();
    const source = audioCtx.createMediaStreamSource(stream);
    const bufferSize = 4096;
    const processor = (audioCtx as any).createScriptProcessor(bufferSize, 1, 1) as ScriptProcessorNode;
    const muteNode = audioCtx.createGain();
    muteNode.gain.value = 0;

    const sampleRate = audioCtx.sampleRate;
    const collected: Float32Array[] = [];
    let totalLen = 0;
    let lastText = "";
    let inFlight = false;
    let stopped = false;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      collected.push(copy);
      totalLen += copy.length;
    };

    source.connect(processor);
    processor.connect(muteNode);
    muteNode.connect(audioCtx.destination);

    const liveTimer = window.setInterval(async () => {
      if (inFlight || stopped || totalLen < sampleRate * 0.5) return; // require >0.5s
      // Skip transcription while the window is in the background — the
      // user can't see the live caption anyway, so don't burn CPU.
      if (document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const merged = new Float32Array(totalLen);
        let off = 0;
        for (const arr of collected) { merged.set(arr, off); off += arr.length; }
        const wavB64 = samplesToWavBase64(merged, sampleRate);
        const result = await invoke<{ text: string; engine: string }>("transcribe_audio", {
          audio: wavB64,
          engine: "google",
          language: "en-US"
        });
        const text = (result?.text ?? "").trim();
        if (text && text !== lastText) {
          lastText = text;
          const base = voiceBasePromptRef.current;
          setPrompt(base ? `${base} ${text}` : text);
        }
      } catch {
        // Mid-stream transcription failures are non-fatal; the final pass will catch up.
      } finally {
        inFlight = false;
      }
    }, 3500);

    const stopAll = async () => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(liveTimer);
      try { processor.disconnect(); } catch { /* noop */ }
      try { source.disconnect(); } catch { /* noop */ }
      try { muteNode.disconnect(); } catch { /* noop */ }
      try { await audioCtx.close(); } catch { /* noop */ }
      audioStreamRef.current?.getTracks().forEach((track) => track.stop());
      audioStreamRef.current = null;
      mediaRecorderRef.current = null;
      setListening(false);

      // Final accurate pass — we have all samples, build one big WAV.
      if (totalLen === 0) return;
      setTranscribing(true);
      try {
        const merged = new Float32Array(totalLen);
        let off = 0;
        for (const arr of collected) { merged.set(arr, off); off += arr.length; }
        const wavB64 = samplesToWavBase64(merged, sampleRate);
        const result = await invoke<{ text: string; engine: string }>("transcribe_audio", {
          audio: wavB64,
          engine: "google",
          language: "en-US"
        });
        const text = (result?.text ?? "").trim();
        if (text) {
          const base = voiceBasePromptRef.current;
          setPrompt(base ? `${base} ${text}` : text);
          composerRef.current?.focus();
        }
      } catch (error) {
        setVoiceError(error instanceof Error ? error.message : "Transcription failed.");
      } finally {
        setTranscribing(false);
      }
    };

    // Stash a tag on the alias so the stop-path can find it.
    mediaRecorderRef.current = { _aiosStop: stopAll } as unknown as MediaRecorder;
    setListening(true);
  }

  async function saveUpdatedSession(nextSession: ChatSession) {
    onSessionsChange((current) => current.map((session) => (session.id === nextSession.id ? nextSession : session)));
    await invoke("save_session", { session: nextSession });
  }

  async function uploadAttachments(fileList: FileList) {
    setUploadingAttachment(true);
    try {
      const next: ChatAttachmentInput[] = [];
      for (const file of Array.from(fileList)) {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
        }
        const base64 = btoa(binary);
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const stamp = Date.now().toString(36);
        const path = `imports/chat-${stamp}-${safeName}`;
        try {
          await invoke("write_binary_file", { path, data: base64 });
          next.push({ kind: "file", name: file.name, path, size: file.size });
        } catch (err) {
          console.error("Attachment upload failed:", err);
        }
      }
      if (next.length) {
        setAttachments((current) => [...current, ...next]);
      }
    } finally {
      setUploadingAttachment(false);
    }
  }

  async function pickFolderAttachment() {
    setSourceMenuOpen(false);
    setUploadingAttachment(true);
    try {
      const result = await invoke<{ canceled: boolean; path: string | null; requiresTccPrompt: boolean }>(
        "pick_folder"
      );
      if (!result || result.canceled || !result.path) return;
      const absolutePath = result.path;
      // Derive a basename that works on Win + Mac without depending on Node's
      // path module in the renderer.
      const segments = absolutePath.split(/[\\/]/).filter(Boolean);
      const basename = segments.length ? segments[segments.length - 1] : absolutePath;
      // Dedup — if the user picks the same folder twice, skip the second add.
      setAttachments((current) => {
        if (current.some((a) => a.kind === "folder" && a.path === absolutePath)) return current;
        return [
          ...current,
          {
            kind: "folder",
            name: basename,
            path: absolutePath,
            requiresTccPrompt: !!result.requiresTccPrompt,
          },
        ];
      });
    } catch (err) {
      console.error("Folder picker failed:", err);
    } finally {
      setUploadingAttachment(false);
    }
  }

  function removeAttachment(path: string) {
    setAttachments((current) => current.filter((a) => a.path !== path));
  }

  // Drag-and-drop onto the chat surface → folders attach as folder
  // attachments (reference an absolute path); files go through the same
  // upload flow as the paperclip button (copied into imports/ via
  // write_binary_file). webkitGetAsEntry().isDirectory is the cross-
  // platform "is this a folder?" check; Electron 32+ requires
  // webUtils.getPathForFile for the absolute path resolution.
  function handleDroppedItems(items: DataTransferItemList | null) {
    if (!items) return;
    const folderPaths: Array<{ name: string; path: string }> = [];
    const filesToUpload: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const entry = (item as any).webkitGetAsEntry?.();
      const file = item.getAsFile();
      if (!file) continue;
      if (entry?.isDirectory) {
        if (!window.aios?.getPathForFile) continue;
        try {
          const absolutePath = window.aios.getPathForFile(file);
          if (!absolutePath) continue;
          const segments = absolutePath.split(/[\\/]/).filter(Boolean);
          const basename = segments.length ? segments[segments.length - 1] : absolutePath;
          folderPaths.push({ name: basename, path: absolutePath });
        } catch {
          // Skip folders we can't resolve a path for.
        }
      } else {
        filesToUpload.push(file);
      }
    }
    if (folderPaths.length > 0) {
      setAttachments((current) => {
        const next = [...current];
        for (const f of folderPaths) {
          if (next.some((a) => a.kind === "folder" && a.path === f.path)) continue;
          next.push({ kind: "folder", name: f.name, path: f.path });
        }
        return next;
      });
    }
    if (filesToUpload.length > 0) {
      // Build a synthetic FileList-shaped object so uploadAttachments
      // (which iterates Array.from(fileList)) consumes it unchanged.
      void uploadAttachments(filesToUpload as unknown as FileList);
    }
  }

  function handleDragEnter(event: React.DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragCounterRef.current += 1;
    setDragActive(true);
  }
  function handleDragOver(event: React.DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
  function handleDragLeave(event: React.DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragActive(false);
  }
  function handleDrop(event: React.DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragCounterRef.current = 0;
    setDragActive(false);
    handleDroppedItems(event.dataTransfer.items);
  }

  // Append a synthetic assistant note to the current session — used by /goal
  // commands so the user sees a confirmation in the chat ("Goal started",
  // "Goal cleared", etc.) without firing run_task.
  function appendAssistantNote(content: string) {
    if (!activeSession) return;
    const note: ChatMessage = {
      id: newId("msg"),
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    };
    onSessionsChange((current) => current.map((s) =>
      s.id === activeSession.id
        ? { ...s, messages: [...s.messages, note], updatedAt: new Date().toISOString() }
        : s
    ));
  }

  // Append the user's literal message text so /goal commands show up in the
  // chat history just like normal messages (otherwise the user types
  // `/goal X` and only sees the assistant note appear out of nowhere).
  function appendUserNote(content: string) {
    if (!activeSession) return;
    const note: ChatMessage = {
      id: newId("msg"),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    onSessionsChange((current) => current.map((s) =>
      s.id === activeSession.id
        ? { ...s, messages: [...s.messages, note], updatedAt: new Date().toISOString() }
        : s
    ));
  }

  function describeActiveGoal(goal: import("../types").ActiveGoal | null): string {
    if (!goal) return "No active goal in this chat. Start one with `/goal <verifiable condition>` — e.g. `/goal fix all TypeScript errors in renderer/`.";
    const tokens = goal.tokensSpent.toLocaleString();
    const cost = goal.costUsd ? ` · ~$${goal.costUsd.toFixed(2)}` : "";
    const lastLine = goal.lastReason ? `\n\n_Latest:_ ${goal.lastReason}` : "";
    if (goal.status === "active") return `**Goal active** — turn ${goal.turn} of ${goal.maxTurns} · ${tokens} tokens${cost}\n\n_${goal.condition}_${lastLine}`;
    if (goal.status === "met") return `**Goal met** — finished in ${goal.turn} turns · ${tokens} tokens${cost}\n\n_${goal.condition}_${lastLine}`;
    if (goal.status === "exhausted") return `**Goal exhausted** — hit a cap at turn ${goal.turn} · ${tokens} tokens${cost}\n\n_${goal.condition}_${lastLine}`;
    return `**Goal stopped** — at turn ${goal.turn} · ${tokens} tokens${cost}\n\n_${goal.condition}_${lastLine}`;
  }

  async function sendPrompt(text: string, options?: { permissionModeOverride?: "bypassPermissions" | "plan" | "acceptEdits" }) {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || !claude?.found || !activeSession) return;

    // Intercept /team commands BEFORE the queue check. /team <task> spawns
    // the coordinator + parallel specialists + aggregator flow; /team clear
    // aborts an in-flight one.
    if (trimmed.startsWith("/team")) {
      const rest = trimmed.slice("/team".length).trim();
      setPrompt("");
      appendUserNote(trimmed);
      if (rest === "" || rest === "status") {
        appendAssistantNote(
          activeSession.activeTeam
            ? `Team task in progress: "${activeSession.activeTeam.task}" — phase: ${activeSession.activeTeam.phase}, ${activeSession.activeTeam.specialists.length} specialists.`
            : "No active team task. Start one with `/team <complex task>` — e.g. `/team plan a launch with landing page, blog, and tweet thread`."
        );
        return;
      }
      if (rest === "clear" || rest === "stop" || rest === "abort") {
        try {
          await invoke("team_abort", { sessionId: activeSession.id });
          appendAssistantNote("Team task aborted.");
        } catch (err) {
          appendAssistantNote(`Couldn't abort the team task: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      try {
        await invoke("team_start", {
          sessionId: activeSession.id,
          task: rest,
          claudePath: claude.path,
        });
        appendAssistantNote(`Team task started: "${rest}". Watch the banner above for progress — specialists will post as they finish.`);
      } catch (err) {
        appendAssistantNote(`Couldn't start the team task: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // Intercept /goal commands BEFORE the queue check — these don't go
    // through run_task at all. /goal <condition> starts an autonomous loop;
    // /goal clear stops it; /goal alone reports status.
    if (trimmed.startsWith("/goal")) {
      const rest = trimmed.slice("/goal".length).trim();
      setPrompt("");
      // Always show the user's command in the thread so they can see what
      // they sent (matches how /clear / /new feel today).
      appendUserNote(trimmed);
      if (rest === "" || rest === "status") {
        const summary = describeActiveGoal(activeSession.activeGoal ?? null);
        appendAssistantNote(summary);
        return;
      }
      if (rest === "clear" || rest === "stop" || rest === "abort") {
        try {
          await invoke("goal_abort", { sessionId: activeSession.id });
          appendAssistantNote("Goal cleared. No more automatic turns.");
        } catch (err) {
          appendAssistantNote(`Couldn't clear the goal: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      // Anything else is the condition. Start a new goal.
      try {
        await invoke("goal_start", {
          sessionId: activeSession.id,
          condition: rest,
          claudePath: claude.path,
          claudeSessionId: activeSession.claudeSessionId ?? null,
        });
        appendAssistantNote(`Goal started: "${rest}". Watch the banner above for progress.`);
      } catch (err) {
        appendAssistantNote(`Couldn't start the goal: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // If a turn is already in flight, queue this message + clear the composer
    // and let the drain effect send it once busy flips back to false.
    if (busy) {
      setPendingQueue((current) => [...current, { text, attachments: [...attachments] }]);
      setPrompt("");
      setAttachments([]);
      return;
    }
    const fileAttachments = attachments.filter((a) => a.kind === "file");
    const folderAttachments = attachments.filter((a) => a.kind === "folder");
    // Build a single attachment block listing files and folders separately,
    // with verbs tuned for each (Read for files, Glob/Read/Grep for folders).
    const blockLines: string[] = [];
    if (fileAttachments.length || folderAttachments.length) {
      blockLines.push("Attached for this message:");
      for (const f of fileAttachments) blockLines.push(`- file: ${f.name} → ${f.path}`);
      for (const f of folderAttachments) blockLines.push(`- folder: ${f.name} → ${f.path}`);
      blockLines.push("");
      if (fileAttachments.length) {
        blockLines.push("Files: open with the Read tool when relevant.");
      }
      if (folderAttachments.length) {
        blockLines.push(
          "Folders: treat as a project directory — use Glob/Read/Grep to understand the contents before answering. Skim broadly first (Glob for the project shape), then drill in. Skip .DS_Store and other hidden files unless directly relevant."
        );
      }
      blockLines.push("", "---", "");
    }
    const attachmentBlock = blockLines.join("\n");
    const finalText = attachmentBlock + trimmed;
    // The prompt already contains @AgentName / @FolderName tokens inline.
    // Display a compact summary line under the user bubble listing the attached
    // chips so the user can see what they sent even if the @-mention is the
    // only inline cue.
    const chipSummary = attachments.length > 0
      ? `\n\n📎 ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}: ${attachments
          .map((a) => (a.kind === "folder" ? `${a.name}/` : a.name))
          .join(", ")}`
      : "";
    const displayText = attachments.length > 0
      ? `${trimmed || "(see attached items)"}${chipSummary}`
      : trimmed;
    const userMessage: ChatMessage = { id: newId("msg"), role: "user", content: displayText, createdAt: new Date().toISOString() };
    const streamId = newId("stream");
    // Tag the assistant bubble with the streamId so the App-level listener can
    // keep writing into it even if the user navigates away from chat. (Local
    // listener below uses it for activity/runtime meta only.)
    const assistant: ChatMessage = {
      id: newId("msg"),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      streamId
    };
    activeStreamRef.current = { streamId, assistantId: assistant.id };
    const nextSession = {
      ...activeSession,
      messages: [...activeSession.messages, userMessage, assistant],
      updatedAt: new Date().toISOString()
    };
    onSessionsChange((current) => current.map((session) => (session.id === nextSession.id ? nextSession : session)));
    // Persist the optimistic user message immediately so it survives app
    // crashes / reloads before the stream completes. Strip `streamId` from
    // all messages BEFORE writing — streamId is a runtime-only correlation
    // token tying an in-memory message to a live Python subprocess. If we
    // persisted it, a page reload or refresh that re-hydrated from SQLite
    // would resurrect a "stuck thinking" assistant bubble whose streamId
    // no longer matches any live stream — the typing indicator would hang
    // forever. Fire-and-forget — sub-10ms SQLite write.
    const persistable = {
      ...nextSession,
      messages: nextSession.messages.map(({ streamId: _stream, ...m }) => m),
    };
    void invoke("save_session", { session: persistable }).catch(() => undefined);
    setPrompt("");
    setAttachments([]);
    setBusy(true);
    setActivity(null);
    setRuntimeMeta(null);
    try {
      const command = trimmed === "/prime" ? "run_prime" : "run_task";
      track("chat_message_sent", {
        command,
        text_length: trimmed.length,
        attachment_count: attachments.length,
        attachment_kinds: Array.from(new Set(attachments.map((a) => a.kind))),
        is_prime: trimmed === "/prime",
        model: selectedModel,
      });
      const claudeSessionId = activeSession.claudeSessionId ?? undefined;
      const baseArgs: Record<string, unknown> = { claudePath: claude.path, streamId };
      if (claudeSessionId) baseArgs.sessionId = claudeSessionId;
      // Pass the user-picked model through as --model <alias>. "default" means
      // omit the flag so Claude CLI uses whatever's configured globally.
      if (selectedModel && selectedModel !== "default") baseArgs.model = selectedModel;
      // Effort / reasoning level. "auto" omits the flag; everything else
      // passes --effort <level>. "ultracode" (Workflows) is degraded to xhigh
      // by the sidecar on a pre-2.1.154 CLI so it never errors.
      if (selectedEffort && selectedEffort !== "auto") baseArgs.effort = selectedEffort;
      // Permission mode (default / plan / acceptEdits). Wire value differs
      // from UI: "default" → bypassPermissions on the spawn flag. Plan-card
      // Accept passes options.permissionModeOverride = "bypassPermissions"
      // so the re-run executes regardless of the session's current mode.
      baseArgs.permissionMode = options?.permissionModeOverride ?? modeToWire(mode);
      // Clear any stale plan proposal from a prior turn before this turn's
      // stream listener has a chance to populate it.
      pendingPlanRef.current = null;
      // Scan the prompt for @AgentName mentions and overlay each addressed
      // agent's effective prompt as a system prompt for THIS chat turn. The
      // shim tells Claude to answer in-character (single agent) or as the
      // team (multiple agents), and to skip task-routing sentinels — chat
      // mode, not task mode.
      if (command === "run_task") {
        const mentionedAgents = collectMentionedAgents(trimmed);
        if (mentionedAgents.length > 0) {
          baseArgs.systemPrompt = buildChatSystemPrompt(mentionedAgents);
        }
      }
      // Folder attachments — both manual picks AND folder @mentions — flow
      // through as --add-dir flags. Dedup defensively so the same folder
      // can't grow the cmd-line if both code paths added it.
      const addDirs = Array.from(
        new Set(folderAttachments.map((a) => a.path).filter((p): p is string => !!p))
      );
      const taskArgs = command === "run_prime"
        ? baseArgs
        : addDirs.length > 0
        ? { ...baseArgs, prompt: finalText, addDirs }
        : { ...baseArgs, prompt: finalText };
      const result = await invoke<{ response: string; sessionId?: string; durationMs?: number; costUsd?: number }>(
        command,
        taskArgs
      );
      const nextClaudeSessionId = result.sessionId ?? activeSession.claudeSessionId ?? null;
      // Strip out [AIOS_EXPORT_PDF: outputs/<filename>.pdf] markers (used
      // by the agent to request a PDF export of its own answer) and kick off
      // the local renderer. The body of the response BECOMES the PDF; the
      // marker is just a signal. Markers are removed from the displayed text
      // so the chat stays clean.
      const exportMarkerRe = /\[AIOS_EXPORT_PDF:\s*outputs\/([A-Za-z0-9._-]+\.pdf)\s*\]/i;
      const exportMatch = result.response.match(exportMarkerRe);
      // AIOS_ASK marker: `[AIOS_ASK: question | a | b | c]` → render as
      // clickable option buttons under the message. Parse first, then strip
      // the marker alongside the PDF one in a single cleanup pass.
      const askMarkerRe = /\[AIOS_ASK:\s*([^\]\r\n]+)\]/i;
      const askMatch = result.response.match(askMarkerRe);
      let askOptions: { question: string; options: string[] } | null = null;
      if (askMatch) {
        const parts = askMatch[1].split("|").map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          askOptions = {
            question: parts[0],
            options: parts.slice(1, 6), // hard cap at 5 buttons
          };
        }
      }
      // AIOS_CONNECT marker: `[AIOS_CONNECT: slack]` → render an inline
      // Connect chip that jumps to the Connectors page. Slug must be a
      // simple lowercase token (matches Composio slug convention).
      const connectMarkerRe = /\[AIOS_CONNECT:\s*([a-z][a-z0-9_-]*)\s*\]/i;
      const connectMatch = result.response.match(connectMarkerRe);
      let connectRequest: { service: string } | null = null;
      if (connectMatch) {
        connectRequest = { service: connectMatch[1].toLowerCase() };
      }
      // AIOS_ARTIFACT marker: `[AIOS_ARTIFACT: plans/<slug>.md]` or
      // `[AIOS_ARTIFACT: outputs/<slug>.md]` — Claude is pointing at a file
      // it saved inside the workspace. Renderer attaches a clickable chip
      // (same shape as the PDF export attachment, just opened externally).
      const artifactMarkerRe = /\[AIOS_ARTIFACT:\s*((?:plans|outputs)\/[A-Za-z0-9._\/-]+\.[A-Za-z0-9]+)\s*\]/i;
      const artifactMatch = result.response.match(artifactMarkerRe);
      let artifactAttachment: import("../types").ChatAttachment | null = null;
      if (artifactMatch) {
        const relPath = artifactMatch[1];
        const filename = relPath.split("/").pop() ?? relPath;
        const kind: "plan" | "output" = relPath.startsWith("plans/") ? "plan" : "output";
        artifactAttachment = { kind, path: relPath, filename };
      }
      const cleanedResponse = result.response
        .replace(/\[AIOS_EXPORT_PDF:[^\]\r\n]+\]/gi, "")
        .replace(/\[AIOS_ASK:[^\]\r\n]+\]/gi, "")
        .replace(/\[AIOS_CONNECT:[^\]\r\n]+\]/gi, "")
        .replace(/\[AIOS_ARTIFACT:[^\]\r\n]+\]/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      let pdfAttachment: import("../types").ChatAttachment | null = null;
      if (exportMatch) {
        const filename = exportMatch[1];
        try {
          const exportRes = await invoke<{ ok: boolean; path: string; filename: string }>(
            "export_to_pdf",
            { markdown: cleanedResponse, filename }
          );
          if (exportRes?.ok && exportRes.path) {
            pdfAttachment = { kind: "output", path: exportRes.path, filename: exportRes.filename };
          }
        } catch {
          /* PDF rendering is best-effort; chat still shows the text answer */
        }
      }
      // Plan mode: if Claude called ExitPlanMode this turn, the captured
      // plan markdown lives in pendingPlanRef. Wrap it as planProposal on
      // the assistant message; the renderer will show a Plan card instead
      // of the normal markdown bubble.
      const planProposal = pendingPlanRef.current
        ? { content: pendingPlanRef.current, promptToReplay: finalText, status: "pending" as const }
        : null;
      pendingPlanRef.current = null;
      const saved = {
        ...nextSession,
        messages: nextSession.messages.map((message) =>
          // CRUCIAL: explicitly null `streamId` on the saved assistant message.
          // Without this, the snapshot's stale streamId clobbers the cleared
          // value App.tsx set when `done` fired, leaving streamingBusy=true
          // forever — the "Claude is thinking…" indicator gets stuck even
          // though the full response has rendered.
          message.id === assistant.id
            ? {
                ...message,
                content: cleanedResponse,
                streamId: null,
                attachments: (() => {
                  let next = message.attachments ?? [];
                  if (pdfAttachment) next = [...next, pdfAttachment];
                  if (artifactAttachment) next = [...next, artifactAttachment];
                  return next.length ? next : undefined;
                })(),
                askOptions: askOptions ?? message.askOptions,
                connectRequest: connectRequest ?? message.connectRequest,
                planProposal: planProposal ?? message.planProposal,
                runMeta: {
                  model: selectedModel,
                  durationMs: result.durationMs,
                  costUsd: result.costUsd,
                },
              }
            : message
        ),
        updatedAt: new Date().toISOString(),
        claudeSessionId: nextClaudeSessionId
      };
      setRuntimeMeta({ sessionId: result.sessionId, durationMs: result.durationMs, costUsd: result.costUsd });
      await saveUpdatedSession(saved);
      await onRefreshWorkspace();
    } catch (error) {
      // Cancelled streams come back as CLAUDE_CANCELLED — render a soft
      // "Cancelled." line, not a scary "Claude Code failed: ..." error.
      // CLAUDE_AUTH_REQUIRED means the Claude CLI's saved token expired;
      // render a re-login chip instead of dumping the 401 JSON at the user.
      const raw = error instanceof Error ? error.message : String(error);
      const isCancelled = /CLAUDE_CANCELLED|Cancelled\./i.test(raw);
      const isAuthError =
        /CLAUDE_AUTH_REQUIRED/i.test(raw) ||
        /invalid authentication credentials/i.test(raw) ||
        /please run \/login/i.test(raw);
      let content: string;
      if (isCancelled) {
        content = "Cancelled.";
      } else if (isAuthError) {
        content = "Your Claude session has expired. Re-login to continue, then send your message again.";
      } else {
        content = `Claude Code failed: ${raw}`;
      }
      const assistant: ChatMessage = {
        id: activeStreamRef.current?.assistantId ?? newId("msg"),
        role: "assistant",
        content,
        createdAt: new Date().toISOString(),
        reloginPrompt: isAuthError || undefined
      };
      await saveUpdatedSession({
        ...nextSession,
        messages: nextSession.messages.map((message) => (message.id === assistant.id ? assistant : message)),
        updatedAt: new Date().toISOString()
      });
      setRuntimeMeta(null);
    } finally {
      activeStreamRef.current = null;
      setBusy(false);
      setActivity(null);
    }
  }

  // ─── Composer palette: slash commands + @ mentions ──────────────────────
  type PaletteIcon = React.ComponentType<{ size?: number }>;
  type SlashCommand = {
    id: string;
    label: string;
    hint: string;
    icon: PaletteIcon;
    // Action commands fire run() immediately (clear / new / open page).
    // Prompt commands populate the input with a canned Claude prompt the user
    // can tweak then send — covers /prime + workflow shortcuts.
    run?: () => void | Promise<void>;
    prompt?: string;
  };

  function clearChat() {
    if (!activeSession) return;
    onSessionsChange((current) =>
      current.map((s) =>
        s.id === activeSession.id ? { ...s, messages: [], claudeSessionId: null } : s
      )
    );
    setRuntimeMeta(null);
  }

  const slashCommands: SlashCommand[] = useMemo(
    () => [
      // Actions — run locally, no Claude call
      { id: "new", label: "/new", hint: "Start a fresh chat", icon: Plus, run: () => onNewChat?.() },
      { id: "clear", label: "/clear", hint: "Clear this chat's history", icon: Eraser, run: clearChat },
      { id: "model", label: "/model", hint: "Pick the Claude model", icon: Cpu, run: () => setModelMenuOpen(true) },
      { id: "sources", label: "/sources", hint: "Attach files to this message", icon: Paperclip, run: () => attachInputRef.current?.click() },

      // Claude prompts — populate the input, user reviews then sends
      { id: "prime", label: "/prime", hint: "Seed your workspace with foundational context", icon: Sparkles, prompt: "/prime" },
      { id: "summary", label: "/summary", hint: "Summarize the current workspace state", icon: FileText, prompt: "Summarize my AIOS workspace — context files, connectors, recent activity. Highlight what's strong, thin, or missing." },
      { id: "review", label: "/review", hint: "Review the context layer for gaps", icon: ShieldCheck, prompt: "Review my AIOS context files (personal-info, business-info, strategy, current-data). Call out what's strong, what's thin, and what's missing — be specific." },
      { id: "next", label: "/next", hint: "Find the single highest-leverage next action", icon: ArrowUp, prompt: "Based on my AIOS workspace, what is the single highest-leverage next action I should take this week? Explain why in one sentence." },
      { id: "plan", label: "/plan", hint: "Generate a practical plan from my workspace", icon: ClipboardList, prompt: "Create a practical plan from my current AIOS workspace context. Group by 'this week', 'this month', and 'this quarter'. Keep each item concrete and owned by me." },
      { id: "goals", label: "/goals", hint: "Surface your top goals from the context layer", icon: Target, prompt: "Read my context files and tell me the top 3 goals I'm working toward in the next 90 days, in order of urgency." },
      { id: "goal", label: "/goal", hint: "Run autonomously until a condition is met (Claude Code-style)", icon: Target, prompt: "/goal " },
      { id: "team", label: "/team", hint: "Coordinate parallel specialists for a complex task (OpenClaw-style)", icon: Users, prompt: "/team " },
      { id: "audit", label: "/audit", hint: "Audit tasks, blockers, and progress", icon: ListChecks, prompt: "Audit my current Tasks (Kanban) and AutoTasks. Tell me what's stuck, what's at risk, and what's quietly succeeding. Be blunt." },
      { id: "brief-today", label: "/today", hint: "Generate today's daily brief", icon: Sun, prompt: "Generate today's daily brief: priorities, blockers, what's due, what's at risk. Pull from my workspace and recent activity. Tight and skimmable." },
      { id: "help", label: "/help", hint: "Show what AIOS can do for you", icon: HelpCircle, prompt: "Explain what AIOS Desktop can do for me right now given my current connectors, agents, and workspace context. Give me 5 concrete things I should try this week." },

      // Navigation
      { id: "agents", label: "/agents", hint: "Open the Agents page", icon: Users, run: () => onNavigate("agents") },
      { id: "tasks", label: "/tasks", hint: "Open the Tasks board", icon: ClipboardList, run: () => onNavigate("tasks") },
      { id: "connectors", label: "/connectors", hint: "Manage connected services", icon: Plug, run: () => onNavigate("connectors") },
      { id: "go-context", label: "/go-context", hint: "Open the Context layer", icon: FileText, run: () => onNavigate("context") },
      { id: "history", label: "/history", hint: "Open the chat history", icon: Clock, run: () => onNavigate("history") },
      { id: "outputs", label: "/outputs", hint: "Open outputs", icon: FolderOpen, run: () => onNavigate("outputs") },
      { id: "go-plans", label: "/go-plans", hint: "Open saved plans", icon: Layers, run: () => onNavigate("plans") },
      { id: "modules", label: "/modules", hint: "Open the modules library", icon: Boxes, run: () => onNavigate("modules") },
      { id: "imports", label: "/imports", hint: "Open imported files", icon: Inbox, run: () => onNavigate("imports") },
      { id: "brief", label: "/brief", hint: "Open the Brief page", icon: Sun, run: () => onNavigate("briefs") },
      { id: "settings", label: "/settings", hint: "Open settings", icon: Settings, run: () => onNavigate("settings") }
    ],
    [activeSession?.id, onNewChat, onNavigate]
  );

  const slashIds = useMemo(() => slashCommands.map((c) => c.id), [slashCommands]);

  const AGENT_ICONS: Record<string, PaletteIcon> = {
    ceo: Crown,
    product: Sparkles,
    engineering: Wrench,
    marketing: Megaphone,
    sales: TrendingUp,
    operations: Building2,
    finance: DollarSign,
    research: Microscope,
    assistant: Wand2,
    content: PenLine
  };

  type MentionItem = {
    id: string;
    label: string;
    group: "agent" | "connector" | "folder";
    detail: string;
    icon: PaletteIcon;
    // Folders only — absolute on-disk path so commitPaletteSelection can pass
    // it through to run_task as --add-dir. Undefined for agents/connectors.
    absolutePath?: string;
  };

  const mentions: MentionItem[] = useMemo(() => {
    const agentItems: MentionItem[] = agents.map((a) => ({
      id: `agent:${a.id}`,
      label: a.name,
      group: "agent",
      detail: a.role,
      icon: AGENT_ICONS[a.id] || Briefcase
    }));
    const connectorItems: MentionItem[] = (connections || [])
      .filter((c) => c.status === "connected")
      .map((c) => ({
        id: `connector:${c.id}`,
        label: c.label,
        group: "connector",
        detail: c.detail || c.status,
        icon: Plug
      }));
    // Marked import folders — surface in the @ palette so the user can attach
    // a previously-organized folder by name without re-picking it.
    const folderItems: MentionItem[] = markedFolders.slice(0, 20).map((f) => ({
      id: `folder:${f.name}`,
      label: f.name,
      group: "folder",
      detail: "Import folder",
      icon: Folder,
      absolutePath: f.absolutePath,
    }));
    return [...agentItems, ...connectorItems, ...folderItems];
  }, [agents, connections, markedFolders]);

  function detectTrigger(value: string, cursor: number): PaletteState {
    // Slash: only when the entire prompt up to the cursor is "/<query>" with
    // nothing else. That keeps it from misfiring mid-sentence.
    if (value.startsWith("/")) {
      const head = value.slice(0, cursor);
      if (!/\s/.test(head)) {
        return { kind: "slash", query: head.slice(1), from: 0 };
      }
    }
    // @: trigger at start of input OR after whitespace. Active until the next
    // whitespace, so the user types "@gma" and we filter "gma" against mentions.
    for (let i = cursor - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === " " || ch === "\n" || ch === "\t") break;
      if (ch === "@") {
        const prev = i === 0 ? " " : value[i - 1];
        if (prev === " " || prev === "\n" || prev === "\t" || i === 0) {
          return { kind: "at", query: value.slice(i + 1, cursor), from: i };
        }
        break;
      }
    }
    return { kind: "none" };
  }

  function handlePromptChange(value: string, cursor: number) {
    setPrompt(value);
    const next = detectTrigger(value, cursor);
    setPalette(next);
    setPaletteIndex(0);
  }

  const filteredSlash = useMemo(() => {
    if (palette.kind !== "slash") return [] as SlashCommand[];
    const q = palette.query.toLowerCase();
    return slashCommands.filter((c) => c.id.toLowerCase().startsWith(q));
  }, [palette, slashCommands]);

  const filteredMentions = useMemo(() => {
    if (palette.kind !== "at") return [] as MentionItem[];
    const q = palette.query.toLowerCase();
    if (!q) return mentions;
    return mentions.filter((m) => m.label.toLowerCase().includes(q));
  }, [palette, mentions]);

  type PaletteRow = {
    id: string;
    label: string;
    hint: string;
    icon: PaletteIcon;
    group?: "command" | "agent" | "connector" | "folder";
  };

  const paletteList: PaletteRow[] =
    palette.kind === "slash"
      ? filteredSlash.map((c) => ({ id: c.id, label: c.label, hint: c.hint, icon: c.icon, group: "command" as const }))
      : palette.kind === "at"
      ? filteredMentions.map((m) => ({ id: m.id, label: `@${m.label}`, hint: m.detail, icon: m.icon, group: m.group }))
      : [];

  const safePaletteIndex = paletteList.length === 0 ? 0 : Math.min(paletteIndex, paletteList.length - 1);

  function closePalette() {
    setPalette({ kind: "none" });
    setPaletteIndex(0);
  }

  function commitPaletteSelection() {
    if (palette.kind === "slash") {
      const cmd = filteredSlash[safePaletteIndex];
      if (!cmd) return;
      closePalette();
      if (cmd.prompt !== undefined) {
        // Prompt-style command — load the canned prompt into the input,
        // place caret at end, focus the textarea. User reviews and presses
        // Enter to send.
        const text = cmd.prompt;
        setPrompt(text);
        requestAnimationFrame(() => {
          composerRef.current?.focus();
          composerRef.current?.setSelectionRange(text.length, text.length);
        });
        return;
      }
      setPrompt("");
      if (cmd.run) void cmd.run();
      return;
    }
    if (palette.kind === "at") {
      const item = filteredMentions[safePaletteIndex];
      if (!item) return;
      const cursor = composerRef.current?.selectionStart ?? prompt.length;
      const before = prompt.slice(0, palette.from);
      const after = prompt.slice(cursor);
      // Folder picks are represented entirely by the attachment chip — strip
      // the `@partial` the user typed and don't insert any mention text, so
      // the composer doesn't end up showing both a chip AND a stray @token.
      if (item.group === "folder" && item.absolutePath) {
        const folderPath = item.absolutePath;
        const folderName = item.label;
        const next = before + after;
        const caret = before.length;
        setPrompt(next);
        setAttachments((current) => {
          if (current.some((a) => a.kind === "folder" && a.path === folderPath)) return current;
          return [
            ...current,
            { kind: "folder", name: folderName, path: folderPath },
          ];
        });
        closePalette();
        requestAnimationFrame(() => {
          composerRef.current?.setSelectionRange(caret, caret);
          composerRef.current?.focus();
        });
        return;
      }
      // Agents / connectors stay as inline @-text — the overlay highlighter
      // turns them into styled chips inside the textarea.
      const inserted = `@${item.label} `;
      const next = before + inserted + after;
      const caret = (before + inserted).length;
      setPrompt(next);
      closePalette();
      requestAnimationFrame(() => {
        composerRef.current?.setSelectionRange(caret, caret);
        composerRef.current?.focus();
      });
    }
  }

  // Find every @AgentName token in a message and return the matching agents.
  // Greedy match by longest name first so "Customer Support" wins over the
  // bare "Customer" prefix when both exist.
  function collectMentionedAgents(text: string): AgentInfo[] {
    const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
    const seen = new Set<string>();
    const result: AgentInfo[] = [];
    let i = 0;
    while (i < text.length) {
      if (text[i] === "@") {
        const rest = text.slice(i + 1);
        let matched: AgentInfo | null = null;
        for (const agent of sorted) {
          if (rest.toLowerCase().startsWith(agent.name.toLowerCase())) {
            const boundary = rest[agent.name.length];
            if (boundary === undefined || /[\s\W]/.test(boundary)) {
              matched = agent;
              break;
            }
          }
        }
        if (matched && !seen.has(matched.id)) {
          seen.add(matched.id);
          result.push(matched);
        }
        if (matched) {
          i += 1 + matched.name.length;
          continue;
        }
      }
      i++;
    }
    return result;
  }

  function buildChatSystemPrompt(mentioned: AgentInfo[]): string {
    // Chat mode persona — INTENTIONALLY lightweight. We don't inject the full
    // agent task-mode prompt because that's all delegation/routing logic that
    // conflicts with "respond conversationally." Claude gets the role + chat
    // posture; it's smart enough to speak in character from that.
    if (mentioned.length === 1) {
      const agent = mentioned[0];
      return (
        `You are ${agent.name}, the ${agent.role} on this user's AI team. ` +
        `Stay in character throughout this reply. Be concise, conversational, ` +
        `and decisive — answer like a real ${agent.role} would in a quick chat. ` +
        `Skip any preamble about who you are; just answer the user's question. ` +
        `Do NOT emit [ASSIGN_TASK:], [SPAWN_AGENT:], [NEEDS_CONNECTOR:], or ` +
        `[BLOCKED:] sentinels — this is a direct chat, not a background task.`
      );
    }
    const team = mentioned.map((a) => `${a.name} (${a.role})`).join(", ");
    return (
      `You are speaking on behalf of a coordinated team the user has addressed ` +
      `together: ${team}. Reply as ONE unified voice that draws on each role's ` +
      `expertise — don't fragment into separate speakers. Be concise and ` +
      `conversational. Skip any preamble about who you are. Do NOT emit ` +
      `[ASSIGN_TASK:], [SPAWN_AGENT:], [NEEDS_CONNECTOR:], or [BLOCKED:] ` +
      `sentinels — this is a direct chat, not a background task.`
    );
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (palette.kind !== "none" && paletteList.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setPaletteIndex((cur) => (cur + 1) % paletteList.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setPaletteIndex((cur) => (cur - 1 + paletteList.length) % paletteList.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        commitPaletteSelection();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        commitPaletteSelection();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
        return;
      }
    }
    // Shift+Tab — cycle permission mode (Default → Plan → Accept edits).
    // Mirrors Claude Code CLI behavior. Palette-block already returned above
    // if palette is open, so this only fires in normal composer state.
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      cycleMode();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendPrompt(prompt);
      return;
    }
    // Cmd+Enter / Ctrl+Enter — explicit send, also works WITH Shift held
    // (some users wire Shift+Enter as "send" muscle memory from Slack/etc).
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendPrompt(prompt);
      return;
    }
    // Escape while a turn is in flight → cancel the current stream
    // (calls cancel_chat_stream IPC from v0.2.44). Outside busy, Escape
    // does nothing — user can still type normally.
    if (event.key === "Escape" && effectiveBusy) {
      event.preventDefault();
      const sid = activeStreamRef.current?.streamId;
      if (sid) {
        void invoke("cancel_chat_stream", { streamId: sid }).catch(() => undefined);
      }
    }
  }

  return (
    <section
      className={`aios-chat-screen ${dragActive ? "is-drop-target" : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive ? (
        <div className="aios-chat-drop-overlay" aria-hidden="true">
          <div className="aios-chat-drop-card">
            <Folder size={28} />
            <strong>Drop to attach</strong>
            <span>Folders attach as references; files upload into your chat.</span>
          </div>
        </div>
      ) : null}
      <div className={`aios-chat-panel ${hasRealMessages ? "has-history" : "is-empty"}`}>
          {!claude?.found ? <MissingClaude claude={claude} onDetect={onDetectClaude} /> : null}
          {!onboarding?.completedAt && !hasRealMessages ? (
            <div className="aios-chat-setup">
              <div className="subtle-note">
                <strong>Setup incomplete.</strong> Claude works now, but context quality is still thin.
              </div>
              <button className="button button-ghost compact" onClick={() => onNavigate("onboarding")}>
                <Sparkles />
                Finish setup
              </button>
            </div>
          ) : null}

          <div className="aios-chat-header">
            <div className="aios-chat-title-block" />
            <div className="aios-chat-meta">
              <StatusBadge tone={claude?.found && claude.runtimeOk ? "success" : "warning"} label={claude?.found && claude.runtimeOk ? "Connected" : "Check Claude"} />
            </div>
          </div>

          {activeSession?.activeTeam && !teamBannerDismissed ? (
            <TeamProgressBanner
              team={activeSession.activeTeam}
              onAbort={() => {
                void invoke("team_abort", { sessionId: activeSession.id }).catch(() => undefined);
              }}
              onDismiss={() => {
                setTeamBannerDismissed(true);
                // Also clear the activeTeam from the session entirely so the
                // banner doesn't pop back on app restart.
                onSessionsChange((current) => current.map((s) => {
                  if (s.id !== activeSession.id) return s;
                  const updated = { ...s, activeTeam: null };
                  void invoke("save_session", { session: updated }).catch(() => undefined);
                  return updated;
                }));
              }}
            />
          ) : null}
          {activeSession?.activeGoal && !goalBannerDismissed ? (
            <GoalProgressBanner
              goal={activeSession.activeGoal}
              onAbort={() => {
                void invoke("goal_abort", { sessionId: activeSession.id }).catch(() => undefined);
              }}
              onResume={() => {
                if (!activeSession.activeGoal || !claude?.path) return;
                void invoke("goal_start", {
                  sessionId: activeSession.id,
                  condition: activeSession.activeGoal.condition,
                  claudePath: claude.path,
                  resumeFromTurn: activeSession.activeGoal.turn,
                  claudeSessionId: activeSession.claudeSessionId ?? null,
                }).catch(() => undefined);
              }}
              onDismiss={() => {
                setGoalBannerDismissed(true);
                // Clear activeGoal from the session entirely so dismissal
                // persists across app restart (otherwise the banner pops back
                // every time the user reopens AIOS because the goal record is
                // still on the SQLite session row).
                onSessionsChange((current) => current.map((s) => {
                  if (s.id !== activeSession.id) return s;
                  const updated = { ...s, activeGoal: null };
                  void invoke("save_session", { session: updated }).catch(() => undefined);
                  return updated;
                }));
              }}
            />
          ) : null}

          <div
            className="aios-chat-thread"
            ref={threadRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
              setIsScrolledUp(distanceFromBottom > 120);
            }}
          >
            {!hasRealMessages && !busy ? (
              <div className="aios-chat-empty">
                <div className="aios-chat-orb" aria-hidden="true">A</div>
                <p className="aios-chat-kicker">AIOS · Command</p>
                {contextReady ? (
                  <>
                    <h2>
                      {displayName ? <>Welcome back, {displayName}. What are we <em>moving</em> today?</> : <>Welcome back. What are we <em>moving</em> today?</>}
                    </h2>
                    <p>I've got your context loaded. Pick a starting point — or just tell me what you need.</p>
                    <div className="aios-chat-onboarding-cards">
                      <button
                        className="aios-chat-onboarding-card"
                        onClick={() => {
                          const seed = "Based on my context, what's the single highest-leverage thing I should do right now? Be specific and tell me why.";
                          setPrompt(seed);
                          window.setTimeout(() => { const ta = composerRef.current; if (ta) { ta.focus(); ta.setSelectionRange(seed.length, seed.length); } }, 0);
                        }}
                      >
                        <div className="aios-onboarding-card-icon"><Sparkles size={16} /></div>
                        <div className="aios-onboarding-card-body">
                          <strong>What should I focus on?</strong>
                          <span>I'll weigh your priorities and name the single highest-leverage next move.</span>
                        </div>
                      </button>
                      <button
                        className="aios-chat-onboarding-card"
                        onClick={() => {
                          const seed = "Brief me on where things stand right now — my priorities, what's in motion, and anything that needs my attention.";
                          setPrompt(seed);
                          window.setTimeout(() => { const ta = composerRef.current; if (ta) { ta.focus(); ta.setSelectionRange(seed.length, seed.length); } }, 0);
                        }}
                      >
                        <div className="aios-onboarding-card-icon"><Command size={16} /></div>
                        <div className="aios-onboarding-card-body">
                          <strong>Brief me</strong>
                          <span>Where things stand — priorities, what's in motion, what needs attention.</span>
                        </div>
                      </button>
                      <button
                        className="aios-chat-onboarding-card"
                        onClick={() => {
                          const seed = "Draft my highest-priority deliverable right now. Pick the most important one from my context, then produce a real first draft I can use.";
                          setPrompt(seed);
                          window.setTimeout(() => { const ta = composerRef.current; if (ta) { ta.focus(); ta.setSelectionRange(seed.length, seed.length); } }, 0);
                        }}
                      >
                        <div className="aios-onboarding-card-icon"><FileText size={16} /></div>
                        <div className="aios-onboarding-card-body">
                          <strong>Draft my top priority</strong>
                          <span>I'll pick your most important deliverable and produce a usable first draft.</span>
                        </div>
                      </button>
                      <button
                        className="aios-chat-onboarding-card"
                        onClick={() => { window.setTimeout(() => composerRef.current?.focus(), 0); }}
                      >
                        <div className="aios-onboarding-card-icon"><MessageSquare size={16} /></div>
                        <div className="aios-onboarding-card-body">
                          <strong>Just chat</strong>
                          <span>Type anything below — I already know your context.</span>
                        </div>
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h2>
                      {displayName ? <>Hi {displayName} — let's set up your <em>context</em>.</> : <>Let's set up your <em>context</em>.</>}
                    </h2>
                    <p>I'm your AIOS. The more I know about your work, the more useful I get. Pick one to start — or just type below.</p>
                    <div className="aios-chat-onboarding-cards">
                      <button
                        className="aios-chat-onboarding-card"
                        onClick={() => { void pickFolderAttachment(); }}
                      >
                        <div className="aios-onboarding-card-icon"><FileText size={16} /></div>
                        <div className="aios-onboarding-card-body">
                          <strong>Import a folder</strong>
                          <span>Point me at your work folder — notes, docs, a project — and I'll read it as context.</span>
                        </div>
                      </button>
                      <button
                        className="aios-chat-onboarding-card"
                        onClick={() => {
                          const seed = "Interview me about what I do, what I'm working on, and what would make me more effective. Ask one question at a time, then save what you learn to my context.";
                          setPrompt(seed);
                          window.setTimeout(() => {
                            const ta = composerRef.current;
                            if (ta) { ta.focus(); ta.setSelectionRange(seed.length, seed.length); }
                          }, 0);
                        }}
                      >
                        <div className="aios-onboarding-card-icon"><MessageSquare size={16} /></div>
                        <div className="aios-onboarding-card-body">
                          <strong>Interview me</strong>
                          <span>I'll ask a few questions about your work and write the answers into your context.</span>
                        </div>
                      </button>
                      <button
                        className="aios-chat-onboarding-card"
                        onClick={() => {
                          const seed = "/prime";
                          setPrompt(seed);
                          window.setTimeout(() => {
                            const ta = composerRef.current;
                            if (ta) { ta.focus(); ta.setSelectionRange(seed.length, seed.length); }
                          }, 0);
                        }}
                      >
                        <div className="aios-onboarding-card-icon"><Command size={16} /></div>
                        <div className="aios-onboarding-card-body">
                          <strong>Show me what AIOS can do</strong>
                          <span>Run /prime — I'll summarise your workspace and suggest the best next move.</span>
                        </div>
                      </button>
                      <button
                        className="aios-chat-onboarding-card"
                        onClick={() => {
                          window.setTimeout(() => composerRef.current?.focus(), 0);
                        }}
                      >
                        <div className="aios-onboarding-card-icon"><Sparkles size={16} /></div>
                        <div className="aios-onboarding-card-body">
                          <strong>Just chat</strong>
                          <span>Skip setup for now — type anything below and we'll get going.</span>
                        </div>
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {renderedMessages.map((message) => (
              <article className={`aios-message ${message.role}`} key={message.id}>
                <div className="aios-message-meta">
                  <div className="aios-message-role">
                    {message.role === "assistant" ? (
                      <>
                        <div className="avatar avatar-ai">
                          <Bot size={13} />
                        </div>
                        <span>AIOS / Claude</span>
                      </>
                    ) : (
                      <>
                        <div className="avatar avatar-user">
                          <MessageSquare size={13} />
                        </div>
                        <span>You</span>
                      </>
                    )}
                  </div>
                  <time>{formatRelativeTime(message.createdAt)}</time>
                </div>
                <div className="aios-message-body">
                  {message.content.trim() ? (
                    <div className="aios-markdown">
                      {message.role === "user" ? (
                        // User-bubble: render plain text but highlight every
                        // @AgentName token as a sage chip — same parser the
                        // composer overlay uses, so the bubble matches what
                        // the user saw while typing.
                        <p className="aios-user-text">
                          {renderHighlightedPrompt(message.content, mirrorEntities, slashIds)}
                        </p>
                      ) : (
                        <MessageMarkdown content={message.content} />
                      )}
                    </div>
                  ) : (
                    <div className="inline-thinking">
                      <div className="typing-indicator">
                        <span className="typing-dot" />
                        <span className="typing-dot" />
                        <span className="typing-dot" />
                      </div>
                      <span>Claude is thinking</span>
                    </div>
                  )}
                  {message.role === "assistant" && message.attachments && message.attachments.length > 0 ? (
                    <div className="aios-attachment-list">
                      {message.attachments.map((att) => (
                        <button
                          key={`${att.kind}:${att.path}`}
                          type="button"
                          className={`aios-attachment-chip kind-${att.kind}`}
                          onClick={() => onOpenAttachment?.(att)}
                          title={`Open ${att.kind === "plan" ? "plan" : "output"} in AIOS`}
                        >
                          <FileText size={14} />
                          <span className="aios-attachment-name">{att.filename}</span>
                          <span className="aios-attachment-kind">{att.kind === "plan" ? "Plan" : "Output"}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {message.role === "assistant" && message.runMeta && (message.runMeta.durationMs || message.runMeta.costUsd) ? (
                    <div className="aios-run-meta" aria-label="run details">
                      {formatRunMeta(message.runMeta)}
                    </div>
                  ) : null}
                  {message.role === "assistant" && message.connectRequest ? (
                    <div className="aios-connect-card" data-testid="connect-chip">
                      <span className="aios-connect-card-icon"><Plug size={14} /></span>
                      <div className="aios-connect-card-body">
                        <strong>Connect {message.connectRequest.service}</strong>
                        <p>Opens the Connectors page so you can authorize this service. Once connected, ask again and Claude will use it.</p>
                      </div>
                      <button
                        type="button"
                        className="button button-primary compact"
                        onClick={() => onNavigate("connectors")}
                      >
                        Connect
                      </button>
                    </div>
                  ) : null}
                  {message.role === "assistant" && message.reloginPrompt ? (
                    <div className="aios-connect-card" data-testid="relogin-chip">
                      <span className="aios-connect-card-icon"><Plug size={14} /></span>
                      <div className="aios-connect-card-body">
                        <strong>Re-login Claude</strong>
                        <p>Copies <code>claude /login</code> to your clipboard and opens Terminal. Paste, hit return, finish sign-in in the browser, then re-send your message.</p>
                      </div>
                      <button
                        type="button"
                        className="button button-primary compact"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText("claude /login");
                          } catch {}
                          try {
                            await invoke("open_claude_login_terminal", {});
                          } catch {}
                        }}
                      >
                        Re-login
                      </button>
                    </div>
                  ) : null}
                  {message.role === "assistant" && message.planProposal ? (
                    <div className={`aios-plan-card status-${message.planProposal.status ?? "pending"}`} data-testid="plan-card">
                      <div className="aios-plan-card-eyebrow">Ready to code?</div>
                      <p className="aios-plan-card-intro">Here is Claude's plan:</p>
                      <div className="aios-plan-card-panel">
                        <MessageMarkdown content={message.planProposal.content} />
                      </div>
                      {(message.planProposal.status ?? "pending") === "pending" ? (
                        <>
                          <p className="aios-plan-card-prompt">What do you want to do?</p>
                          <div className="aios-plan-card-options" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              className="aios-plan-option"
                              onClick={() => acceptPlanWithMode(message, "default")}
                            >
                              <span className="aios-plan-option-arrow" aria-hidden="true">❯</span>
                              <span className="aios-plan-option-digit">1.</span>
                              <span className="aios-plan-option-text">
                                <span className="aios-plan-option-label">Run the full plan</span>
                                <span className="aios-plan-option-sub">Claude does everything: edits files and runs commands.</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="aios-plan-option"
                              onClick={() => acceptPlanWithMode(message, "acceptEdits")}
                            >
                              <span className="aios-plan-option-arrow" aria-hidden="true">❯</span>
                              <span className="aios-plan-option-digit">2.</span>
                              <span className="aios-plan-option-text">
                                <span className="aios-plan-option-label">Only edit files</span>
                                <span className="aios-plan-option-sub">Claude changes files but won't run any commands.</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="aios-plan-option"
                              onClick={() => rejectPlan(message)}
                            >
                              <span className="aios-plan-option-arrow" aria-hidden="true">❯</span>
                              <span className="aios-plan-option-digit">3.</span>
                              <span className="aios-plan-option-text">
                                <span className="aios-plan-option-label">Not yet — let me refine</span>
                                <span className="aios-plan-option-sub">Dismisses the plan. Adjust your prompt and ask again.</span>
                              </span>
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="aios-plan-card-status">
                          {message.planProposal.status === "accepted" ? "Plan accepted — running below." : "Plan dismissed — keep refining your prompt."}
                        </div>
                      )}
                    </div>
                  ) : null}
                  {message.role === "assistant" && message.askOptions && message.askOptions.options.length > 0 ? (
                    <div className="aios-ask-card" data-testid="ask-options">
                      {message.askOptions.question ? (
                        <p className="aios-ask-question">{message.askOptions.question}</p>
                      ) : null}
                      <div className="aios-ask-options">
                        {message.askOptions.options.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            className="aios-ask-option"
                            onClick={() => {
                              // Clear the options on click so the buttons disappear
                              // (prevents double-pick) and send the option text as
                              // the next user message.
                              const sessionId = activeSession?.id;
                              if (sessionId) {
                                onSessionsChange((current) => current.map((s) => {
                                  if (s.id !== sessionId) return s;
                                  return {
                                    ...s,
                                    messages: s.messages.map((m) => m.id === message.id
                                      ? { ...m, askOptions: undefined }
                                      : m
                                    ),
                                  };
                                }));
                              }
                              void sendPrompt(opt);
                            }}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
                {message.role === "assistant" && message.content.trim() ? <MessageActions content={message.content} /> : null}
              </article>
            ))}
            {busy && !realMessages.some((message) => message.id === activeStreamRef.current?.assistantId) ? (
              <article className="aios-message assistant pending-assistant">
                <div className="aios-message-meta">
                  <div className="aios-message-role">
                    <div className="avatar avatar-ai">
                      <Bot size={13} />
                    </div>
                    <span>AIOS / Claude</span>
                  </div>
                  <time>Working</time>
                </div>
                <div className="pending-shell">
                  <div className="typing-indicator">
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                  </div>
                  <p>{activity ? friendlyActivityLabel(activity) : "Claude is thinking"}{elapsedSeconds >= 2 ? ` · ${elapsedSeconds}s` : ""}</p>
                  {activity?.summary ? <code className="activity-detail">{activity.summary}</code> : null}
                </div>
              </article>
            ) : busy && (() => {
              const last = renderedMessages[renderedMessages.length - 1];
              const lastIsEmptyAssistant = last?.role === "assistant" && !last.content?.trim();
              if (lastIsEmptyAssistant) return null;
              const stopBtn = (
                <button
                  type="button"
                  className="aios-activity-stop"
                  onClick={() => {
                    const sid = activeStreamRef.current?.streamId;
                    if (sid) {
                      void invoke("cancel_chat_stream", { streamId: sid }).catch(() => undefined);
                    }
                  }}
                  title="Stop this turn"
                  aria-label="Stop"
                  data-testid="chat-stop"
                >
                  <Square size={11} />
                  Stop
                </button>
              );
              if (activity) {
                return (
                  <div className="aios-activity-row">
                    <Loader2 size={13} className="spin" />
                    <span className="aios-activity-label">{friendlyActivityLabel(activity)}{elapsedSeconds >= 2 ? ` · ${elapsedSeconds}s` : ""}</span>
                    {activity.summary ? <code className="aios-activity-detail">{activity.summary}</code> : null}
                    {stopBtn}
                  </div>
                );
              }
              if (selectedEffort === "ultracode") {
                const mins = Math.floor(elapsedSeconds / 60);
                const elapsedLabel = mins >= 1 ? `${mins}m ${elapsedSeconds % 60}s` : `${elapsedSeconds}s`;
                return (
                  <div className="aios-activity-row aios-activity-thinking is-workflow">
                    <Loader2 size={13} className="spin" />
                    <span className="aios-activity-label">Running a workflow{elapsedSeconds >= 2 ? ` · ${elapsedLabel}` : ""}</span>
                    <code className="aios-activity-detail">agents working in the background — one report at the end. Minutes is normal.</code>
                    {stopBtn}
                  </div>
                );
              }
              return (
                <div className="aios-activity-row aios-activity-thinking">
                  <Loader2 size={13} className="spin" />
                  <span className="aios-activity-label">Claude is thinking…{elapsedSeconds >= 2 ? ` · ${elapsedSeconds}s` : ""}</span>
                  {stopBtn}
                </div>
              );
            })() }
          </div>

          {isScrolledUp ? (
            <button
              type="button"
              className="aios-jump-to-latest"
              onClick={() => {
                const thread = threadRef.current;
                if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
              }}
              aria-label="Jump to latest message"
              data-testid="jump-to-latest"
            >
              <ArrowDown size={13} /> Latest
            </button>
          ) : null}
          {pendingQueue.length > 0 ? (
            <div className="aios-composer-queue" aria-label="Messages queued to send when Claude finishes" data-testid="composer-queue">
              <span className="aios-composer-queue-label">Queued · sends in order</span>
              <div className="aios-composer-queue-chips">
                {pendingQueue.map((q, idx) => {
                  const preview = q.text.trim().slice(0, 48) + (q.text.length > 48 ? "…" : "");
                  return (
                    <span key={`${idx}:${q.text.slice(0, 12)}`} className="aios-composer-queue-chip" title={q.text}>
                      <span>{preview || "(attachments only)"}</span>
                      <button
                        type="button"
                        className="aios-composer-queue-remove"
                        onClick={() => {
                          setPendingQueue((cur) => cur.filter((_, i) => i !== idx));
                        }}
                        aria-label="Remove from queue"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}

          <form
            className="aios-composer"
            onSubmit={(event) => {
              event.preventDefault();
              sendPrompt(prompt);
            }}
          >
            <input
              ref={attachInputRef}
              className="hidden-input"
              type="file"
              multiple
              onChange={(event) => {
                if (event.target.files && event.target.files.length > 0) {
                  uploadAttachments(event.target.files);
                }
                event.target.value = "";
              }}
            />
            {attachments.length > 0 ? (
              <div className="aios-composer-attachments">
                {attachments.map((att) => {
                  const isFolder = att.kind === "folder";
                  const ChipIcon = isFolder ? Folder : Paperclip;
                  return (
                    <span
                      key={att.path}
                      className={`aios-attachment-chip ${isFolder ? "is-folder" : ""} ${att.requiresTccPrompt ? "needs-tcc" : ""} ${isFolder ? "is-clickable" : ""}`}
                      title={
                        att.requiresTccPrompt
                          ? `${att.path} — macOS may prompt you to allow AIOS to read this folder. Click Allow when it appears.`
                          : isFolder ? `${att.path} — click to see what's inside` : att.path
                      }
                      onClick={isFolder ? () => setPreviewFolder(att) : undefined}
                      role={isFolder ? "button" : undefined}
                      tabIndex={isFolder ? 0 : undefined}
                    >
                      <ChipIcon size={11} />
                      <span className="aios-attachment-name">{isFolder ? `${att.name}/` : att.name}</span>
                      {att.requiresTccPrompt ? (
                        <span className="aios-attachment-tcc" aria-hidden="true">macOS will prompt</span>
                      ) : null}
                      <button
                        type="button"
                        className="aios-attachment-remove"
                        onClick={(e) => { e.stopPropagation(); removeAttachment(att.path); }}
                        aria-label={`Remove ${att.name}`}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : null}
            <div className="aios-composer-input-line">
              {palette.kind !== "none" && paletteList.length > 0 ? (
                <div className={`aios-palette is-${palette.kind}`} role="listbox">
                  <p className="aios-palette-kind">
                    {palette.kind === "slash" ? "Commands" : "Mentions"}
                  </p>
                  {paletteList.map((item, idx) => {
                    const Icon = item.icon;
                    const isActive = idx === safePaletteIndex;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        ref={isActive
                          ? (el) => {
                              if (el) el.scrollIntoView({ block: "nearest" });
                            }
                          : undefined}
                        aria-selected={isActive}
                        className={`aios-palette-item is-${item.group ?? "command"} ${isActive ? "is-active" : ""}`}
                        onMouseEnter={() => setPaletteIndex(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setPaletteIndex(idx);
                          commitPaletteSelection();
                        }}
                      >
                        <span className={`aios-palette-avatar is-${item.group ?? "command"}`} aria-hidden="true">
                          <Icon size={14} />
                        </span>
                        <span className="aios-palette-text">
                          <span className="aios-palette-label">{item.label}</span>
                          <span className="aios-palette-hint">{item.hint}</span>
                        </span>
                        {item.group ? (
                          <span className={`aios-palette-group is-${item.group}`}>{item.group}</span>
                        ) : null}
                        {idx === safePaletteIndex ? (
                          <span className="aios-palette-key" aria-hidden="true">↵</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <div className="aios-composer-mirror" aria-hidden="true" ref={mirrorRef}>
                {renderHighlightedPrompt(prompt, mirrorEntities, slashIds)}
                {/* Trailing zero-width char keeps the mirror's height in sync
                    with the textarea when the prompt ends with a newline. */}
                {"​"}
              </div>
              <textarea
                ref={composerRef}
                value={prompt}
                onScroll={(event) => {
                  // Sync mirror scroll position with textarea so the highlighted
                  // glyphs stay aligned with the visible textarea content when a
                  // long pasted prompt scrolls. Without this, the mirror sits
                  // static while textarea content moves — caret + chips desync.
                  if (mirrorRef.current) {
                    mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
                  }
                }}
                onChange={(event) => {
                  const cursor = event.target.selectionStart ?? event.target.value.length;
                  handlePromptChange(event.target.value, cursor);
                }}
                onKeyUp={(event) => {
                  // Caret moved without text change (arrow keys, click) — re-evaluate
                  // the trigger so the palette opens/closes as the user navigates.
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
                    const target = event.currentTarget;
                    const cursor = target.selectionStart ?? target.value.length;
                    setPalette(detectTrigger(target.value, cursor));
                    setPaletteIndex(0);
                  }
                }}
                onKeyDown={handleComposerKeyDown}
                onBlur={() => {
                  // Defer so click-to-select in the palette still fires.
                  window.setTimeout(closePalette, 100);
                }}
                placeholder={effectiveBusy ? "Type your next message — it'll send when Claude finishes" : "Ask anything — type / for commands or @ to mention"}
                disabled={!claude?.found || !claude.runtimeOk}
                data-testid="chat-input"
              />
            </div>
            <div className="aios-composer-underbar">
              <div className="aios-source-picker" ref={sourceMenuRef}>
                <button
                  className="aios-composer-action"
                  type="button"
                  onClick={() => setSourceMenuOpen((open) => !open)}
                  disabled={uploadingAttachment}
                  title={effectiveBusy ? "Attach files for your queued next message" : "Attach files or a folder to this message"}
                  aria-haspopup="menu"
                  aria-expanded={sourceMenuOpen}
                >
                  {uploadingAttachment ? <Loader2 size={14} className="spin" /> : <Paperclip size={14} />}
                  {uploadingAttachment ? "Uploading…" : "Sources"}
                  <ChevronDown size={11} />
                </button>
                {sourceMenuOpen ? (
                  <div className="aios-source-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="aios-source-menu-item"
                      onClick={() => {
                        setSourceMenuOpen(false);
                        attachInputRef.current?.click();
                      }}
                    >
                      <Paperclip size={13} />
                      <span className="aios-source-menu-text">
                        <strong>File</strong>
                        <span>Upload one or more files</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="aios-source-menu-item"
                      onClick={pickFolderAttachment}
                    >
                      <Folder size={13} />
                      <span className="aios-source-menu-text">
                        <strong>Folder</strong>
                        <span>Pick a folder — Claude reads it like a project</span>
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="aios-model-picker">
                <button
                  ref={modelButtonRef}
                  type="button"
                  className="aios-model-pill"
                  onClick={() => setModelMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen}
                  title="Pick the Claude model for this chat (applies to queued and next messages)"
                >
                  <span>{CHAT_MODELS.find((m) => m.id === selectedModel)?.label ?? "Default"}</span>
                  <ChevronDown size={12} />
                </button>
                {modelMenuOpen ? (
                  <div ref={modelMenuRef} className="aios-model-menu" role="menu">
                    {CHAT_MODELS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="menuitem"
                        className={`aios-model-option ${selectedModel === m.id ? "is-active" : ""}`}
                        onClick={() => pickModel(m.id)}
                      >
                        <span className="aios-model-option-text">
                          <strong>{m.label}</strong>
                          <span>{m.description}</span>
                        </span>
                        {selectedModel === m.id ? <Check size={12} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="aios-model-picker">
                <button
                  ref={effortButtonRef}
                  type="button"
                  className="aios-model-pill"
                  onClick={() => setEffortMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={effortMenuOpen}
                  title="Reasoning effort. Workflows (beta) lets Claude orchestrate many agents — needs Claude Code 2.1.154+."
                >
                  <Sparkles size={12} />
                  <span>{EFFORT_OPTIONS.find((e) => e.id === selectedEffort)?.label ?? "Auto"}</span>
                  <ChevronDown size={12} />
                </button>
                {effortMenuOpen ? (
                  <div ref={effortMenuRef} className="aios-model-menu" role="menu">
                    {EFFORT_OPTIONS.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        role="menuitem"
                        className={`aios-model-option ${selectedEffort === e.id ? "is-active" : ""}`}
                        onClick={() => pickEffort(e.id)}
                      >
                        <span className="aios-model-option-text">
                          <strong>{e.label}</strong>
                          <span>{e.description}</span>
                        </span>
                        {selectedEffort === e.id ? <Check size={12} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {selectedEffort === "ultracode" && !cliSupportsWorkflows(claude?.version) ? (
                <span className="aios-workflow-note" title="Dynamic workflows require Claude Code 2.1.154 or newer">
                  <Lightbulb size={12} />
                  Workflows need Claude Code 2.1.154+ — update to unlock. Running as Deep for now.
                </span>
              ) : null}
              {!planHintSeen && mode === "default" && (activeSession?.messages ?? []).some((m) => m.role === "assistant" && m.askOptions) ? (
                <button
                  type="button"
                  className="aios-plan-hint"
                  onClick={() => { pickMode("plan"); dismissPlanHint(); }}
                  title="Switch this chat to Plan mode"
                >
                  <Lightbulb size={12} />
                  <span>Tip: switch to <strong>Plan mode</strong> (⇧⇥) so Claude plans before acting</span>
                  <span
                    className="aios-plan-hint-x"
                    role="button"
                    aria-label="Dismiss tip"
                    onClick={(e) => { e.stopPropagation(); dismissPlanHint(); }}
                  >
                    <X size={11} />
                  </span>
                </button>
              ) : null}
              <div className="aios-mode-picker">
                <button
                  ref={modeButtonRef}
                  type="button"
                  className={`aios-mode-pill is-${mode}`}
                  onClick={() => setModeMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={modeMenuOpen}
                  title="Permission mode for this chat (Shift+Tab to cycle)"
                >
                  {(() => {
                    const current = MODE_OPTIONS.find((m) => m.id === mode) ?? MODE_OPTIONS[0];
                    const Icon = current.Icon;
                    return (
                      <>
                        <Icon size={13} />
                        <span>{current.label}</span>
                        <ChevronDown size={12} />
                      </>
                    );
                  })()}
                </button>
                {modeMenuOpen ? (
                  <div ref={modeMenuRef} className="aios-mode-menu" role="menu">
                    {MODE_OPTIONS.map((m) => {
                      const Icon = m.Icon;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          role="menuitem"
                          className={`aios-mode-option ${mode === m.id ? "is-active" : ""}`}
                          onClick={() => pickMode(m.id)}
                        >
                          <span className="aios-mode-option-icon"><Icon size={14} /></span>
                          <span className="aios-mode-option-text">
                            <strong>{m.label}</strong>
                            <span>{m.description}</span>
                          </span>
                          {mode === m.id ? <Check size={12} /> : null}
                        </button>
                      );
                    })}
                    <div className="aios-mode-menu-hint">Shift+Tab to cycle</div>
                  </div>
                ) : null}
              </div>
              <span className="aios-composer-hint">{voiceError ?? (listening ? "Listening... click mic to stop" : transcribing ? "Transcribing..." : effectiveBusy ? `${activity ? friendlyActivityLabel(activity) : "Claude is thinking…"}${elapsedSeconds >= 2 ? ` · ${elapsedSeconds}s` : ""}${pendingQueue.length > 0 ? ` · ${pendingQueue.length} queued` : ""}` : "")}</span>
              <div className="aios-composer-right">
                <button
                  className={`aios-composer-tool ${listening ? "active" : ""}`}
                  type="button"
                  title={listening ? "Stop voice input" : "Voice input"}
                  onClick={toggleVoiceInput}
                  disabled={effectiveBusy || transcribing}
                >
                  {transcribing ? <Loader2 size={15} className="spin" /> : <Mic size={15} />}
                </button>
                <button
                  className="aios-send-btn"
                  disabled={!prompt.trim() || !claude?.found || !claude.runtimeOk}
                  type="submit"
                  aria-label={effectiveBusy ? "Queue message — sends when Claude finishes" : "Send message"}
                  title={effectiveBusy ? `Queue (${pendingQueue.length + 1} pending after send)` : "Send"}
                >
                  <ArrowUp size={15} />
                </button>
              </div>
            </div>
          </form>
      </div>
      {previewFolder ? (
        <FolderPreviewModal folder={previewFolder} onClose={() => setPreviewFolder(null)} />
      ) : null}
    </section>
  );
}

function FolderPreviewModal({ folder, onClose }: { folder: { name: string; path: string }; onClose: () => void }) {
  const [entries, setEntries] = useState<Array<{ name: string; path: string; size?: number; modifiedAt?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<{ entries: Array<{ name: string; path: string; size?: number; modifiedAt?: string }>; error?: string }>(
      "list_external_directory",
      { path: folder.path, limit: 200 }
    )
      .then((res) => {
        if (cancelled) return;
        setEntries(res?.entries ?? []);
        setError(res?.error ?? null);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [folder.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="detail-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="detail-modal-card folder-preview-card" onClick={(e) => e.stopPropagation()}>
        <header className="detail-modal-head">
          <div>
            <span className="eyebrow">Folder preview</span>
            <h2>{folder.name}</h2>
            <p className="folder-preview-path">{folder.path}</p>
          </div>
          <button type="button" className="detail-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="folder-preview-body">
          {loading ? (
            <div className="folder-preview-loading"><Loader2 size={16} className="spin" /> Loading…</div>
          ) : error ? (
            <div className="folder-preview-empty">{error}</div>
          ) : entries.length === 0 ? (
            <div className="folder-preview-empty">Folder is empty.</div>
          ) : (
            <ul className="folder-preview-list">
              {entries.map((e) => (
                <li key={e.path}>
                  <span className="folder-preview-name">{e.name}</span>
                  {e.size !== undefined ? <span className="folder-preview-size">{formatBytes(e.size)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="folder-preview-foot">
          {entries.length > 0 ? <span>{entries.length} {entries.length === 1 ? "file" : "files"}</span> : null}
        </footer>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function MissingClaude({ claude, onDetect }: { claude: ClaudeStatus | null; onDetect: () => Promise<ClaudeStatus> }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="inline-notice warning-inline">
      <div>
        <PanelHeader eyebrow="Runtime" title="Claude Code is not connected" detail="AIOS uses the real Claude CLI as its backend." />
        <div className="warning-copy">
          <AlertTriangle size={14} />
          <p>{claude?.runtimeError || claude?.error || "Re-run detection if the terminal install changed or your PATH updated after launch."}</p>
        </div>
      </div>
      <button
        className="button button-primary compact"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          await onDetect();
          setChecking(false);
        }}
      >
        {checking ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
        Reconnect Claude
      </button>
    </div>
  );
}

