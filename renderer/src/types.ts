export type AiosCommand =
  | "get_workspace_info"
  | "get_onboarding_state"
  | "save_onboarding_answer"
  | "complete_onboarding"
  | "complete_onboarding_freeform"
  | "reset_onboarding"
  | "reset_workspace"
  | "read_file"
  | "write_file"
  | "append_file"
  | "move_file"
  | "list_modules"
  | "install_module"
  | "get_context_summary"
  | "list_workspace_files"
  | "list_workspace_section"
  | "list_directory"
  | "list_external_directory"
  | "browse_external_directory"
  | "open_external_path"
  | "reveal_external_path"
  | "get_recent_workspace_activity"
  | "read_markdown_preview"
  | "list_outputs"
  | "list_plans"
  | "list_shares"
  | "get_sessions"
  | "create_thread"
  | "rename_thread"
  | "delete_thread"
  | "save_session"
  | "run_prime"
  | "run_task"
  | "get_setting"
  | "set_setting"
  | "find_claude"
  | "set_claude_path"
  | "test_claude_connection"
  | "reveal_in_file_manager"
  | "transcribe_audio"
  | "restore_context_template"
  | "write_binary_file"
  | "list_imports"
  | "delete_import"
  | "toggle_import_marker"
  | "list_marked_import_folders"
  | "link_folder"
  | "unlink_folder"
  | "list_linked_folders"
  | "pick_folder"
  | "list_auto_tasks"
  | "create_auto_task"
  | "update_auto_task"
  | "delete_auto_task"
  | "toggle_auto_task"
  | "list_recent_auto_runs"
  | "list_due_auto_tasks"
  | "begin_auto_task_run"
  | "finish_auto_task_run"
  | "advance_auto_task"
  | "delete_workspace_file"
  | "run_auto_task_now"
  | "get_today_brief_status"
  | "generate_daily_brief"
  | "list_daily_briefs"
  | "mark_brief_seen"
  | "list_import_folder"
  | "create_import_folder"
  | "delete_import_folder"
  | "update_claude_mcp"
  | "rotate_device_user_id"
  | "list_connector_status"
  | "list_agents"
  | "get_agent"
  | "update_agent_prompt"
  | "reset_agent_prompt"
  | "delete_agent"
  | "create_custom_agent"
  | "screen_capture"
  | "screen_ax_tree"
  | "voice_click"
  | "voice_type"
  | "voice_hotkey"
  | "voice_scroll"
  | "voice_move"
  | "voice_open"
  | "voice_drag"
  | "voice_clipboard_get"
  | "voice_clipboard_set"
  | "voice_wait"
  | "voice_check_environment"
  | "voice_get_cursor_type"
  | "mac_check_permissions"
  | "mac_request_permission"
  | "control_panel_toggle"
  | "control_panel_open"
  | "control_panel_close"
  | "control_bubble_toggle"
  | "control_bubble_show"
  | "control_bubble_hide"
  | "control_bubble_drag_start"
  | "control_bubble_drag_to"
  | "control_bubble_drag_end"
  | "control_panel_get_docked"
  | "control_panel_set_docked"
  | "cursor_overlay_get_active"
  | "cursor_overlay_set_active"
  | "cursor_overlay_get_color"
  | "cursor_overlay_set_color"
  | "control_close_all"
  | "control_open_settings"
  | "control_panel_prepare_mic"
  | "control_panel_release_mic"
  | "voice_control_start"
  | "voice_control_stop"
  | "voice_control_abort"
  | "voice_control_state"
  | "goal_start"
  | "goal_abort"
  | "goal_status"
  | "team_start"
  | "team_abort"
  | "team_status"
  | "list_tasks"
  | "get_task"
  | "create_task"
  | "task_action"
  | "cancel_task"
  | "cancel_chat_stream"
  | "delete_task"
  | "whatsapp_status"
  | "whatsapp_start"
  | "whatsapp_stop"
  | "export_to_pdf"
  | "install_claude"
  | "open_claude_login_terminal";

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  default_prompt: string;
  custom_prompt: string | null;
  effective_prompt: string;
  parent_id: string | null;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

export interface TaskInfo {
  id: string;
  name: string;
  message: string;
  agent_id: string;
  priority: number;
  status:
    | "pending"
    | "in_progress"
    | "awaiting_children"
    | "completed"
    | "failed"
    | "blocked"
    | "awaiting_connection"
    | "awaiting_approval"
    | "cancelled";
  result: string | null;
  narrative: Array<{ kind?: string; role?: string; text?: string; agentId?: string; ts?: string }>;
  claude_session_id: string | null;
  blocked_reason: string | null;
  needs_connector: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  parent_task_id: string | null;
  synthesis_pass: boolean;
  synthesis_round?: number;
}

