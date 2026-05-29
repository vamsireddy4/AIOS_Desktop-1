import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell, globalShortcut, session } from "electron";
import { autoUpdater } from "electron-updater";
import { initSentryMain } from "./sentry";
import type { AiosCommand } from "./types";
import { findClaude, validateClaude } from "./claude-finder";

// Init Sentry as early as possible so it catches main-process errors during
// the rest of bootstrap (autoUpdater wire-up, Python sidecar spawn, etc.).
initSentryMain();
import { initLogger, log } from "./logger";
import { PythonHost } from "./python-host";
import { AutoTaskScheduler } from "./scheduler";
import { ensureRuntimeWorkspace, getSourceStarterKit, backfillStarterKit } from "./workspace";
import { startWhatsApp, stopWhatsApp, getWhatsAppStatus, autoStartWhatsApp } from "./whatsapp-scanner";
import { startVoiceLoop, abortVoiceLoop, getVoiceState } from "./voice-control";
import { startGoalLoop, abortGoalLoop, isGoalRunning } from "./goal-orchestrator";
import { startTeamTask, abortTeamTask, isTeamRunning } from "./team-orchestrator";
import {
  installControlPopupHooks,
  toggleControlPopup,
  openControlPopup,
  closeControlPopup,
  destroyControlPopup,
  isPanelDocked,
  setPanelDocked,
  getControlPopup,
  prepareControlPopupForMic,
  releaseControlPopupAfterMic,
} from "./control-popup";
import {
  installControlBubbleHooks,
  showControlBubble,
  hideControlBubble,
  toggleControlBubble,
  destroyControlBubble,
  isBubbleVisible,
  beginBubbleDrag,
  endBubbleDrag,
} from "./control-bubble";
import {
  isCursorOverlayActive,
  setCursorOverlayActive,
  destroyCursorOverlay,
  getCursorColor,
  setCursorColor,
  flyCursorTo,
  showCursorMessage,
  setCursorBusy,
  setCursorOverlayHost,
} from "./cursor-overlay";

let mainWindow: BrowserWindow | null = null;
let host: PythonHost | null = null;
let scheduler: AutoTaskScheduler | null = null;

// Every BrowserWindow that should receive 'aios:host-event' broadcasts.
// Today: the main window + (lazily) the Control popup window. Adding
// new event-listening windows just registers them here.
const eventSubscribers = new Set<BrowserWindow>();
function broadcastHostEvent(event: unknown): void {
  for (const win of eventSubscribers) {
    if (!win.isDestroyed()) {
      try { win.webContents.send("aios:host-event", event); } catch { /* renderer might be reloading */ }
    }
  }
}

app.setName("aios-desktop");
app.setAppUserModelId("com.aios.desktop");

// Single-instance lock. Without this, on Mac:
//   - `open -a "AIOS Desktop"` from terminal or another launcher spawns
//     a second instance
//   - Spotlight launching while already running can do the same
//   - electron-updater's quitAndInstall on Mac sometimes briefly
//     overlaps old + new instances during the swap
// Two instances = two Python sidecars writing to one SQLite file
// (corruption risk), two globalShortcut registrations fighting each
// other, duplicate WhatsApp Baileys session lock collision, two
// bubble + popup windows on screen.
//
// We acquire the lock BEFORE app.whenReady(). If we don't get it,
// quit immediately and let the existing instance handle the launch
// — the second-instance handler in the existing process focuses its
// main window so the user sees AIOS come forward.
//
// Mac-only: this also covers the "double-clicking dock icon launches
// a duplicate" edge case on some macOS versions. Production builds
// of electron apps normally rely on the OS to dedup, but third-party
// launchers (Raycast, Alfred) can bypass that.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

if (!app.isPackaged) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("disable-features", "VizDisplayCompositor");
  app.setPath("userData", path.join(process.cwd(), ".aios-dev-user-data"));
}

const mainHandledCommands = new Set<AiosCommand>([
  "find_claude",
  "set_claude_path",
  "test_claude_connection",
  "reveal_in_file_manager",
  "run_auto_task_now",
  "whatsapp_status",
  "whatsapp_start",
  "whatsapp_stop",
  "export_to_pdf",
  "install_claude",
  "open_claude_login_terminal",
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
  "pick_folder",
  "open_external_path",
  "reveal_external_path"
]);

// Theme cache lives in userData so the main process can pick the right
// backgroundColor BEFORE the renderer (and its localStorage) is loaded.
// Without this, dark-theme users see ~100ms of light paper before HTML
// parses and the inline boot splash applies dark tokens.
function getThemeCachePath(): string {
  return path.join(app.getPath("userData"), "theme-cache.txt");
}

function readCachedTheme(): "light" | "dark" | "auto" {
  try {
    const fs = require("fs");
    const raw = fs.readFileSync(getThemeCachePath(), "utf8").trim().toLowerCase();
    if (raw === "dark" || raw === "auto") return raw;
    return "light";
  } catch {
    return "light";
  }
}

function writeCachedTheme(value: string): void {
  try {
    const fs = require("fs");
    const normalized = value === "dark" || value === "auto" ? value : "light";
    fs.mkdirSync(path.dirname(getThemeCachePath()), { recursive: true });
    fs.writeFileSync(getThemeCachePath(), normalized, "utf8");
  } catch { /* best-effort */ }
}

function backgroundForTheme(theme: "light" | "dark" | "auto"): string {
  if (theme === "dark") return "#0d0d0d";
  if (theme === "auto") {
    const { nativeTheme } = require("electron");
    return nativeTheme?.shouldUseDarkColors ? "#0d0d0d" : "#fafaf7";
  }
  return "#fafaf7";
}

