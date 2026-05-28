import { initSentryRenderer } from "./sentry";
// Init Sentry before any other renderer code — wraps subsequent imports' errors.
initSentryRenderer();

import React, { startTransition, useEffect, useMemo, useState } from "react";
import { initAnalytics, track } from "./lib/analytics";
import { invoke as apiInvoke } from "./lib/api";
import { createRoot } from "react-dom/client";
import {
  Boxes,
  ClipboardList,
  Clock,
  FileText,
  FolderOpen,
  Inbox,
  MessageSquare,
  Minus,
  Plug,
  MoreHorizontal,
  Plus,
  Settings,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Users,
  Mic,
  Bot,
  X,
  PanelLeft,
  LayoutGrid
} from "lucide-react";
import { invoke } from "./lib/api";
import { buildConnections, buildContextSections } from "./lib/workspace-view";
import { NavItem, StatusBadge, ConfirmModal } from "./components/ui";
import { BrandMark } from "./components/BrandMark";
import { AutoUpdateBanner } from "./components/AutoUpdateBanner";
import { WhatsNewBanner } from "./components/WhatsNewBanner";
import { CommandScreen } from "./screens/CommandScreen";
import { AutoTasksScreen } from "./screens/AutoTasksScreen";
import { ContextScreen } from "./screens/ContextScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { ImportsScreen } from "./screens/ImportsScreen";
import { ModulesScreen } from "./screens/ModulesScreen";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { OutputsScreen } from "./screens/OutputsScreen";
import { PlansScreen } from "./screens/PlansScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { BriefsScreen } from "./screens/BriefsScreen";
import { ConnectorsScreen } from "./screens/ConnectorsScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { AgentsScreen } from "./screens/AgentsScreen";
import { VoiceControlPanel } from "./screens/VoiceControlPanel";
import { ControlApp } from "./screens/ControlApp";
import { BubbleApp } from "./screens/BubbleApp";
import { CursorOverlayApp } from "./screens/CursorOverlayApp";
import { DailyBriefModal } from "./screens/DailyBriefModal";
import { MacPermissionsModal } from "./components/MacPermissionsModal";
import type {
  ChatSession,
  ClaudeStatus,
  ConnectionStatus,
  ContextSummary,
  DailyBriefStatus,
  ModuleInfo,
  RecentActivityEntry,
  WorkspaceEntry,
  WorkspaceInfo
} from "./types";
import type { OnboardingState, Screen } from "./ui";
import { relay, RELAY_AVAILABLE } from "./lib/aios-relay";
import "./styles.css";

// Reconcile a freshly-fetched session list (from SQLite) with what's already
// in memory. Critical race condition we're solving:
//
//   1. User sends a chat message → CommandScreen optimistically appends a
//      user-message + empty assistant placeholder to the in-memory session.
//   2. Claude streams its reply over ~10-25s. During this window, in-memory
//      state grows (deltas accumulate on the placeholder).
//   3. The 60-second `refreshWorkspace` polling timer fires.
//   4. It calls `get_sessions` from SQLite — which doesn't have the in-flight
//      messages yet (they get saved only on Claude completion).
//   5. Without a merge, `setSessions(freshFromDb)` overwrites the in-memory
//      session and BOTH the user's message and Claude's streaming response
//      disappear. Subsequent stream deltas reference an `assistantId` that
//      no longer exists in state → silently dropped.
//
// The fix: for each session present in BOTH lists, keep whichever has MORE
// messages. In-memory > DB means a chat is in-flight; preserve it.
// In-memory == DB or in-memory < DB means DB is the source of truth; use it.
// Strip runtime-only fields from messages loaded from SQLite. `streamId`
// correlates an in-memory assistant bubble to a live Python subprocess; if
// it leaks onto disk (older bug — fixed by stripping before save_session)
// and gets re-hydrated, the App-level stream listener can never match it
// because the original subprocess is dead, so the typing indicator hangs
// forever. Cleaning on read is belt-and-suspenders self-heal for any rows
// that were written with streamId before the fix landed.
function sanitizeSessionFromDisk(session: ChatSession): ChatSession {
  if (!session.messages.some((m) => m.streamId)) return session;
  return {
    ...session,
    messages: session.messages.map((m) => (m.streamId ? { ...m, streamId: null } : m)),
  };
}

function mergeSessions(current: ChatSession[], fresh: ChatSession[]): ChatSession[] {
  const cleanFresh = fresh.map(sanitizeSessionFromDisk);
  const freshById = new Map(cleanFresh.map((s) => [s.id, s]));
  const merged = current.map((c) => {
    const f = freshById.get(c.id);
    if (!f) return c;
    // Streaming guard: if ANY message in memory still has an active streamId,
    // a chat turn is in flight (optimistic user message + empty assistant
    // bubble waiting for chunks). The DB snapshot can't possibly contain
    // those rows yet — save_session only fires on stream completion. Prefer
    // in-memory unconditionally to protect the in-flight turn from getting
    // clobbered by a same-count merge.
    const inFlight = c.messages.some((m) => m.streamId);
    const picked = inFlight || c.messages.length > f.messages.length ? c : f;
    // Goal state: prefer the LIVE in-memory activeGoal when it's "active"
    // (the orchestrator is feeding goal_progress events; the DB row is at
    // most one turn stale). Without this, a periodic get_sessions refresh
    // would briefly clobber the live goal state with a "aborted" coerced
    // by python/workspace.py:_decode_goal_state.
    const liveGoal = c.activeGoal;
    if (liveGoal && liveGoal.status === "active") {
      return { ...picked, activeGoal: liveGoal };
    }
    return picked;
  });
  // Add any sessions that exist in DB but not in memory yet (e.g. auto-task
  // created one in the background). Use cleanFresh so any DB-resurrected
  // streamId on a session we haven't seen before is also stripped.
  for (const f of cleanFresh) {
    if (!merged.some((s) => s.id === f.id)) merged.push(f);
  }
  return merged;
}

