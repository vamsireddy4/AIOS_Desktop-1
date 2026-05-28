import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AiosCommand } from "./types";

const allowedCommands = new Set<AiosCommand>([
  "get_workspace_info",
  "get_onboarding_state",
  "save_onboarding_answer",
  "complete_onboarding",
  "complete_onboarding_freeform",
  "reset_onboarding",
  "reset_workspace",
  "read_file",
  "write_file",
  "append_file",
  "move_file",
  "list_modules",
  "list_skills",
  "list_workflows",
  "install_module",
  "get_context_summary",
  "list_workspace_files",
  "list_workspace_section",
  "list_directory",
  "list_external_directory",
  "browse_external_directory",
  "open_external_path",
  "reveal_external_path",
  "get_recent_workspace_activity",
  "read_markdown_preview",
  "list_outputs",
  "list_plans",
  "list_shares",
  "get_sessions",
  "create_thread",
  "rename_thread",
  "delete_thread",
  "save_session",
  "run_prime",
  "run_task",
  "transcribe_audio",
  "get_setting",
  "set_setting",
  "find_claude",
  "set_claude_path",
  "test_claude_connection",
  "reveal_in_file_manager",
  "restore_context_template",
  "write_binary_file",
  "list_imports",
  "delete_import",
  "toggle_import_marker",
  "list_marked_import_folders",
  "link_folder",
  "unlink_folder",
  "list_linked_folders",
  "pick_folder",
  "list_auto_tasks",
  "create_auto_task",
  "update_auto_task",
  "delete_auto_task",
  "toggle_auto_task",
  "list_recent_auto_runs",
  "list_due_auto_tasks",
  "begin_auto_task_run",
  "finish_auto_task_run",
  "advance_auto_task",
  "delete_workspace_file",
  "run_auto_task_now",
  "get_today_brief_status",
  "generate_daily_brief",
  "list_daily_briefs",
  "mark_brief_seen",
  "list_import_folder",
  "create_import_folder",
  "delete_import_folder",
  "update_claude_mcp",
  "rotate_device_user_id",
  "list_connector_status",
  "list_agents",
  "get_agent",
  "update_agent_prompt",
  "reset_agent_prompt",
  "delete_agent",
  "create_custom_agent",
  "screen_capture",
  "screen_ax_tree",
  "voice_click",
  "voice_type",
  "voice_hotkey",
  "voice_scroll",
  "voice_move",
  "voice_open",
  "voice_drag",
  "voice_clipboard_get",
  "voice_clipboard_set",
  "voice_wait",
  "voice_check_environment",
  "voice_get_cursor_type",
  "mac_check_permissions",
  "mac_request_permission",
  "control_panel_toggle",
  "control_panel_open",
  "control_panel_close",
  "control_bubble_toggle",
  "control_bubble_show",
  "control_bubble_hide",
  "control_bubble_drag_start",
  "control_bubble_drag_to",
  "control_bubble_drag_end",
  "control_panel_get_docked",
  "control_panel_set_docked",
  "cursor_overlay_get_active",
  "cursor_overlay_set_active",
  "cursor_overlay_get_color",
  "cursor_overlay_set_color",
  "control_close_all",
  "control_open_settings",
  "control_panel_prepare_mic",
  "control_panel_release_mic",
  "voice_control_start",
  "voice_control_stop",
  "voice_control_abort",
  "voice_control_state",
  "goal_start",
  "goal_abort",
  "goal_status",
  "team_start",
  "team_abort",
  "team_status",
  "list_tasks",
  "get_task",
  "create_task",
  "task_action",
  "cancel_task",
  "cancel_chat_stream",
  "delete_task",
  "whatsapp_status",
  "whatsapp_start",
  "whatsapp_stop",
  "export_to_pdf",
  "install_claude",
  "open_claude_login_terminal"
]);

contextBridge.exposeInMainWorld("aios", {
  invoke: (cmd: AiosCommand, args: Record<string, unknown> = {}) => {
    if (!allowedCommands.has(cmd)) {
      return Promise.reject(new Error(`Command is not allowed: ${cmd}`));
    }
    return ipcRenderer.invoke("aios:invoke", cmd, args);
  },
  // Electron 32+ removed File.path; webUtils.getPathForFile is the
  // replacement. Exposed here so renderer drag-drop handlers can resolve
  // an absolute filesystem path for a dropped File/folder.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onHostEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("aios:host-event", listener);
    return () => ipcRenderer.removeListener("aios:host-event", listener);
  },
  onCursorPosition: (callback: (pos: { x: number; y: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { x: number; y: number }) => callback(payload);
    ipcRenderer.on("aios:cursor-position", listener);
    return () => ipcRenderer.removeListener("aios:cursor-position", listener);
  },
  onCursorColor: (callback: (color: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: string) => callback(payload);
    ipcRenderer.on("aios:cursor-color", listener);
    return () => ipcRenderer.removeListener("aios:cursor-color", listener);
  },
  onCursorFlyTo: (callback: (target: { x: number; y: number; durationMs: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { x: number; y: number; durationMs: number }) => callback(payload);
    ipcRenderer.on("aios:cursor-fly-to", listener);
    return () => ipcRenderer.removeListener("aios:cursor-fly-to", listener);
  },
  onCursorMessage: (callback: (msg: { text: string; durationMs: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { text: string; durationMs: number }) => callback(payload);
    ipcRenderer.on("aios:cursor-message", listener);
    return () => ipcRenderer.removeListener("aios:cursor-message", listener);
  },
  onCursorBusy: (callback: (state: { busy: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { busy: boolean }) => callback(payload);
    ipcRenderer.on("aios:cursor-busy", listener);
    return () => ipcRenderer.removeListener("aios:cursor-busy", listener);
  },
  onCursorType: (callback: (type: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: string) => callback(payload);
    ipcRenderer.on("aios:cursor-type", listener);
    return () => ipcRenderer.removeListener("aios:cursor-type", listener);
  },
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("aios:open-external", url),
  cacheTheme: (theme: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("aios:cache-theme", theme),
  openOauthWindow: (url: string): Promise<{ ok: boolean; completed?: boolean; error?: string }> =>
    ipcRenderer.invoke("aios:open-oauth-window", url),
  getVersion: (): Promise<string> => ipcRenderer.invoke("aios:get-version"),
  checkForUpdates: (): Promise<{ ok: boolean; reason?: string; error?: string; currentVersion?: string; latestVersion?: string; hasUpdate?: boolean; manualDownloadUrl?: string }> =>
    ipcRenderer.invoke("aios:check-for-updates"),
  installUpdate: (): Promise<{ ok: boolean; reason?: string; error?: string }> =>
    ipcRenderer.invoke("aios:install-update"),
  onUpdateState: (callback: (event: { state: string; version?: string; percent?: number; message?: string; manualDownloadUrl?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { state: string; version?: string; percent?: number; message?: string; manualDownloadUrl?: string }) => callback(payload);
    ipcRenderer.on("aios:update-state", listener);
    return () => ipcRenderer.removeListener("aios:update-state", listener);
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    onMaximizedChanged: (callback: (maximized: boolean) => void) => {
      ipcRenderer.on("window:maximized-changed", (_event, maximized) => callback(maximized));
    },
    onShortcutPreferences: (callback: () => void) => {
      ipcRenderer.on("shortcut:preferences", () => callback());
    },
    onShortcutVoiceToggle: (callback: () => void) => {
      const wrapped = () => callback();
      ipcRenderer.on("shortcut:voice-toggle", wrapped);
      return () => ipcRenderer.removeListener("shortcut:voice-toggle", wrapped);
    }
  }
});