export interface DailyBrief {
  id: number;
  briefDate: string;
  generatedAt: string;
  headline: string | null;
  content: string;
}

export interface DailyBriefStatus {
  shouldShow: boolean;
  todayDate: string;
  firstInstallDate: string | null;
  lastBriefSeenDate: string | null;
  existingBrief: DailyBrief | null;
}

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface AiosApi {
  invoke<T = unknown>(cmd: AiosCommand, args?: Record<string, unknown>): Promise<ApiResponse<T>>;
  getPathForFile: (file: File) => string;
  onHostEvent: (callback: (event: HostEvent) => void) => () => void;
  onCursorPosition: (callback: (pos: { x: number; y: number }) => void) => () => void;
  onCursorColor: (callback: (color: string) => void) => () => void;
  onCursorFlyTo: (callback: (target: { x: number; y: number; durationMs: number }) => void) => () => void;
  onCursorMessage: (callback: (msg: { text: string; durationMs: number }) => void) => () => void;
  onCursorBusy: (callback: (state: { busy: boolean }) => void) => () => void;
  onCursorType: (callback: (type: string) => void) => () => void;
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  cacheTheme: (theme: string) => Promise<{ ok: boolean }>;
  openOauthWindow: (url: string) => Promise<{ ok: boolean; completed?: boolean; error?: string }>;
  getVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{ ok: boolean; reason?: string; error?: string; currentVersion?: string; latestVersion?: string; hasUpdate?: boolean; manualDownloadUrl?: string }>;
  installUpdate: () => Promise<{ ok: boolean; reason?: string; error?: string }>;
  onUpdateState: (callback: (event: { state: string; version?: string; percent?: number; message?: string; manualDownloadUrl?: string }) => void) => () => void;
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    onMaximizedChanged: (callback: (maximized: boolean) => void) => void;
    onShortcutPreferences: (callback: () => void) => void;
    onShortcutVoiceToggle: (callback: () => void) => () => void;
  };
}

export interface HostEvent<T = unknown> {
  id: string;
  event: string;
  data: T;
}

export interface ClaudeToolUseEvent {
  id: string;
  name: string;
  summary: string;
  // Only populated when name === "ExitPlanMode" — the full plan markdown
  // Claude proposed in plan mode. Renderer uses it to render a Plan card.
  plan?: string;
}

export interface ClaudeToolResultEvent {
  toolUseId: string;
  isError: boolean;
}

export interface ClaudeStreamEvent {
  streamId: string;
  delta?: string;
  response?: string;
  sessionId?: string;
  durationMs?: number;
  costUsd?: number;
  done?: boolean;
  toolUse?: ClaudeToolUseEvent;
  toolResult?: ClaudeToolResultEvent;
}

declare global {
  interface Window {
    aios: AiosApi;
  }
}

export interface ModuleInfo {
  id: string;
  name: string;
  description: string;
  source: string;
  installPath: string;
  phase: number;
  available?: boolean;
  sourceExists: boolean;
  installed: boolean;
  installedAt: string | null;
  enabled: boolean;
  readiness: string;
  capability?: string;
  requires?: string[];
  artifacts?: string[];
  connections?: string[];
  // Connectors-page service slugs this module needs configured before install.
  // E.g. ["github"] or ["stripe", "youtube", "google-analytics", "google-sheets"].
  // The /install command refuses to proceed if any are missing.
  requiredConnectors?: string[];
  builtIn?: boolean;
  builtInRoute?: string | null;
  builtInButtonLabel?: string | null;
}

export interface WorkspaceInfo {
  workspaceRoot: string;
  hasClaudeMd: boolean;
  platform: string;
  settingsDb: string;
  modules: ModuleInfo[];
  deviceUserId: string;
  // Cached from settings DB so the renderer can render an optimistic Claude
  // status on cold start without paying for a subprocess spawn. Verified in
  // the background after splash dismisses.
  claudePath?: string | null;
  claudeVersion?: string | null;
}

export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  checked: string[];
  error?: string;
  runtimeOk?: boolean;
  runtimeError?: string;
}