// Per-service identify prompts used by the App-level background connector
// identifier. Kept at module scope so the effect can call it without
// re-creating the map every render.
//
// SPEED OPTIMIZATION (v0.1.8): each prompt pre-specifies the exact Composio
// tool slug so Claude skips the COMPOSIO_SEARCH_TOOLS roundtrip. Combined
// with the `model: "haiku"` override in the run_task call, identify drops
// from ~10s to ~3-4s per service.
function identifyPromptFor(service: string): string | null {
  switch (service) {
    case "gmail":
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "GMAIL_FETCH_EMAILS" and arguments {"query": "in:sent", "max_results": 1}. Read the "From" header of the returned message — that address is the account owner. Reply with ONLY the bare email, nothing else. If the result has no messages, reply: UNKNOWN.`;
    case "google-calendar":
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "GOOGLECALENDAR_LIST_CALENDARS" and arguments {}. Find the calendar where "primary" is true — its "id" is the user's email. Reply with ONLY the bare email, nothing else. If no primary calendar, reply: UNKNOWN.`;
    case "slack":
      // No SLACK_AUTH_TEST in Composio's catalog. Use the user-info-by-id flow
      // indirectly: fetch a sent message and look at its 'user' field. Less
      // direct but reliable.
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "SLACK_LIST_ALL_SLACK_TEAM_CHANNELS_WITH_VARIOUS_FILTERS" and arguments {"types": "public_channel", "limit": 1}. From the response, read team_id. Then call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL with tool_slug "SLACK_RETRIEVE_TEAM_PROFILE_DETAILS" and arguments {"team": team_id_from_step_1}. Reply with the team's "name" field — that's the workspace name. ONLY the workspace name, nothing else. If unsure, reply: UNKNOWN.`;
    case "clickup":
      // ClickUp toolkit has 0 tools in Composio's catalog. Identify isn't
      // possible — just confirm the connection works by listing-ish nothing.
      // Returning UNKNOWN means the card shows "Connected" without a label.
      return `Reply with the single word: UNKNOWN`;
    case "notion":
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "NOTION_GET_ABOUT_ME" and arguments {}. Find the user's email (often at bot.owner.user.person.email) or workspace name. Reply with ONLY the bare email or workspace name, nothing else. If unsure, reply: UNKNOWN.`;
    case "github":
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "GITHUB_GET_THE_AUTHENTICATED_USER" and arguments {}. Read the "email" field. If null, use "@" + the "login" field. Reply with ONLY the bare email or @login, nothing else. If unsure, reply: UNKNOWN.`;
    case "stripe":
      // No STRIPE_GET_ACCOUNT in Composio's catalog. Best we can do is grab
      // the account currency from the balance and use that as the label.
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "STRIPE_RETRIEVE_BALANCE" and arguments {}. Read available[0].currency (uppercased). Reply with "Stripe (CURRENCY)" — e.g. "Stripe (USD)". ONLY that, nothing else. If unsure, reply: UNKNOWN.`;
    case "youtube":
      // No LIST_MY_CHANNELS in Composio's catalog. Can't auto-discover —
      // reply UNKNOWN so the card shows "Connected" without a label.
      return `Reply with the single word: UNKNOWN`;
    case "google-analytics":
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "GOOGLE_ANALYTICS_LIST_ACCOUNTS" and arguments {}. Find the first account's "displayName". Reply with ONLY that name, nothing else. If no accounts, reply: UNKNOWN.`;
    case "google-sheets":
      // No GOOGLE_SHEETS_GET_USER_INFO in Composio's catalog. List user's
      // sheets and use the first sheet's owner email as the label.
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "GOOGLESHEETS_SEARCH_SPREADSHEETS" and arguments {"query": "", "page_size": 1}. Find the owner's emailAddress in the first result's "owners[0].emailAddress" field. Reply with ONLY that bare email, nothing else. If unsure, reply: UNKNOWN.`;
    case "outlook":
      // Composio's Outlook catalog has 301 tools but no public docs list a
      // single "get me" slug. Safe default — connection still works, just no
      // auto-label on the card.
      return `Reply with the single word: UNKNOWN`;
    case "linkedin":
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "LINKEDIN_GET_MY_INFO" and arguments {}. Read the profile's name. Reply with ONLY the name, nothing else. If unsure, reply: UNKNOWN.`;
    case "whatsapp":
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "WHATSAPP_GET_PHONE_NUMBERS" and arguments {}. From the first phone number in the response, read its "verified_name" field (the WhatsApp Business display name). Reply with ONLY that name, nothing else. If unsure, reply: UNKNOWN.`;
    case "twitter":
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "TWITTER_USER_LOOKUP_ME" and arguments {}. Read the "username" field. If present, reply with "@" + username, nothing else. If unsure, reply: UNKNOWN.`;
    case "telegram":
      return `Call mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL once with tool_slug "TELEGRAM_GET_ME" and arguments {}. Read the bot's "username" field. If present, reply with "@" + username, nothing else. If unsure, reply: UNKNOWN.`;
    default:
      return null;
  }
}