function createWindow(): void {
  // Resolve the icon if it exists (generated by `node assets/generate-icons.js`).
  const iconPath = path.join(__dirname, "..", "..", "assets", "icon.png");
  const fs = require("fs");
  const icon = fs.existsSync(iconPath) ? iconPath : undefined;

  // On Mac use "hiddenInset" so the system traffic-light buttons stay visible
  // (inset into our drag region). On Windows we keep the chromeless look and
  // render our own minimize/maximize/close controls in the renderer.
  const isMac = process.platform === "darwin";
  const cachedTheme = readCachedTheme();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 720,
    title: "AIOS Desktop",
    frame: !isMac ? false : undefined,
    backgroundColor: backgroundForTheme(cachedTheme),
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    icon,
    // Show the window IMMEDIATELY on creation. Earlier we used `show: false`
    // + `ready-to-show` to avoid a brief flash before the renderer painted,
    // but on a cold first launch the renderer can take 2–5 s to produce its
    // first frame — meaning the user saw no window at all after double-
    // clicking the icon, which felt broken. With `backgroundColor` already
    // set to the paper sage, Electron paints the window in the right color
    // the instant it appears, and the inline boot splash in `index.html`
    // takes over a moment later once the renderer loads its HTML. Net effect:
    // the user sees a window confirming their click immediately.
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  // Route every link click / window.open / target=_blank that the renderer
  // emits into the user's default system browser. Without this, Electron
  // either replaces the app window with the destination page or pops up an
  // ugly bare BrowserWindow. The OAuth flow has its own explicit IPC
  // (aios:open-external + aios:open-oauth-window) and isn't affected.
  const internalOrigins = new Set<string>();
  if (devUrl) internalOrigins.add(new URL(devUrl).origin);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const target = new URL(url);
      // Allow same-origin SPA navigation (Vite HMR, route changes inside the
      // renderer); push everything else to the system browser.
      if (target.protocol === "file:" || internalOrigins.has(target.origin)) return;
      event.preventDefault();
      if (target.protocol === "http:" || target.protocol === "https:" || target.protocol === "mailto:") {
        void shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.on("maximize", () => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send("window:maximized-changed", true);
  });
  mainWindow.on("unmaximize", () => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send("window:maximized-changed", false);
  });
  mainWindow.on("closed", () => {
    if (mainWindow) eventSubscribers.delete(mainWindow);
    mainWindow = null;
  });

  // Register main window as an aios:host-event subscriber so broadcasts
  // reach it the same way they reach the Control popup.
  eventSubscribers.add(mainWindow);

  // Auto-show the Computer Control bubble only AFTER the renderer's
  // first frame has actually painted. Earlier we used a flat
  // setTimeout(1500) but on a cold first launch (Mac Gatekeeper /
  // Windows Defender scanning the PyInstaller sidecar) the renderer
  // can still be warming up at 1.5 s — the bubble would pop up first
  // and create an "is the app stuck?" perception when the main window
  // was actually still loading underneath it.
  //
  // Listening for `did-finish-load` and adding a small extra delay
  // (so the React shell actually mounts past its splash) keeps the
  // bubble's appearance tied to the user-visible app state. A 6 s
  // watchdog acts as the safety net in case `did-finish-load` somehow
  // doesn't fire — we'd rather show the bubble than silently swallow
  // it.
  let bubbleShown = false;
  const showOnceWhenReady = () => {
    if (bubbleShown) return;
    bubbleShown = true;
    setTimeout(() => {
      try { showControlBubble(); } catch { /* non-fatal */ }
    }, 600);
  };
  mainWindow.webContents.once("did-finish-load", showOnceWhenReady);
  setTimeout(showOnceWhenReady, 6000);
}