export interface ChatAttachment {
  // Workspace area the file lives in — drives which screen we route to when
  // the chip is clicked. Currently only used for plans and outputs surfaced
  // through WhatsApp Remote, but the shape is generic enough to extend later.
  kind: "plan" | "output";
  // Workspace-relative path (e.g. "plans/2026-05-14-jokes-plan.md") so it can
  // be matched against WorkspaceEntry.path on the destination screen.
  path: string;
  // Display label shown inside the chip.
  filename: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  // When set, this assistant message is still streaming. App-level claude_stream
  // listener fills in `content` by matching this id. Cleared when `done` fires.
  // Without this, navigating away from chat mid-stream would lose the response.
  streamId?: string | null;
  // Optional file chips rendered under the message body. Populated today by
  // the WhatsApp Remote scanner when a plan or output PDF has been delivered;
  // clicking a chip jumps to the matching Plans / Outputs screen with that
  // file pre-opened.
  attachments?: ChatAttachment[];
  // When set, Claude offered the user a closed-set multiple-choice. Parsed
  // from an `[AIOS_ASK: question | a | b | c]` marker stripped from `content`.
  // Renderer renders clickable option buttons under the message. Click sends
  // the option text as the user's next message and clears askOptions on this
  // bubble so the buttons disappear (prevents double-pick).
  askOptions?: { question: string; options: string[] };
  // When set, Claude flagged that a connector is needed. Parsed from
  // `[AIOS_CONNECT: <slug>]` marker. Renderer renders an inline Connect
  // chip — click navigates to Connectors so the user can complete OAuth
  // without manually hunting the page.
  connectRequest?: { service: string };
  // When set, the Claude CLI's saved OAuth token is invalid (401 / "Please
  // run /login"). Renderer shows a "Re-login Claude" chip that copies the
  // `claude /login` command to the clipboard and tries to open Terminal so
  // the user can paste + run it. Re-sending the message after re-login uses
  // the same session — no app restart.
  reloginPrompt?: boolean;
  // When set, this assistant message was produced in Plan mode and Claude
  // emitted an ExitPlanMode tool call. Renderer renders a Plan card with
  // Accept / Reject buttons instead of a normal markdown bubble. Accepting
  // re-invokes run_task with promptToReplay + bypassPermissions, then
  // appends a new assistant message with the actual execution.
  planProposal?: { content: string; promptToReplay: string; status?: "pending" | "accepted" | "rejected" };
  // Per-turn run metadata shown as a subtle muted row under the assistant
  // bubble: which model answered, how long it took, what it cost. Removes the
  // "is this slow because it's hard or because it's broken?" ambiguity.
  runMeta?: { model?: string; durationMs?: number; costUsd?: number };
}

export type ChatPermissionMode = "default" | "plan" | "acceptEdits";

export type GoalStatus = "active" | "met" | "aborted" | "exhausted";

export interface ActiveGoal {
  condition: string;
  turn: number;
  maxTurns: number;
  tokensSpent: number;
  costUsd?: number;
  startedAt: string;
  lastReason?: string;
  status: GoalStatus;
}

export type TeamPhase = "decomposing" | "running" | "aggregating" | "done" | "aborted" | "error";
export type SpecialistStatus = "pending" | "running" | "done" | "failed" | "timeout";

export interface SpecialistResult {
  agentId: string;
  agentName: string;
  subtask: string;
  status: SpecialistStatus;
  reason?: string; // why this specialist was picked (from coordinator)
  durationMs?: number;
}

export interface ActiveTeam {
  task: string;
  phase: TeamPhase;
  specialists: SpecialistResult[];
  startedAt: string;
  tokensSpent: number;
  costUsd?: number;
  errorMessage?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt?: string;
  claudeSessionId?: string | null;
  permissionMode?: ChatPermissionMode;
  activeGoal?: ActiveGoal | null;
  activeTeam?: ActiveTeam | null;
}

export interface WorkspaceEntry {
  path: string;
  kind: "context" | "import" | "output" | "plan" | "share" | "reference" | "script" | "module" | "file";
  name: string;
  extension: string;
  modifiedAt: string;
  size: number;
  preview: string;
  isDir: boolean;
}

export interface ContextFileSummary {
  path: string;
  exists: boolean;
  preview: string;
}

export interface AutoTaskRun {
  id: number;
  taskId: number;
  startedAt: string;
  finishedAt: string | null;
  status: "pending" | "success" | "failed";
  outputPath: string | null;
  costUsd: number | null;
  error: string | null;
  taskName?: string;
}

export interface AutoTask {
  id: number;
  name: string;
  prompt: string;
  schedule: string;
  scheduleLabel: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  createdAt: string;
  recentRuns: AutoTaskRun[];
}

export interface ImportedContextSummary {
  path: string;
  name: string;
  preview: string;
  updatedAt: string;
}

export interface ContextSummary {
  files: ContextFileSummary[];
  imports: ImportedContextSummary[];
}

export interface ContextSection {
  id: "personal" | "business" | "strategy" | "current-data";
  title: string;
  path: string;
  preview: string;
  modifiedAt?: string | null;
}

export interface OutputEntry extends WorkspaceEntry {}
export interface PlanEntry extends WorkspaceEntry {}
export interface RecentActivityEntry extends WorkspaceEntry {}

export interface FilePreview {
  path: string;
  content: string;
  preview: string;
  modifiedAt: string | null;
  kind: WorkspaceEntry["kind"];
}

export interface ConnectionStatus {
  id: string;
  label: string;
  status: "connected" | "warning" | "missing";
  detail: string;
}