function App() {
  const [screen, setScreen] = useState<Screen>("command");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [context, setContext] = useState<ContextSummary>({ files: [], imports: [] });
  const [recent, setRecent] = useState<RecentActivityEntry[]>([]);
  const [outputs, setOutputs] = useState<WorkspaceEntry[]>([]);
  const [plans, setPlans] = useState<WorkspaceEntry[]>([]);
  const [shares, setShares] = useState<WorkspaceEntry[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  // When the user clicks an attachment chip in the chat (e.g. a plan PDF
  // delivered through WhatsApp Remote), we route to the matching screen and
  // pass this path down so the screen pre-opens the file. Cleared once the
  // destination screen has consumed it.
  const [pendingAttachmentOpen, setPendingAttachmentOpen] = useState<{
    kind: "plan" | "output";
    path: string;
  } | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Staged thread id for the chat-delete ConfirmModal. Set by the sidebar
  // trash icon; cleared on Cancel/Confirm.
  const [confirmDeleteThreadId, setConfirmDeleteThreadId] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingSlow, setLoadingSlow] = useState(false);
  // splashStage advances as time passes so the React splash subtitle rotates
  // through "what we're doing now" messages — mirrors the staged copy in
  // the inline boot splash so the user feels continuous progress across the
  // handoff between the two splashes.
  const [splashStage, setSplashStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [briefStatus, setBriefStatus] = useState<DailyBriefStatus | null>(null);
  const [briefDismissed, setBriefDismissed] = useState(false);
  const [showMacPermissions, setShowMacPermissions] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // Default to "light" on first launch — the inline boot splash in index.html
  // paints the paper background unconditionally, so any other default would
  // cause a flash when React mounts. Subsequent launches read the value from
  // localStorage first (synchronously, before SQLite) so the data-theme
  // attribute is correct from the very first React render.
  const [theme, setTheme] = useState<string>(() => {
    try {
      const cached = localStorage.getItem("aios-theme");
      return cached || "light";
    } catch {
      return "light";
    }
  });

  // Fast cold-start path. Loads only the 3 IPC calls needed for first paint:
  // workspace info (paths, deviceUserId, cached claude path), onboarding state
  // (which screen to show), and the session list (sidebar). Everything else is
  // deferred to refreshWorkspaceBackground after splash dismisses.
  async function refreshWorkspaceCritical(): Promise<{ workspace: WorkspaceInfo; sessions: ChatSession[] }> {
    // The Python sidecar can take 2–5 s on a warm install, but a fresh
    // Windows install often takes 15–30 s on the first cold launch — the
    // PyInstaller-bundled binary is extracted and scanned by Defender on
    // first run. Without a generous retry window the splash would flip to
    // the error state during a totally normal first-launch warmup. Retry
    // quietly for 30 s; the existing 10 s "slow loading" hook surfaces a
    // Retry button as a separate safety net for genuinely-stuck cases.
    const deadline = Date.now() + 30000;
    async function withWarmupRetry<T>(call: () => Promise<T>): Promise<T> {
      let lastErr: unknown;
      while (Date.now() < deadline) {
        try { return await call(); }
        catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }

    const [workspaceInfo, onboardingState, sessionList, themeSetting] = await Promise.all([
      withWarmupRetry(() => invoke<WorkspaceInfo>("get_workspace_info")),
      withWarmupRetry(() => invoke<OnboardingState>("get_onboarding_state")),
      withWarmupRetry(() => invoke<ChatSession[]>("get_sessions")),
      withWarmupRetry(() => invoke<{ value: string | null }>("get_setting", { key: "theme" })).catch(() => ({ value: "light" }))
    ]);

    let nextSessions = sessionList;
    if (!nextSessions.length) {
      const mainThread = await invoke<ChatSession>("create_thread", { title: "Main" });
      nextSessions = [mainThread];
    }

    startTransition(() => {
      setWorkspace(workspaceInfo);
      setOnboarding(onboardingState);
      setTheme(themeSetting?.value || "light");
      // Merge — preserves any in-flight chat (see mergeSessions doc above).
      setSessions((current) => mergeSessions(current, nextSessions));
      setActiveSessionId((current) => current ?? nextSessions[0]?.id ?? null);
    });
    return { workspace: workspaceInfo, sessions: nextSessions };
  }

  // Full workspace refresh — used by the 60s polling AND in the background
  // after cold start. Re-fetches every screen's data; safe to call repeatedly.
  async function refreshWorkspace() {
    const [
      workspaceInfo,
      onboardingState,
      moduleList,
      contextSummary,
      recentActivity,
      outputSummary,
      planSummary,
      shareSummary,
      sessionList
    ] = await Promise.all([
      invoke<WorkspaceInfo>("get_workspace_info"),
      invoke<OnboardingState>("get_onboarding_state"),
      invoke<ModuleInfo[]>("list_modules"),
      invoke<ContextSummary>("get_context_summary"),
      invoke<{ entries: RecentActivityEntry[] }>("get_recent_workspace_activity", { limit: 12 }),
      invoke<{ entries: WorkspaceEntry[] }>("list_outputs"),
      invoke<{ entries: WorkspaceEntry[] }>("list_plans"),
      invoke<{ entries: WorkspaceEntry[] }>("list_shares"),
      invoke<ChatSession[]>("get_sessions")
    ]);

    let nextSessions = sessionList;
    if (!nextSessions.length) {
      const mainThread = await invoke<ChatSession>("create_thread", { title: "Main" });
      nextSessions = [mainThread];
    }

    startTransition(() => {
      setWorkspace(workspaceInfo);
      setOnboarding(onboardingState);
      setModules(moduleList);
      setContext(contextSummary);
      setRecent(recentActivity.entries);
      setOutputs(outputSummary.entries);
      setPlans(planSummary.entries);
      setShares(shareSummary.entries);
      // Merge — preserves any in-flight chat (see mergeSessions doc above).
      // Without this, the 60s polling overwrites the user's just-sent message
      // and Claude's mid-stream response with a stale snapshot from SQLite.
      setSessions((current) => mergeSessions(current, nextSessions));
      setActiveSessionId((current) => current ?? nextSessions[0]?.id ?? null);
    });
  }

  async function openInNewChat(prompt: string) {
    try {
      const created = await invoke<ChatSession>("create_thread", { title: "New chat" });
      setSessions((current) => [created, ...current]);
      setActiveSessionId(created.id);
      setScreen("command");
      window.setTimeout(() => {
        document.dispatchEvent(new CustomEvent("aios:set-prompt", { detail: prompt }));
      }, 60);
    } catch (err) {
      console.error("Failed to create thread:", err);
    }
  }

  // Two-step delete: clicking the trash icon stages the thread id; the actual
  // delete runs when the ConfirmModal "Delete" is clicked. Native confirm()
  // is gone — the in-app modal is themed and works inside other modals via
  // its higher z-index.
  function deleteThread(id: string) {
    setConfirmDeleteThreadId(id);
  }

  async function handleConfirmDeleteThread() {
    const id = confirmDeleteThreadId;
    if (!id) return;
    setConfirmDeleteThreadId(null);
    try {
      await invoke("delete_thread", { id });
      setSessions((current) => {
        const next = current.filter((s) => s.id !== id);
        if (activeSessionId === id) {
          if (next.length > 0) {
            setActiveSessionId(next[0].id);
          } else {
            setActiveSessionId(null);
          }
        }
        return next;
      });
    } catch (err) {
      console.error("Failed to delete thread:", err);
    }
  }

  // Run a fresh Claude detection. Used by:
  //   - The "Auto-detect" button in Settings/Onboarding (full re-validation)
  //   - The cold-start background pass (verifies the cached path still works)
  //
  // find_claude already runs `claude --version` to validate during detection,
  // so we don't need a separate test_claude_connection call — that was pure
  // duplication on the old cold-start path and easily cost 1-3s on Windows.
  async function detectClaude() {
    const detected = await invoke<ClaudeStatus>("find_claude");
    const next: ClaudeStatus = {
      ...detected,
      runtimeOk: detected.found && !!detected.path,
      runtimeError: detected.found ? undefined : detected.error ?? "Claude executable was not found."
    };
    setClaude(next);
    return next;
  }

  useEffect(() => {
    // Cold-start happens in two phases for a fast splash dismissal:
    //
    //  Phase 1 (CRITICAL — blocks the splash):
    //    3 IPC calls in parallel: get_workspace_info, get_onboarding_state,
    //    get_sessions. workspace_info now also returns the cached claude_path
    //    + claude_version so we can render an OPTIMISTIC ClaudeStatus right
    //    away — no subprocess spawn on the critical path. Splash dismisses
    //    as soon as this resolves (target: <1s on Mac, <2s on Win).
    //
    //  Phase 2 (BACKGROUND — fires after splash dismissed):
    //    Runs detectClaude (verifies the cached path still works), the rest
    //    of the workspace data (modules, context, outputs, plans, shares,
    //    recent activity), and the daily-brief status check. None of this
    //    blocks first paint — the chat screen renders immediately with
    //    optimistic Claude state and gets corrected if verification fails.
    const slowTimer = window.setTimeout(() => setLoadingSlow(true), 10000);
    refreshWorkspaceCritical()
      .then(({ workspace }) => {
        // Optimistic Claude status from cached settings — assume the path
        // saved in the prior session still works. detectClaude in phase 2
        // will swap this out if validation now fails.
        if (workspace.claudePath) {
          setClaude({
            found: true,
            path: workspace.claudePath,
            version: workspace.claudeVersion ?? null,
            checked: [],
            runtimeOk: true
          });
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        window.clearTimeout(slowTimer);
        setLoading(false);
      });
  }, []);

  // Analytics — deferred 800ms past mount so the SDK fetch + init never
  // sits on the critical path. The chat is interactive long before this
  // fires. No-op when the posthog key is intentionally disabled.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      (async () => {
        try {
          const [keyRes, version] = await Promise.all([
            apiInvoke<{ key: string; value: string | null }>("get_setting", { key: "posthog_api_key" }),
            window.aios.getVersion?.().catch(() => "unknown") ?? Promise.resolve("unknown"),
          ]);
          if (cancelled) return;
          const key = keyRes?.value || "";
          await initAnalytics(key);
          track("app_launched", { version, platform: navigator.platform });
        } catch {
          // Analytics is never load-bearing.
        }
      })();
    }, 800);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  // Rotate the React splash subtitle through the same staged messages the
  // inline boot splash uses, so the user feels continuous progress across
  // the handoff. Timers tick from the moment React mounts (which is also
  // when the inline splash gets torn down), so the React-side stages run
  // SHORTER than the inline-splash stages by the time-to-mount delta.
  useEffect(() => {
    if (!loading) return;
    const timers = [
      window.setTimeout(() => setSplashStage(1), 3500),
      window.setTimeout(() => setSplashStage(2), 8000),
      window.setTimeout(() => setSplashStage(3), 14000),
      window.setTimeout(() => setSplashStage(4), 22000),
    ];
    return () => { timers.forEach(window.clearTimeout); };
  }, [loading]);

  // Tear down the index.html boot splash as soon as React's tree is on
  // screen. The in-React splash (rendered when `loading` is true) takes over
  // visually, so the transition is seamless. Without this, the inline splash
  // would stay forever on top of the app once it had served its purpose.
  useEffect(() => {
    const boot = document.getElementById("aios-boot-splash");
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
  }, []);

  // Apply theme to document and mirror to localStorage so the inline script in
  // index.html can pick it up on the next cold start (before React mounts) —
  // that's what kills the dark/light flash between the boot splash and the
  // first React render.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("aios-theme", theme); } catch { /* ignore */ }
    // Persist to disk so the next cold start's Electron BrowserWindow can
    // pick the right backgroundColor BEFORE the renderer (and its
    // localStorage) is loaded — kills the ~100ms light flash for dark users.
    try { window.aios?.cacheTheme?.(theme); } catch { /* ignore */ }
  }, [theme]);

  // Sync theme changes across renderer instances. Visibility-gated and slow
  // because theme is rarely touched at runtime — the prior 2s ungated cadence
  // was pure IPC churn (Python sidecar round-trip + setState) even with the
  // window minimized.
  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await invoke<{ value: string | null }>("get_setting", { key: "theme" });
        if (res?.value && res.value !== theme) {
          setTheme(res.value);
        }
      } catch { /* ignore */ }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [theme]);

  // Phase 2: background work that fires once the splash has dismissed.
  // Verifies Claude in the background, fetches the rest of the workspace
  // data, and checks today's daily brief. None of this blocks first paint.
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    (async () => {
      try {
        // Background Claude verification — corrects the optimistic state if
        // the cached path no longer works (Claude uninstalled, PATH changed).
        await detectClaude().catch(() => undefined);
        if (cancelled) return;
        // Fill in the non-critical workspace data (modules, context, outputs,
        // plans, shares, recent activity). These were skipped on the critical
        // path because no screen needs them for first paint.
        await refreshWorkspace().catch(() => undefined);
        if (cancelled) return;
        // Daily brief status — best-effort, swallows errors.
        try {
          const todayDate = new Date().toISOString().slice(0, 10);
          const status = await invoke<DailyBriefStatus>("get_today_brief_status", { localDate: todayDate });
          if (!cancelled && status?.shouldShow) setBriefStatus(status);
        } catch { /* swallow */ }
      } catch { /* non-fatal — background work */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => {
    window.aios
      ?.getVersion?.()
      .then((version) => setAppVersion(version))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!loading && onboarding && !onboarding.completedAt) {
      setScreen("onboarding");
    } else if (!loading && onboarding?.completedAt && screen === "onboarding") {
      setScreen("command");
    }
  }, [loading, onboarding?.completedAt, screen]);

  // Once we have a deviceUserId AND the real app version, register with the
  // connectors relay (idempotent). Gating on appVersion avoids an extra
  // register call with a stale placeholder before getVersion() resolves.
  useEffect(() => {
    if (!RELAY_AVAILABLE) return;
    const id = workspace?.deviceUserId;
    if (!id || !appVersion) return;
    relay
      .register(id, workspace?.platform ?? "unknown", appVersion)
      .catch(() => undefined); // silent — relay availability is best-effort
  }, [appVersion, workspace?.deviceUserId, workspace?.platform]);

  // Background connector-identify. Runs ONCE per app session (not per page
  // mount), so switching between Modules/Connectors/Chat doesn't restart it.
  // For each connected service without a stored email label, fires a
  // background Claude task (e.g. GMAIL_FETCH_EMAILS sent header → email)
  // and persists the result. Idempotent — second app launch sees stored
  // labels and skips entirely.
  useEffect(() => {
    if (!RELAY_AVAILABLE) return;
    const deviceUserId = workspace?.deviceUserId;
    const claudePath = claude?.path;
    if (!deviceUserId || !claudePath || !claude?.runtimeOk) return;

    let cancelled = false;
    (async () => {
      try {
        // 1. Hydrate any already-stored labels so we don't re-run identify.
        const stored = new Set<string>();
        const services = [
          "gmail", "google-calendar", "slack", "clickup", "notion", "github",
          // DataOS connectors
          "stripe", "youtube", "google-analytics", "google-sheets"
        ];
        for (const service of services) {
          if (cancelled) return;
          try {
            const r = await invoke<{ key: string; value: string | null }>("get_setting", { key: `connector_label_${service}` });
            if (r?.value) stored.add(service);
          } catch { /* non-fatal */ }
        }
        // 2. Find connected services that have NO stored label yet.
        const live = await relay.listConnections(deviceUserId).catch(() => null);
        if (!live || cancelled) return;
        const needsIdentify = live.connections.filter((c) => c.status === "connected" && !stored.has(c.service));
        if (needsIdentify.length === 0) return;
        // 3. Process at most 2 identify tasks concurrently. Each fires a
        // Claude CLI subprocess that holds ~50 MB + opens an MCP connection
        // — running all 6 at once would blow memory + hit network limits.
        const queue = [...needsIdentify];
        const runOne = async (): Promise<void> => {
          while (!cancelled) {
            const c = queue.shift();
            if (!c) return;
            const prompt = identifyPromptFor(c.service);
            if (!prompt) continue;
            try {
              const res = await invoke<{ response: string }>("run_task", {
                prompt,
                claudePath,
                streamId: `bg-identify-${c.service}-${Date.now()}`,
                // Use Haiku for identify — it's a one-tool-call extraction
                // task that doesn't need Sonnet/Opus reasoning. ~3x faster.
                model: "haiku"
              });
              const raw = (res?.response || "").trim();
              const emailMatch = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
              const handleMatch = raw.match(/@[A-Za-z0-9_.-]{2,}/);
              const label =
                emailMatch?.[0] ||
                (handleMatch?.[0] && !raw.toUpperCase().includes("UNKNOWN") ? handleMatch[0] : null);
              if (label) {
                await invoke("set_setting", { key: `connector_label_${c.service}`, value: label }).catch(() => undefined);
              }
            } catch { /* per-service identify failure is non-fatal */ }
          }
        };
        await Promise.all([runOne(), runOne()]);
      } catch { /* non-fatal — Connectors page can still trigger manual identify */ }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.deviceUserId, claude?.path, claude?.runtimeOk]);

  useEffect(() => {
    window.aios?.window?.onMaximizedChanged?.((next) => setMaximized(next));
  }, []);

  // Listen for the shortcut:preferences IPC event. Fires from two sources:
  //   - Cmd+, hotkey (Mac) registered in main/main.ts
  //   - control_open_settings IPC (Control popup's Settings button)
  // Both want to land the user on the Settings screen in the main window.
  useEffect(() => {
    window.aios?.window?.onShortcutPreferences?.(() => setScreen("settings"));
  }, []);

  // Cmd+K (Mac) / Ctrl+K (Win) — new chat from anywhere. Matches the
  // ChatGPT / Slack / Linear / Cursor convention; the muscle memory most
  // chat-app power users have. Navigates to the chat screen + creates a
  // fresh thread + focuses the composer via the existing set-prompt
  // dispatch path.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cmdOrCtrl = e.metaKey || e.ctrlKey;
      if (!cmdOrCtrl || e.key.toLowerCase() !== "k" || e.shiftKey || e.altKey) return;
      e.preventDefault();
      void (async () => {
        try {
          const created = await invoke<ChatSession>("create_thread", { title: "New chat" });
          setSessions((current) => [created, ...current]);
          setActiveSessionId(created.id);
          setScreen("command");
          // Empty set-prompt dispatch just focuses the composer.
          window.setTimeout(() => {
            document.dispatchEvent(new CustomEvent("aios:set-prompt", { detail: "" }));
          }, 60);
        } catch { /* swallow — non-critical */ }
      })();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Mac-only first-launch permissions modal. The MacPermissionsModal
  // (rendered below) walks the user through the 4 macOS TCC permissions
  // ONE AT A TIME, gated by an explicit "Grant" or "Skip" click for each.
  // No native dialog or Settings pane fires until the user clicks Grant.
  // Replaces the v0.2.18 auto-firing chain that triggered all 4 native
  // dialogs back-to-back without any AIOS-side context — felt
  // overwhelming on first boot.
  //
  // Marked done in localStorage when the modal closes (Finish, Skip-all,
  // X dismiss, or Escape) — never re-asked on subsequent launches. Users
  // can still grant any missed permission via System Settings whenever
  // they want.
  useEffect(() => {
    if (!workspace) return;
    if (workspace.platform !== "darwin") return;
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem("aios.macPermissionsAsked.v1") === "1") return;
    setShowMacPermissions(true);
  }, [workspace?.platform]);

  // Toggle body.window-hidden so all CSS animations pause when the window is
  // not visible (saves compositor work while the user is in another app).
  useEffect(() => {
    const sync = () => {
      document.body.classList.toggle("window-hidden", document.visibilityState !== "visible");
    };
    sync();
    document.addEventListener("visibilitychange", sync);

    const isMac = workspace?.platform === "darwin" || (typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh"));
    if (isMac) {
      document.body.classList.add("is-mac");
    } else {
      document.body.classList.remove("is-mac");
    }

    return () => {
      document.removeEventListener("visibilitychange", sync);
    };
  }, [workspace?.platform]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshWorkspace().catch(() => undefined);
    }, 60000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!window.aios?.onHostEvent) return () => undefined;
    return window.aios.onHostEvent((event) => {
      if (event.event === "auto_task_complete" || event.event === "session_updated") {
        refreshWorkspace().catch(() => undefined);
        return;
      }
      // Main process broadcasts this when backfillStarterKit healed a missing
      // or partial INFRA_DIR (module-installs/, .claude/, reference/). Refresh
      // immediately so the user doesn't have to wait for the 60s polling tick
      // to see "Source missing" flip to the correct module status.
      if (event.event === "workspace_backfilled") {
        refreshWorkspace().catch(() => undefined);
        return;
      }
      // Stream deltas are handled at the App level (not CommandScreen) so the
      // user can navigate to another page mid-response without losing it —
      // setSessions keeps writing into the matching message by streamId even
      // when CommandScreen is unmounted. Without this, returning to chat
      // shows "Claude is thinking" forever for the empty assistant bubble.
      if (event.event === "claude_stream") {
        const payload = event.data as {
          streamId?: string;
          delta?: string;
          response?: string;
          done?: boolean;
          sessionId?: string;
        };
        if (!payload?.streamId) return;
        const matchId = payload.streamId;
        setSessions((current) => current.map((session) => {
          let touched = false;
          const nextMessages = session.messages.map((m) => {
            if (m.streamId !== matchId) return m;
            touched = true;
            const nextContent =
              payload.response !== undefined
                ? payload.response
                : payload.delta
                ? `${m.content}${payload.delta}`
                : m.content;
            const clearStream = payload.done || payload.response !== undefined;
            return {
              ...m,
              content: nextContent,
              streamId: clearStream ? null : m.streamId
            };
          });
          if (!touched) return session;
          const claudeUpdate = payload.sessionId ? { claudeSessionId: payload.sessionId } : {};
          return { ...session, ...claudeUpdate, messages: nextMessages };
        }));
      }
    });
  }, [refreshWorkspace]);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null;
  const contextSections = useMemo(() => buildContextSections(context, recent), [context, recent]);
  const connections = useMemo<ConnectionStatus[]>(
    () => buildConnections(claude, modules, context, workspace),
    [claude, modules, context, workspace]
  );
  const activeModules = modules.filter((module) => module.installed).length;
  const workspaceReady = Boolean(workspace?.hasClaudeMd);
  const setupRequired = Boolean(onboarding && !onboarding.completedAt);
  const recentSessions = useMemo(
    () => sessions.filter((session) => session.messages.some((m) => m.content?.trim())).slice(0, 12),
    [sessions]
  );

  function displayTitle(session: ChatSession): string {
    const raw = (session.title || "").trim();
    const generic = !raw || raw.toLowerCase() === "new chat" || raw.toLowerCase() === "new thread" || raw.toLowerCase() === "main";
    if (!generic) return raw;
    const firstUser = session.messages.find((m) => m.role === "user" && m.content?.trim());
    if (firstUser) {
      const text = firstUser.content.trim().replace(/\s+/g, " ");
      return text.length > 48 ? `${text.slice(0, 47)}…` : text;
    }
    return raw || "New chat";
  }
  const currentTitle = {
    command: "Command",
    context: "Context",
    imports: "Imports",
    outputs: "Outputs",
    plans: "Plans",
    tasks: "Tasks",
    agents: "Agents",
    "auto-tasks": "Auto Tasks",
    modules: "Modules",
    connectors: "Connectors",
    briefs: "Daily briefs",
    history: "History",
    settings: "Settings",
    onboarding: "Welcome"
  }[screen];

  if (loading) {
    // Subtitle steps through these as time passes so the user sees continuous
    // activity. Pinned to "longer than usual" once the 10s loadingSlow timer
    // fires — at that point we surface the Retry escape hatch underneath.
    const splashMessages = [
      "Connecting workspace, Claude runtime, and threads…",
      "Verifying Claude runtime…",
      "Starting the AIOS engine…",
      "Almost ready, hang tight…",
      "Setting up for the first time — this can take up to a minute."
    ];
    const splashText = loadingSlow
      ? "This is taking longer than usual."
      : splashMessages[Math.min(splashStage, splashMessages.length - 1)];
    return (
      <div className="app-loading">
        <div className="app-loading-card">
          <BrandMark size={48} variant="filled" />
          <div className="app-loading-copy">
            <strong>Loading <em>AIOS</em></strong>
            <p>{splashText}</p>
          </div>
          <div className="app-loading-bar" aria-label="Loading">
            <span />
          </div>
          {loadingSlow ? (
            <button type="button" className="btn-pill-ghost" onClick={() => window.location.reload()}>
              Retry
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${setupRequired ? "setup-required" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} data-screen={screen}>
      {!setupRequired ? (
      <aside className="app-sidebar aios-sb-v2">
        <div className="sidebar-brand">
          <BrandMark size={32} variant="filled" />
          {!sidebarCollapsed && (
            <div className="brand-copy">
              <strong>AIOS</strong>
              <span>{workspaceReady ? "Local workspace" : "Setup required"}</span>
            </div>
          )}
          <button
            className="sidebar-toggle-btn"
            type="button"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <PanelLeft size={16} />
          </button>
        </div>

        <button
          className="sidebar-quick-action"
          type="button"
          onClick={async () => {
            try {
              const created = await invoke<ChatSession>("create_thread", { title: "New chat" });
              // Refetch the authoritative session list immediately so we don't
              // race with the 60s refreshWorkspace polling — otherwise an
              // in-flight refresh can overwrite the prepended thread and the
              // active id falls back to the previous session.
              const fresh = await invoke<ChatSession[]>("get_sessions");
              const merged = fresh.some((s) => s.id === created.id) ? fresh : [created, ...fresh];
              setSessions(merged);
              setActiveSessionId(created.id);
              setScreen("command");
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              setError(`Could not create new chat: ${message}`);
            }
          }}
        >
          <Plus />
          <span>New chat</span>
        </button>

        <nav className="sidebar-nav" aria-label="Primary">
          <NavItem icon={<MessageSquare />} label="Chat" active={screen === "command"} onClick={() => setScreen("command")} />
          <NavItem icon={<FileText />} label="Context" active={screen === "context"} onClick={() => setScreen("context")} />
          <NavItem icon={<Inbox />} label="Imports" active={screen === "imports"} onClick={() => setScreen("imports")} />
          <NavItem icon={<Boxes />} label="Modules" active={screen === "modules"} onClick={() => setScreen("modules")} />
          <NavItem icon={<Users />} label="Agents" active={screen === "agents"} onClick={() => setScreen("agents")} />
          <NavItem icon={<Plug />} label="Connectors" active={screen === "connectors"} onClick={() => setScreen("connectors")} />
          <NavItem icon={<ClipboardList />} label="Plans" active={screen === "plans"} onClick={() => setScreen("plans")} />
          <NavItem icon={<LayoutGrid />} label="Tasks" active={screen === "tasks"} onClick={() => setScreen("tasks")} />
          <NavItem icon={<FolderOpen />} label="Outputs" active={screen === "outputs"} onClick={() => setScreen("outputs")} />
          <NavItem icon={<Sun />} label="Brief" active={screen === "briefs"} onClick={() => setScreen("briefs")} />
        </nav>

        <section className="sidebar-group aios-recent-group">
          <button
            type="button"
            className="aios-recent-head"
            onClick={() => setScreen("history")}
            title="View all chats"
          >
            <Clock />
            <span>History</span>
          </button>
          <div className="aios-recent-list">
            {recentSessions.length === 0 ? (
              <p className="aios-recent-empty">No chats yet</p>
            ) : (
              recentSessions.map((session) => {
                const label = displayTitle(session);
                return (
                  <div key={session.id} className="aios-recent-wrapper">
                    <button
                      className={`aios-recent-item ${activeSessionId === session.id ? "active" : ""}`}
                      onClick={() => {
                        setActiveSessionId(session.id);
                        setScreen("command");
                      }}
                      title={label}
                    >
                      {label}
                    </button>
                    <button
                      className="aios-recent-more"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteThread(session.id);
                      }}
                      title="Delete chat"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <div className="aios-sidebar-footer">
          <button
            className="aios-sidebar-voice"
            type="button"
            onClick={() => { void invoke("control_bubble_toggle"); }}
            title="Toggle Computer Control bubble (Ctrl+Alt+V opens it)"
          >
            <Bot />
            <span>Control</span>
          </button>
          <button className="aios-sidebar-settings" type="button" onClick={() => setScreen("settings")} title="Settings">
            <Settings />
            <span>Settings</span>
          </button>
        </div>
      </aside>
      ) : null}

      <main className="app-main">
        <header className={`topbar${maximized ? " is-maximized" : ""}`}>
          <div className="windows-titlebar-left">
            <nav className="windows-menu-bar" aria-label="Application menu">
              <span>{currentTitle}</span>
            </nav>
          </div>

          <div className="topbar-status">
            {screen !== "command" && !setupRequired ? <StatusBadge tone={activeModules ? "neutral" : "warning"} label={`${activeModules} modules`} /> : null}
          </div>

          {workspace?.platform !== "darwin" ? (
            <div className="window-controls" aria-label="Window controls">
              <button className="window-control" type="button" aria-label="Minimize window" onClick={() => window.aios?.window?.minimize()}>
                <Minus />
              </button>
              <button className="window-control" type="button" aria-label={maximized ? "Restore window" : "Maximize window"} onClick={() => window.aios?.window?.maximize()}>
                <Square />
              </button>
              <button className="window-control close" type="button" aria-label="Close window" onClick={() => window.aios?.window?.close()}>
                <X />
              </button>
            </div>
          ) : null}
        </header>

        <AutoUpdateBanner
          platform={workspace?.platform ?? null}
          onNavigateToSettings={() => setScreen("settings")}
        />
        <WhatsNewBanner />

        {error ? <div className="banner banner-danger">{error}</div> : null}

        {/* CommandScreen stays ALWAYS-MOUNTED while not in setup so that
            navigating to Tasks/Connectors/etc. mid-stream doesn't unmount
            it. Unmounting would: (a) lose the optimistic user message before
            save_session fires, leaving the 60s mergeSessions poll to clobber
            it with the stale DB snapshot, (b) drop the chat input draft,
            (c) interrupt the streaming animation. The `display:none` toggle
            preserves React state, DOM, focus, and scroll position. Other
            screens stay conditional — only chat has in-flight state to
            protect. */}
        {!setupRequired ? (
          <div
            className="screen-enter"
            style={{ display: screen === "command" ? undefined : "none" }}
          >
          <CommandScreen
            claude={claude}
            onboarding={onboarding}
            context={context}
            modules={modules}
            outputs={outputs}
            plans={plans}
            recent={recent}
            connections={connections}
            activeSession={activeSession}
            onDetectClaude={detectClaude}
            onSessionsChange={setSessions}
            onRefreshWorkspace={refreshWorkspace}
            onNavigate={setScreen}
            onNewChat={async () => {
              try {
                const created = await invoke<ChatSession>("create_thread", { title: "New chat" });
                const fresh = await invoke<ChatSession[]>("get_sessions");
                const merged = fresh.some((s) => s.id === created.id) ? fresh : [created, ...fresh];
                setSessions(merged);
                setActiveSessionId(created.id);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
            onOpenAttachment={(att) => {
              setPendingAttachmentOpen({ kind: att.kind, path: att.path });
              setScreen(att.kind === "plan" ? "plans" : "outputs");
            }}
          />
          </div>
        ) : null}

        {setupRequired ? (
          <div className="screen-enter">
          <OnboardingScreen
            state={onboarding}
            claude={claude}
            onRefreshWorkspace={refreshWorkspace}
            onClaudeChanged={detectClaude}
            onNavigate={(next) => setScreen(next)}
          />
          </div>
        ) : null}

        {screen === "context" && !setupRequired ? (
          <div className="screen-enter">
          <ContextScreen
            sections={contextSections}
            imports={context.imports}
            onRefresh={refreshWorkspace}
            onAskClaude={openInNewChat}
          />
          </div>
        ) : null}

        {screen === "outputs" && !setupRequired ? (
          <div className="screen-enter">
          <OutputsScreen
            outputs={outputs}
            shares={shares}
            onAskClaude={openInNewChat}
            onRefresh={refreshWorkspace}
            initialOpenPath={pendingAttachmentOpen?.kind === "output" ? pendingAttachmentOpen.path : null}
            onInitialOpenConsumed={() => setPendingAttachmentOpen(null)}
          />
          </div>
        ) : null}

        {screen === "plans" && !setupRequired ? (
          <div className="screen-enter">
          <PlansScreen
            entries={plans}
            onAskClaude={openInNewChat}
            onRefresh={refreshWorkspace}
            initialOpenPath={pendingAttachmentOpen?.kind === "plan" ? pendingAttachmentOpen.path : null}
            onInitialOpenConsumed={() => setPendingAttachmentOpen(null)}
          />
          </div>
        ) : null}

        {screen === "tasks" && !setupRequired ? (
          <div className="screen-enter">
          <TasksScreen onNavigate={setScreen} />
          </div>
        ) : null}

        {screen === "agents" && !setupRequired ? (
          <div className="screen-enter">
            <AgentsScreen claude={claude} />
          </div>
        ) : null}

        {screen === "auto-tasks" && !setupRequired ? (
          <div className="screen-enter">
          <AutoTasksScreen />
          </div>
        ) : null}

        {screen === "history" && !setupRequired ? (
          <div className="screen-enter">
          <HistoryScreen
            sessions={sessions}
            activeSessionId={activeSessionId}
            onOpenSession={(id) => {
              setActiveSessionId(id);
              setScreen("command");
            }}
            onSessionsChange={(updater) => {
              setSessions((current) => {
                const next = updater(current);
                if (activeSessionId && !next.find((s) => s.id === activeSessionId)) {
                  setActiveSessionId(next[0]?.id ?? null);
                }
                return next;
              });
            }}
          />
          </div>
        ) : null}

        {screen === "imports" && !setupRequired ? (
          <div className="screen-enter">
          <ImportsScreen
            onAskClaude={openInNewChat}
          />
          </div>
        ) : null}

        {screen === "modules" && !setupRequired ? (
          <div className="screen-enter">
          <ModulesScreen
            modules={modules}
            connections={connections}
            onChanged={refreshWorkspace}
            onAskClaude={openInNewChat}
            onNavigate={(target) => setScreen(target as Screen)}
          />
          </div>
        ) : null}
        {screen === "briefs" && !setupRequired ? (
          <div className="screen-enter">
            <BriefsScreen />
          </div>
        ) : null}
        {screen === "connectors" && !setupRequired ? (
          <div className="screen-enter">
            <ConnectorsScreen deviceUserId={workspace?.deviceUserId ?? ""} claude={claude} />
          </div>
        ) : null}
        {screen === "settings" && !setupRequired ? (
          <div className="screen-enter">
          <SettingsScreen
            claude={claude}
            workspace={workspace}
            onClaudeChanged={detectClaude}
            connections={connections}
            onOnboardingReset={async () => {
              await refreshWorkspace();
              setScreen("command");
            }}
          />
          </div>
        ) : null}
      </main>
      {briefStatus && !briefDismissed ? (
        <DailyBriefModal
          status={briefStatus}
          claude={claude}
          onAcknowledge={() => setBriefDismissed(true)}
          onOpenBriefsPage={() => {
            setBriefDismissed(true);
            setScreen("briefs");
          }}
        />
      ) : null}
      <ConfirmModal
        open={!!confirmDeleteThreadId}
        title="Delete chat?"
        message="This chat and its history will be removed permanently."
        confirmLabel="Delete"
        danger
        onConfirm={handleConfirmDeleteThread}
        onCancel={() => setConfirmDeleteThreadId(null)}
      />
      {showMacPermissions ? (
        <MacPermissionsModal
          onClose={() => {
            try { localStorage.setItem("aios.macPermissionsAsked.v1", "1"); } catch { /* ignore */ }
            setShowMacPermissions(false);
          }}
        />
      ) : null}
    </div>
  );
}

// One renderer bundle, four surfaces selected by URL flag:
//   ?aios-cursor-overlay=1 → CursorOverlayApp (fullscreen click-through follower)
//   ?aios-control-bubble=1 → BubbleApp (small circular button window)
//   ?aios-control=1        → ControlApp (small panel window)
//   no flag                → full App (main AIOS window)
const search = new URLSearchParams(window.location.search);
const RootComponent =
  search.has("aios-cursor-overlay") ? <CursorOverlayApp /> :
  search.has("aios-control-bubble") ? <BubbleApp /> :
  search.has("aios-control") ? <ControlApp /> :
  <App />;
createRoot(document.getElementById("root")!).render(RootComponent);