function registerIpcHandlers(): void {
  // Window control IPC handlers
  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.on("window:close", () => mainWindow?.close());

  // Open URL in the OS default browser (used for help/docs links).
  if (ipcMain.handle) {
    ipcMain.removeHandler("aios:cache-theme");
    ipcMain.handle("aios:cache-theme", async (_event, theme: string) => {
      if (typeof theme !== "string") return { ok: false };
      writeCachedTheme(theme);
      return { ok: true };
    });

    ipcMain.removeHandler("aios:open-external");
    ipcMain.handle("aios:open-external", async (_event, url: string) => {
      if (typeof url !== "string") return { ok: false, error: "URL must be a string" };
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Only http/https URLs are allowed" };
      try {
        await shell.openExternal(url);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    ipcMain.removeHandler("aios:open-oauth-window");
    ipcMain.handle("aios:open-oauth-window", async (_event, url: string) => {
      if (typeof url !== "string") return { ok: false, error: "URL must be a string" };
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Only http/https URLs are allowed" };

      const partition = `oauth-${Date.now()}`;
      const oauthSession = session.fromPartition(partition);
      try {
        await oauthSession.clearStorageData();
      } catch { /* fresh partition is already empty */ }

      // Force Google's OAuth flow to show the account picker every time
      oauthSession.webRequest.onBeforeRequest(
        { urls: ["https://accounts.google.com/o/oauth2/*"] },
        (details, callback) => {
          try {
            const url = new URL(details.url);
            if (
              (url.pathname.startsWith("/o/oauth2/v2/auth") || url.pathname.startsWith("/o/oauth2/auth")) &&
              !url.searchParams.has("prompt")
            ) {
              url.searchParams.set("prompt", "select_account");
              callback({ redirectURL: url.toString() });
              return;
            }
          } catch { /* fall through */ }
          callback({});
        }
      );

      return await new Promise<{ ok: boolean; completed?: boolean; error?: string }>((resolve) => {
        const win = new BrowserWindow({
          width: 540,
          height: 720,
          title: "Connect account",
          parent: mainWindow ?? undefined,
          modal: false,
          autoHideMenuBar: true,
          backgroundColor: "#fafaf7",
          webPreferences: {
            session: oauthSession,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            enableWebSQL: false,
          },
        });

        let resolved = false;
        const safeResolve = (payload: { ok: boolean; completed?: boolean; error?: string }) => {
          if (resolved) return;
          resolved = true;
          resolve(payload);
        };

        win.on("closed", () => {
          safeResolve({ ok: true, completed: false });
        });

        win.loadURL(url).catch((err: unknown) => {
          safeResolve({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          try { win.close(); } catch { /* noop */ }
        });
      });
    });
  }

  // Global shortcut for preferences
  globalShortcut.register("Command+,", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("shortcut:preferences");
    }
  });

  // Global shortcut for Computer Control mic — works from any app on
  // the desktop. Per-OS chord because modifier ergonomics differ:
  //   Windows: Ctrl + Alt + V
  //   macOS:   Cmd + Option + V (with V — fallback keyboard shortcut)
  //                              The modifier-only Cmd+Option chord
  //                              is implemented separately in the
  //                              Python sidecar via CGEventTap (see
  //                              _start_mac_voice_shortcut_listener
  //                              in python/host.py).
  // Pressing this Electron-registered chord:
  //   1. Shows the bubble if it isn't already
  //   2. Opens the popup (or focuses if open)
  //   3. Fires `shortcut:voice-toggle` into the popup so the panel
  //      starts mic capture immediately (or stops it if listening).
  const voiceShortcut = process.platform === "darwin"
    ? "Command+Alt+V"
    : "Control+Alt+V";
  const voiceShortcutRegistered = globalShortcut.register(voiceShortcut, () => {
    if (!isBubbleVisible()) showControlBubble();
    // Make sure the popup is OPEN (not just toggled) before we tell
    // the panel to start listening — otherwise we'd start a voice
    // session in a hidden popup.
    openControlPopup();
    sendVoiceToggleWhenReady();
  });
  if (!voiceShortcutRegistered) {
    log("shortcut", "voice-register-failed", { chord: voiceShortcut });
  }
}

// Dispatch a `shortcut:voice-toggle` event to the popup, waiting for the
// renderer to finish loading + mount its listener on the FIRST open.
//
// Originally this was a flat `setTimeout(80)` — fine on Windows where
// the popup renderer mounts fast, but on Mac the cold-open path takes
// 200-500 ms (HTML parse → bundle load → React mount → useEffect
// subscribe). The 80 ms timeout fired before ControlApp.tsx's
// `window.aios.window.onShortcutVoiceToggle` listener was attached, so
// the very first Cmd+Option (or Command+Alt+V) press of a session
// silently lost the toggle and mic capture never started.
//
// We now branch on `webContents.isLoading()`: if loading, hook
// `did-finish-load` and add a 220 ms react-mount buffer; if already
// loaded, fall back to the original 80 ms defer (still useful for
// micro-races during rapid re-presses).
function sendVoiceToggleWhenReady(): void {
  const popup = getControlPopup();
  if (!popup || popup.isDestroyed()) return;
  const send = () => {
    if (!popup.isDestroyed()) popup.webContents.send("shortcut:voice-toggle");
  };
  if (popup.webContents.isLoading()) {
    popup.webContents.once("did-finish-load", () => {
      setTimeout(send, 220);
    });
  } else {
    setTimeout(send, 80);
  }
}


async function getSavedClaudePath(): Promise<string | null> {
  // Tolerant of host-not-ready failures. The Python sidecar may not be
  // up yet on a cold start when the popup fires find_claude, and our
  // post-v0.2.19 fast-fail stdin guard rejects host.invoke immediately
  // when stdin isn't writable. Without this catch, the whole find_claude
  // IPC would propagate the rejection — but find_claude only NEEDS the
  // saved path as a hint; missing it just means we do a fresh
  // filesystem probe instead of validating a cached value. Return null
  // and let findClaude() proceed.
  try {
    const response = await host?.invoke<{ value: string | null }>("get_setting", { key: "claude_path" });
    return response?.ok ? response.data?.value ?? null : null;
  } catch {
    return null;
  }
}

async function handleMainCommand(cmd: AiosCommand, args: Record<string, unknown>) {
  if (!host) throw new Error("Python host not initialized");

  if (cmd === "find_claude") {
    const savedPath = await getSavedClaudePath();
    const result = await findClaude(savedPath);
    if (result.found && result.path) {
      // Best-effort cache write. If the sidecar isn't ready yet (popup
      // called find_claude before Python had warmed up), don't propagate
      // the rejection — the caller still gets a valid detection result.
      // A subsequent find_claude call after the sidecar is up will
      // re-detect and cache then.
      try {
        await host.invoke("set_setting", { key: "claude_path", value: result.path });
        await host.invoke("set_setting", { key: "claude_version", value: result.version ?? "" });
      } catch { /* sidecar not ready — cache opportunistically next time */ }
    }
    return result;
  }

  if (cmd === "set_claude_path") {
    let selectedPath = String(args.path ?? "");
    if (!selectedPath && args.browse === true) {
      const result = await dialog.showOpenDialog({
        title: "Select Claude Code executable",
        properties: ["openFile"]
      });
      selectedPath = result.filePaths[0] ?? "";
    }
    const validation = await validateClaude(selectedPath);
    if (!validation.ok) {
      return { stored: false, ...validation };
    }
    await host.invoke("set_setting", { key: "claude_path", value: selectedPath });
    await host.invoke("set_setting", { key: "claude_version", value: validation.version ?? "" });
    return { stored: true, path: selectedPath, version: validation.version };
  }

  if (cmd === "test_claude_connection") {
    const pathArg = typeof args.path === "string" ? args.path : await getSavedClaudePath();
    if (!pathArg) return { ok: false, version: null, error: "Claude path is not configured." };
    const validation = await validateClaude(pathArg);
    return { ok: validation.ok, path: pathArg, version: validation.version, error: validation.error };
  }

  if (cmd === "reveal_in_file_manager") {
    const relativePath = String(args.path ?? "");
    if (!relativePath) throw new Error("Path is required.");
    const workspaceRoot = ensureRuntimeWorkspace();
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error("Path escapes runtime workspace.");
    }
    shell.showItemInFolder(absolutePath);
    return { ok: true, path: relativePath };
  }

  if (cmd === "pick_folder") {
    // Native folder picker for the chat composer Sources → Folder flow.
    // Reference-by-path (no copy) — we just hand the absolute path back so
    // run_task can forward it as --add-dir to Claude.
    //
    // On Mac we surface a `requiresTccPrompt` hint when the picked folder
    // lives under a TCC-protected root (Documents / Desktop / Downloads /
    // iCloud Drive / Volumes). The first time Claude's subprocess Reads a
    // file inside one of those, macOS will fire a permission prompt; we use
    // this flag to show a tiny in-chat hint so the user isn't surprised.
    const isMacPlatform = process.platform === "darwin";
    const browserWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const result = await (browserWindow
      ? dialog.showOpenDialog(browserWindow, {
          properties: ["openDirectory"],
          title: "Pick a folder to attach",
          buttonLabel: "Attach folder",
        })
      : dialog.showOpenDialog({
          properties: ["openDirectory"],
          title: "Pick a folder to attach",
          buttonLabel: "Attach folder",
        }));
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, path: null, requiresTccPrompt: false };
    }
    const folderPath = result.filePaths[0];
    let requiresTccPrompt = false;
    if (isMacPlatform) {
      const home = app.getPath("home");
      const protectedRoots = [
        path.join(home, "Documents"),
        path.join(home, "Desktop"),
        path.join(home, "Downloads"),
        path.join(home, "Library", "Mobile Documents"),
        "/Volumes",
      ];
      requiresTccPrompt = protectedRoots.some((root) => {
        if (!root) return false;
        return folderPath === root || folderPath.startsWith(`${root}${path.sep}`);
      });
    }
    return { canceled: false, path: folderPath, requiresTccPrompt };
  }

  if (cmd === "open_external_path") {
    // Open an arbitrary absolute file or folder in the OS default handler.
    // shell.openPath handles both: files go to the default app for that
    // extension (.pdf → Preview/Acrobat, .png → Photos, etc.), folders open
    // in Explorer/Finder. No workspace scoping — the path must already be
    // one the user explicitly granted access to (e.g. via pick_folder or
    // by being a Linked Folder they added themselves).
    const targetPath = String(args.path ?? "");
    if (!targetPath || !path.isAbsolute(targetPath)) {
      return { ok: false, error: "Absolute path required" };
    }
    const err = await shell.openPath(targetPath);
    if (err) return { ok: false, error: err };
    return { ok: true };
  }

  if (cmd === "reveal_external_path") {
    // Reveal an arbitrary absolute path in Explorer/Finder with the item
    // selected. Used by the Linked Folder browser footer when the user
    // wants to jump out to the OS file manager from the current folder.
    const targetPath = String(args.path ?? "");
    if (!targetPath || !path.isAbsolute(targetPath)) {
      return { ok: false, error: "Absolute path required" };
    }
    shell.showItemInFolder(targetPath);
    return { ok: true };
  }

  if (cmd === "run_auto_task_now") {
    const taskId = Number(args.taskId);
    if (!Number.isFinite(taskId)) throw new Error("taskId is required.");
    if (!scheduler) throw new Error("Scheduler is not running.");
    scheduler.runOnce(taskId).catch((err) => log("scheduler", "manual run failed", { error: err instanceof Error ? err.message : String(err) }));
    return { ok: true, taskId };
  }

  if (cmd === "whatsapp_status") {
    return getWhatsAppStatus();
  }

  if (cmd === "whatsapp_start") {
    if (!mainWindow) throw new Error("No main window");
    return await startWhatsApp(host, mainWindow);
  }

  if (cmd === "whatsapp_stop") {
    if (!mainWindow) throw new Error("No main window");
    return await stopWhatsApp(mainWindow);
  }

  if (cmd === "voice_control_start") {
    const transcript = String(args.transcript ?? "").trim();
    const claudePath = String(args.claudePath ?? "");
    const maxTurnsArg = Number(args.maxTurns);
    const maxTurns = Number.isFinite(maxTurnsArg) ? maxTurnsArg : undefined;
    if (!transcript) throw new Error("transcript is required");
    if (!claudePath) throw new Error("claudePath is required");
    // Fire and forget — the loop streams state via 'aios:host-event' channel
    // so the renderer doesn't have to block on this IPC for the full run.
    startVoiceLoop({ transcript, claudePath, host, broadcast: broadcastHostEvent, maxTurns }).catch((err) => {
      log("voice", "loop failed", { error: err instanceof Error ? err.message : String(err) });
    });
    return { ok: true, accepted: true };
  }

  if (cmd === "voice_control_stop" || cmd === "voice_control_abort") {
    await abortVoiceLoop(broadcastHostEvent);
    return { ok: true };
  }

  if (cmd === "voice_control_state") {
    return { state: getVoiceState() };
  }

  if (cmd === "goal_start") {
    const sessionId = String(args.sessionId ?? "");
    const condition = String(args.condition ?? "").trim();
    const claudePath = String(args.claudePath ?? "");
    const resumeFromTurn = Number(args.resumeFromTurn) || 0;
    const claudeSessionId = typeof args.claudeSessionId === "string" ? args.claudeSessionId : null;
    if (!sessionId) throw new Error("sessionId is required");
    if (!condition) throw new Error("condition is required");
    if (!claudePath) throw new Error("claudePath is required");
    // Fire and forget — the loop streams progress via aios:host-event so the
    // renderer doesn't block on the full multi-turn run.
    startGoalLoop({ sessionId, condition, claudePath, host, broadcast: broadcastHostEvent, resumeFromTurn, claudeSessionId }).catch((err) => {
      log("goal", "loop failed", { error: err instanceof Error ? err.message : String(err) });
    });
    return { ok: true, accepted: true };
  }

  if (cmd === "goal_abort") {
    const sessionId = String(args.sessionId ?? "");
    if (!sessionId) throw new Error("sessionId is required");
    await abortGoalLoop(sessionId, broadcastHostEvent);
    return { ok: true };
  }

  if (cmd === "goal_status") {
    const sessionId = String(args.sessionId ?? "");
    if (!sessionId) throw new Error("sessionId is required");
    return { active: isGoalRunning(sessionId) };
  }

  if (cmd === "team_start") {
    const sessionId = String(args.sessionId ?? "");
    const task = String(args.task ?? "").trim();
    const claudePath = String(args.claudePath ?? "");
    if (!sessionId) throw new Error("sessionId is required");
    if (!task) throw new Error("task is required");
    if (!claudePath) throw new Error("claudePath is required");
    // Pull the agent directory so the coordinator knows what specialists
    // exist + their effective_prompt. Renderer already has list_agents
    // wired; we just call Python directly here.
    let agents: any[] = [];
    try {
      const res = (await host.invoke("list_agents", {})) as any;
      const data = res?.data ?? res;
      agents = Array.isArray(data?.agents) ? data.agents : [];
    } catch (err) {
      log("team", "list_agents failed", { error: err instanceof Error ? err.message : String(err) });
    }
    const summarized = agents.map((a: any) => ({
      id: String(a?.id ?? ""),
      name: String(a?.name ?? ""),
      role: String(a?.role ?? ""),
      effective_prompt: String(a?.effective_prompt ?? a?.prompt ?? ""),
    })).filter((a) => a.id && a.name);
    if (summarized.length === 0) {
      throw new Error("No agents available to spawn as specialists. Configure agents on the Agents page first.");
    }
    startTeamTask({
      sessionId,
      task,
      agents: summarized,
      claudePath,
      host,
      broadcast: broadcastHostEvent,
    }).catch((err) => {
      log("team", "task failed", { error: err instanceof Error ? err.message : String(err) });
    });
    return { ok: true, accepted: true };
  }

  if (cmd === "team_abort") {
    const sessionId = String(args.sessionId ?? "");
    if (!sessionId) throw new Error("sessionId is required");
    await abortTeamTask(sessionId, broadcastHostEvent);
    return { ok: true };
  }

  if (cmd === "team_status") {
    const sessionId = String(args.sessionId ?? "");
    if (!sessionId) throw new Error("sessionId is required");
    return { active: isTeamRunning(sessionId) };
  }

  if (cmd === "control_panel_toggle") {
    toggleControlPopup();
    return { ok: true };
  }
  if (cmd === "control_panel_open") {
    openControlPopup();
    return { ok: true };
  }
  if (cmd === "control_panel_close") {
    closeControlPopup();
    return { ok: true };
  }
  if (cmd === "control_bubble_toggle") {
    // Toggling the bubble off should also hide the panel — the panel is
    // a popover anchored to the bubble; without the bubble it would be
    // orphaned.
    const wasVisible = isBubbleVisible();
    toggleControlBubble();
    if (wasVisible) closeControlPopup();
    return { ok: true };
  }
  if (cmd === "control_bubble_show") {
    showControlBubble();
    return { ok: true };
  }
  if (cmd === "control_bubble_hide") {
    hideControlBubble();
    closeControlPopup();
    return { ok: true };
  }
  // Manual drag IPCs — replaced `-webkit-app-region: drag` (the OS
  // native drag intercepted clicks in Electron 39+ and the panel toggle
  // stopped firing). Main polls screen.getCursorScreenPoint() at 60Hz
  // between drag_start and drag_end to move the bubble — renderer-side
  // pointermove tracking broke because the bubble window is 56×56 and
  // the cursor escapes it as soon as the user moves faster than the
  // bubble can follow. We accept no coordinates on drag_to because
  // main reads cursor position itself.
  if (cmd === "control_bubble_drag_start") {
    beginBubbleDrag();
    return { ok: true };
  }
  if (cmd === "control_bubble_drag_to") {
    // No-op: kept for API stability (renderer might call it during
    // transitional builds). Main is already polling the cursor.
    return { ok: true };
  }
  if (cmd === "control_bubble_drag_end") {
    endBubbleDrag();
    return { ok: true };
  }
  if (cmd === "control_panel_get_docked") {
    return { docked: isPanelDocked() };
  }
  if (cmd === "control_panel_set_docked") {
    const docked = !!args.docked;
    setPanelDocked(docked);
    return { ok: true, docked };
  }
  if (cmd === "cursor_overlay_get_active") {
    return { active: isCursorOverlayActive() };
  }
  if (cmd === "cursor_overlay_set_active") {
    const next = !!args.active;
    setCursorOverlayActive(next);
    return { ok: true, active: next };
  }
  if (cmd === "cursor_overlay_get_color") {
    return { color: getCursorColor() };
  }
  if (cmd === "cursor_overlay_set_color") {
    const color = typeof args.color === "string" ? args.color : "#9caf9b";
    setCursorColor(color);
    return { ok: true, color };
  }
  if (cmd === "control_close_all") {
    // "Quit Control" — full exit from Computer Control mode. Aborts any
    // in-flight voice loop, closes the panel, hides the bubble, turns off
    // the cursor companion. Doesn't quit AIOS itself; user re-enters via
    // the sidebar Control button.
    await abortVoiceLoop(broadcastHostEvent);
    closeControlPopup();
    hideControlBubble();
    setCursorOverlayActive(false);
    return { ok: true };
  }
  if (cmd === "control_panel_prepare_mic") {
    prepareControlPopupForMic();
    return { ok: true };
  }
  if (cmd === "control_panel_release_mic") {
    releaseControlPopupAfterMic();
    return { ok: true };
  }
  if (cmd === "control_open_settings") {
    // Focus the main AIOS window and route it to the Settings screen so
    // the user can configure Claude / theme / etc.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("shortcut:preferences");
    }
    return { ok: true };
  }

  if (cmd === "install_claude") {
    // Run the official Claude Code standalone installer script. Picks a
    // platform-appropriate one-liner — both install a self-contained binary,
    // no Node / npm prerequisite. Streams stdout/stderr back to the renderer
    // via `aios:host-event` so the onboarding card can show a live log tail.
    //
    // Refs:
    //   Mac/Linux: curl -fsSL https://claude.ai/install.sh | bash
    //   Windows  : irm https://claude.ai/install.ps1 | iex   (PowerShell)
    const { spawn } = require("child_process");
    const isWin = process.platform === "win32";
    const program = isWin ? "powershell.exe" : "bash";
    const args = isWin
      ? [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "irm https://claude.ai/install.ps1 | iex",
        ]
      : ["-c", "curl -fsSL https://claude.ai/install.sh | bash"];

    const emit = (line: string) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("aios:host-event", {
        id: "claude-install",
        event: "claude_install_log",
        data: { line },
      });
    };

    const logs: string[] = [];
    return await new Promise<{ ok: boolean; error?: string; logs: string[] }>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(program, args, { shell: false, windowsHide: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resolve({ ok: false, error: `Could not start ${program}: ${message}`, logs });
        return;
      }
      const pushLine = (chunk: Buffer | string) => {
        const text = String(chunk);
        logs.push(text);
        // Send the chunk as-is — the renderer splits on newlines for display.
        emit(text);
      };
      child.stdout?.on("data", pushLine);
      child.stderr?.on("data", pushLine);
      child.on("error", (err: Error) => {
        resolve({ ok: false, error: err.message, logs });
      });
      child.on("close", (code: number | null) => {
        if (code === 0) {
          resolve({ ok: true, logs });
        } else {
          resolve({
            ok: false,
            error: `Installer exited with code ${code ?? "unknown"}.`,
            logs,
          });
        }
      });
    });
  }

  if (cmd === "open_claude_login_terminal") {
    // Pop a native terminal window running `claude /login` — the explicit
    // login slash command. Goes straight to the OAuth / API-key picker
    // instead of dropping the user into the REPL first. We can't drive the
    // browser flow from a non-TTY subprocess reliably, so we hand off to the
    // OS terminal and rely on the user clicking "I've signed in" once done.
    const { spawn } = require("child_process");
    try {
      if (process.platform === "win32") {
        // `start` is a cmd builtin, not an exe — wrap with cmd /c. /K keeps
        // the new window open after `claude /login` exits so the user can
        // read any post-login output.
        spawn("cmd.exe", ["/c", "start", "", "cmd.exe", "/K", "claude /login"], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        }).unref();
      } else if (process.platform === "darwin") {
        spawn("osascript", [
          "-e",
          'tell application "Terminal" to do script "claude /login"',
          "-e",
          'tell application "Terminal" to activate',
        ], { detached: true, stdio: "ignore" }).unref();
      } else {
        // Linux desktops vary wildly. Try x-terminal-emulator first; if it
        // isn't present, fall back to common terminals.
        const candidates = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
        let opened = false;
        for (const term of candidates) {
          try {
            spawn(term, ["-e", "claude /login"], { detached: true, stdio: "ignore" }).unref();
            opened = true;
            break;
          } catch {
            /* try next */
          }
        }
        if (!opened) {
          return { ok: false, error: "Could not find a terminal emulator to open. Run `claude /login` manually." };
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (cmd === "export_to_pdf") {
    // Render arbitrary markdown (passed by the renderer or by the agent via
    // the [AIOS_EXPORT_PDF: ...] marker pipeline) to a PDF in the workspace's
    // outputs/ folder. Returns the workspace-relative path so the chat
    // attachment chip can deep-link via the existing pendingAttachmentOpen
    // flow in App.tsx.
    const markdown = typeof args.markdown === "string" ? args.markdown : "";
    if (!markdown.trim()) throw new Error("markdown is required.");
    const requestedFilename = typeof args.filename === "string" ? args.filename : "";
    const slug = (requestedFilename || `export-${Date.now()}`)
      .replace(/\.pdf$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `export-${Date.now()}`;
    const filename = `${slug}.pdf`;
    const workspaceRoot = ensureRuntimeWorkspace();
    const outputsDir = path.join(workspaceRoot, "outputs");
    const outputPath = path.join(outputsDir, filename);
    const { renderMarkdownStringToPdf } = await import("./pdf-export");
    await renderMarkdownStringToPdf({
      markdown,
      outputPath,
      title: slug,
      parentWindow: mainWindow,
    });
    return { ok: true, path: `outputs/${filename}`, filename };
  }

  throw new Error(`Unhandled main command: ${cmd}`);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === "media";
  });

  const workspaceRoot = ensureRuntimeWorkspace();
  const starterKitRoot = getSourceStarterKit();
  initLogger(workspaceRoot);

  // Defense in depth — if a prior launch crashed or was force-killed before
  // its before-quit handler could run, an orphan aios-host subprocess may
  // still be holding the SQLite WAL lock. The new launch's host.start would
  // then fail and the user would have to reboot to recover. Kill any
  // orphan now, before spawning our own. Sync spawn so it completes before
  // PythonHost spawns a fresh sidecar.
  try {
    const { spawnSync } = require("node:child_process");
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/IM", "aios-host.exe"], { windowsHide: true, stdio: "ignore" });
    } else {
      // pkill returns non-zero if no match — that's fine, swallow.
      spawnSync("pkill", ["-9", "-f", "aios-host"], { stdio: "ignore" });
    }
  } catch {
    // Never block launch on cleanup.
  }

  host = new PythonHost(workspaceRoot, starterKitRoot);
  host.onEvent((event) => {
    broadcastHostEvent(event);
    // Modifier-only voice shortcut: when the Python sidecar's
    // Mac CGEventTap detects a clean Cmd+Ctrl tap (both held + both
    // released without any other key pressed in between), it
    // broadcasts a `voice_shortcut_triggered` event. We treat this
    // the same as the keyboard-accelerator global shortcut: show
    // bubble, open popup, fire shortcut:voice-toggle to start mic.
    // The Python listener is Mac-only (CGEventTap is macOS API);
    // Windows users still rely on the Ctrl+Alt+V Electron shortcut.
    const evtName = (event as { event?: string } | null)?.event;
    if (evtName === "voice_shortcut_triggered") {
      if (!isBubbleVisible()) showControlBubble();
      openControlPopup();
      sendVoiceToggleWhenReady();
    }
  });
  setCursorOverlayHost(host);

  // Register the Control popup + Control bubble as event subscribers the
  // moment each is created. Both hide instead of destroying on close, but
  // if they do get destroyed (app quit, force-close) we drop them from
  // the set.
  installControlPopupHooks({
    subscribe: (win) => { eventSubscribers.add(win); },
    unsubscribe: (win) => { eventSubscribers.delete(win); },
  });
  installControlBubbleHooks({
    subscribe: (win) => { eventSubscribers.add(win); },
    unsubscribe: (win) => { eventSubscribers.delete(win); },
  });
  let hostStarted = false;
  try {
    host.start();
    hostStarted = true;
  } catch (error) {
    log("python", "host failed to start", { error: error instanceof Error ? error.message : String(error) });
  }
  scheduler = new AutoTaskScheduler(host);
  if (hostStarted) scheduler.start();

  ipcMain.handle("aios:invoke", async (_event, cmd: AiosCommand, args: Record<string, unknown> = {}) => {
    try {
      if (mainHandledCommands.has(cmd)) {
        return { ok: true, data: await handleMainCommand(cmd, args) };
      }

      // Dynamic workflows spawn many agents and run for many minutes with NO
      // intermediate stream output, so the default 700s host-IPC ceiling would
      // kill a perfectly healthy run ("Python host timed out for run_task").
      // Give workflow runs a 50-minute ceiling — just above host.py's own
      // workflow timeout, so the host's clean timeout wins if it ever trips.
      const isWorkflowRun = cmd === "run_task" && (args as { effort?: string })?.effort === "ultracode";
      const response = await host?.invoke(cmd, args, isWorkflowRun ? 3_000_000 : undefined);
      if (!response) return { ok: false, error: { code: "HOST_MISSING", message: "Python host is not running." } };
      return response.ok ? { ok: true, data: response.data } : { ok: false, error: response.error };
    } catch (error) {
      log("main.ipc", "command failed", { cmd, error: error instanceof Error ? error.message : String(error) });
      return {
        ok: false,
        error: {
          code: "MAIN_ERROR",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  });

  registerIpcHandlers();

  // Mac-only: Squirrel.Mac auto-update requires the .app to live in
  // /Applications. If the user is running from /Volumes/<dmg>/ (DMG-mounted)
  // or ~/Downloads/, autoUpdater.quitAndInstall() silently fails. Surface a
  // one-time dialog asking them to move it. Honors a dismissal flag so we
  // don't nag every launch. Windows-side: app.isInApplicationsFolder always
  // returns true (non-Mac no-op), so the guard short-circuits cleanly.
  if (process.platform === "darwin" && app.isPackaged && typeof app.isInApplicationsFolder === "function" && !app.isInApplicationsFolder()) {
    const skipFlagPath = path.join(app.getPath("userData"), ".skip-applications-folder-prompt");
    let dismissed = false;
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      dismissed = fs.existsSync(skipFlagPath);
    } catch { /* ignore */ }
    if (!dismissed) {
      const result = dialog.showMessageBoxSync({
        type: "question",
        title: "Move AIOS Desktop to Applications?",
        message: "AIOS works best when it lives in /Applications.",
        detail: "Auto-update needs the app in /Applications to install new versions cleanly. Move it there now and AIOS will relaunch from the new location.",
        buttons: ["Move to Applications", "Not now"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result === 0) {
        try {
          app.moveToApplicationsFolder();
          // moveToApplicationsFolder quits + relaunches; nothing more to do.
          return;
        } catch (err) {
          log("main", "moveToApplicationsFolder failed", { error: err instanceof Error ? err.message : String(err) });
        }
      } else {
        try {
          const fs = require("node:fs") as typeof import("node:fs");
          fs.writeFileSync(skipFlagPath, new Date().toISOString());
        } catch { /* best-effort; if we can't write, we'll just ask again next launch */ }
      }
    }
  }

  createWindow();

  // Run the deferred infra resync AFTER the window is on screen. The fresh-
  // install copy already happened inline in ensureRuntimeWorkspace() above;
  // this path exists to self-heal v0.2.19 users whose first-launch copy
  // aborted mid-flight (partial or missing module-installs/). When anything
  // is actually copied, broadcast a workspace_backfilled event so the
  // renderer refreshes immediately rather than waiting for the 60s polling
  // tick to surface the now-present modules.
  const runBackfill = () => {
    const { copied } = backfillStarterKit();
    if (copied.length > 0) {
      broadcastHostEvent({
        id: `backfill-${Date.now()}`,
        event: "workspace_backfilled",
        data: { copied },
      });
    }
  };
  if (mainWindow) {
    mainWindow.once("ready-to-show", () => setImmediate(runBackfill));
    setTimeout(runBackfill, 2000);
  } else {
    runBackfill();
  }

  if (host && mainWindow) {
    autoStartWhatsApp(host, mainWindow);
  }

  const broadcast = (state: string, payload?: Record<string, unknown>) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("aios:update-state", { state, ...payload });
    }
  };

  // electron-updater's in-place auto-update works on both Windows and macOS
  // now that we ship Apple Developer ID-signed + notarized .app bundles
  // (since v0.2.7). Squirrel.Mac validates the new bundle's signature
  // against the running app's signature before swapping — both are signed
  // with the same SAPHAARE LABS Developer ID, so the swap succeeds.
  //
  // Previously this block was gated to `!isMac` because earlier Mac builds
  // were unsigned and ShipIt threw "code failed to satisfy specified code
  // requirement(s)". Removing that gate lets Mac users get the same
  // background-download + restart-to-install flow Windows users already had.
  const isMac = process.platform === "darwin";

  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => broadcast("checking"));
    autoUpdater.on("update-available", (info) => {
      log("updater", "update-available", { version: info.version });
      broadcast("available", { version: info.version });
    });
    autoUpdater.on("update-not-available", (info) => broadcast("up-to-date", { version: info.version }));
    autoUpdater.on("download-progress", (p) => broadcast("downloading", { percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => {
      log("updater", "update-downloaded", { version: info.version });
      broadcast("ready", { version: info.version });
    });
    autoUpdater.on("error", (err) => {
      log("updater", "error", { error: err.message });
      broadcast("error", { message: err.message });
    });

    autoUpdater.checkForUpdatesAndNotify().catch((err) => log("updater", "check-failed", { error: err?.message }));
  }

  // Compare semver-like versions: returns true if `latest` is strictly newer
  // than `current`. Stripping a leading "v" lets us compare GH tag names
  // ("v0.1.9") against package.json versions ("0.1.9") interchangeably.
  function isNewerVersion(latest: string, current: string): boolean {
    const parse = (v: string) => v.replace(/^v/i, "").split(/[.-]/).map((n) => Number(n) || 0);
    const lp = parse(latest);
    const cp = parse(current);
    for (let i = 0; i < Math.max(lp.length, cp.length); i++) {
      const l = lp[i] ?? 0;
      const c = cp[i] ?? 0;
      if (l > c) return true;
      if (l < c) return false;
    }
    return false;
  }

  // Mac-only manual update check: query GitHub's releases/latest endpoint
  // (no auth required for public repos), compare versions, broadcast a
  // "manual-available" state with the release URL when newer.
  async function checkForUpdatesManual(): Promise<{
    ok: boolean;
    currentVersion: string;
    latestVersion?: string;
    hasUpdate?: boolean;
    manualDownloadUrl?: string;
    reason?: string;
    error?: string;
  }> {
    const currentVersion = app.getVersion();
    try {
      broadcast("checking");
      // Source of truth for the publish target is package.json `build.publish`
      // ("everyai-com/AIOS_Desktop" since v0.2.71 — was AIOS_Desktop-releases
       // before the pipeline consolidation). Hardcoded here for simplicity;
      // if you ever change the publish target, update this URL too.
      const res = await fetch(
        "https://api.github.com/repos/everyai-com/AIOS_Desktop/releases/latest",
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "AIOS-Desktop" } }
      );
      if (!res.ok) {
        broadcast("error", { message: `GitHub API ${res.status}` });
        return { ok: false, currentVersion, reason: "check-failed", error: `GitHub API ${res.status}` };
      }
      const data = (await res.json()) as { tag_name?: string; html_url?: string };
      const tag = data.tag_name ?? "";
      const latestVersion = tag.replace(/^v/i, "");
      const url = data.html_url ?? `https://github.com/everyai-com/AIOS_Desktop/releases/latest`;
      if (isNewerVersion(latestVersion, currentVersion)) {
        broadcast("manual-available", { version: latestVersion, manualDownloadUrl: url });
        return { ok: true, currentVersion, latestVersion, hasUpdate: true, manualDownloadUrl: url };
      }
      broadcast("up-to-date", { version: currentVersion });
      return { ok: true, currentVersion, latestVersion, hasUpdate: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast("error", { message });
      return { ok: false, currentVersion, reason: "check-failed", error: message };
    }
  }

  // IPC: returns the currently-running app's version (from package.json).
  ipcMain.handle("aios:get-version", () => app.getVersion());

  // IPC: manual "Check for updates" trigger from Settings.
  // Both Mac and Windows go through electron-updater now that Mac builds
  // are signed + notarized. The `checkForUpdatesManual` GitHub-API fallback
  // is kept as the error path: if electron-updater fails for any reason
  // (unsigned dev build, latest-mac.yml missing on a release, etc.) we
  // gracefully degrade to the "open release page in browser" UX rather
  // than leaving the user stranded.
  ipcMain.handle("aios:check-for-updates", async () => {
    if (!app.isPackaged) {
      return { ok: false, reason: "not-packaged", currentVersion: app.getVersion() };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return {
        ok: true,
        currentVersion: app.getVersion(),
        latestVersion: result?.updateInfo?.version ?? app.getVersion(),
        hasUpdate: !!result?.updateInfo && result.updateInfo.version !== app.getVersion()
      };
    } catch (err) {
      // Fall back to the manual-download path on the off-chance
      // electron-updater fails. Better than a hard error.
      if (isMac) return await checkForUpdatesManual();
      return { ok: false, reason: "check-failed", error: err instanceof Error ? err.message : String(err) };
    }
  });

  // IPC: install the downloaded update + restart.
  //
  // Mac safety net (v0.2.75+): Squirrel.Mac's `quitAndInstall` quits the
  // app and swaps the .app binary at its current location on disk. If the
  // app is anywhere outside /Applications (DMG mount point, ~/Downloads,
  // a Gatekeeper-translocated path), the swap silently fails — the user
  // sees the app close and… nothing. No error, no new version.
  //
  // Previously we relied on a first-launch "Move to Applications?" prompt
  // that could be dismissed with "Not now", leaving the user one Install
  // click away from the silent-fail state. Now we intercept HERE: detect
  // not-in-/Applications, auto-move (moveToApplicationsFolder restarts the
  // app from the new location), and let the updater re-detect the pending
  // download on relaunch so the user can click Install again — this time
  // the swap completes. If the move itself fails, surface a clear error.
  ipcMain.handle("aios:install-update", async () => {
    if (!app.isPackaged) return { ok: false, reason: "not-packaged" };

    if (
      process.platform === "darwin" &&
      typeof app.isInApplicationsFolder === "function" &&
      !app.isInApplicationsFolder()
    ) {
      try {
        app.moveToApplicationsFolder({
          conflictHandler: (conflict) => {
            // Older AIOS Desktop already exists in /Applications — replace it.
            // The most common cause: user downloaded a fresh DMG to test and
            // ran THIS copy, while their old install still lives in
            // /Applications. Replacing is exactly what they want.
            return conflict === "exists";
          },
        });
        // moveToApplicationsFolder() is blocking on success — it quits +
        // relaunches. If we reach this line the move was rejected (user
        // declined the move dialog, or Finder rejected the swap).
        return { ok: false, reason: "move-to-applications-declined" };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        dialog.showMessageBoxSync({
          type: "error",
          title: "Update couldn't install",
          message: "AIOS Desktop needs to be in /Applications to install updates.",
          detail:
            `macOS requires apps to live in /Applications for auto-update to write the new version. Please:\n\n` +
            `  1. Quit AIOS Desktop\n` +
            `  2. Drag AIOS Desktop.app from its current location into /Applications\n` +
            `  3. Launch AIOS Desktop from /Applications\n` +
            `  4. Try the update again — it will install cleanly\n\n` +
            `Technical: ${detail}`,
          buttons: ["OK"],
        });
        return { ok: false, error: detail };
      }
    }

    try {
      // isSilent: pass /S to NSIS to suppress the installer UI on update
      // installs (only honored when the installed shell supports it; with
      // assistedInstaller / oneClick:false the wizard may briefly flash, but
      // the flag is the strongest signal we can pass).
      // isForceRunAfter: relaunch the app automatically once install finishes
      // so the user lands back in AIOS without having to double-click again.
      autoUpdater.quitAndInstall(true, true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.on("activate", () => {
    // Mac dock-icon click handler.
    //
    // The default Electron pattern is `if (getAllWindows().length === 0)
    // createWindow()`, but we always have at least the bubble + cursor
    // overlay alive, so the count is never zero — clicking the dock icon
    // did nothing. Users on Mac expect dock click to restore the main
    // window if it was minimized or hidden.
    //
    // We deliberately don't focus the bubble/popup/overlay here: those
    // are always-on-top peripheral windows that should follow the main
    // window's app lifecycle, not become focus targets themselves.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let isCleaningUp = false;
app.on("before-quit", (event) => {
  if (isCleaningUp) return;
  isCleaningUp = true;
  event.preventDefault();
  scheduler?.stop();
  globalShortcut.unregisterAll();
  destroyControlBubble();
  destroyControlPopup();
  destroyCursorOverlay();
  // host.stop() is async (SIGTERM → wait → SIGKILL → wait for exit). Give
  // it a 2.5s ceiling — enough for the new aggressive teardown to actually
  // wait for the subprocess to exit before we hard-exit the app. Otherwise
  // the next launch hits a stale aios-host still holding the SQLite WAL
  // lock and fails until the user reboots.
  const stopHost = Promise.resolve(host?.stop()).catch(() => undefined);
  const watchdog = new Promise<void>((resolve) => setTimeout(resolve, 2500));
  Promise.race([stopHost, watchdog]).finally(() => app.exit(0));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
