import React, { useEffect, useState } from "react";
import { ConfirmModal } from "./ui";

// Auto-update popup — fires on Windows + Mac (signed + notarized since
// v0.2.7). The flow is intentionally HANDS-OFF until the moment of
// truth:
//
//   1. App boots → autoUpdater silently checks GitHub releases
//   2. Newer version found → autoDownload=true starts background download
//      → NO UI fired (user shouldn't be interrupted by a download they
//      didn't ask for)
//   3. Download completes → "ready" state arrives → THIS modal pops
//      asking "Install now or Later?"
//   4. Install now → quitAndInstall (with Mac auto-move-to-Applications
//      safety net handled in main.ts:aios:install-update)
//   5. Later → modal dismisses; autoInstallOnAppQuit=true means the
//      update installs on next regular quit anyway
//
// We deliberately do NOT redirect to Settings or to GitHub — the entire
// install is in-app and one click. The old "redirect to release page in
// browser" path was a fallback for unsigned Mac builds; with signed
// builds we never need it.

const SKIP_STORAGE_KEY = "aios.autoUpdate.skippedVersion";

interface AutoUpdateEvent {
  state: string;
  version?: string;
}

interface AutoUpdateBannerProps {
  platform?: string | null;
  // Kept for backwards compat with App.tsx wiring; the banner no longer
  // navigates anywhere because install is in-app.
  onNavigateToSettings?: () => void;
}

export function AutoUpdateBanner({ platform }: AutoUpdateBannerProps) {
  const [readyToInstall, setReadyToInstall] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [dismissedForVersion, setDismissedForVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // Auto-update is supported on the desktop OS targets we ship signed
  // installers for. Linux/headless dev modes are excluded.
  const isSupportedOs = platform === "win32" || platform === "darwin";

  useEffect(() => {
    if (!isSupportedOs) return;
    const unsubscribe = window.aios?.onUpdateState?.((event: AutoUpdateEvent) => {
      // Capture the version on every event (it propagates from "available"
      // through "downloading" to "ready") so the modal has it ready when
      // it finally fires.
      if (event.version) setVersion(event.version);
      // Modal opens ONLY on "ready" — not on "available". This is the
      // hands-off behavior: the user isn't asked to download (it just
      // happens), they're asked to install (the moment that requires
      // their attention because it relaunches the app).
      if (event.state === "ready") {
        setReadyToInstall(true);
      }
    });
    return () => unsubscribe?.();
  }, [isSupportedOs]);

  // Clear the persisted skip when a newer version comes in so the popup
  // shows again for the new version.
  useEffect(() => {
    if (!version) return;
    try {
      const persistedSkip = localStorage.getItem(SKIP_STORAGE_KEY);
      if (persistedSkip && persistedSkip !== version) {
        localStorage.removeItem(SKIP_STORAGE_KEY);
      }
    } catch {
      // localStorage may be unavailable in some sandbox configurations.
    }
  }, [version]);

  if (!isSupportedOs || !readyToInstall || !version) return null;

  let persistedSkip: string | null = null;
  try { persistedSkip = localStorage.getItem(SKIP_STORAGE_KEY); } catch { /* ignore */ }
  if (dismissedForVersion === version || persistedSkip === version) return null;

  function handleLater() {
    if (!version) return;
    // Dismiss the modal — autoInstallOnAppQuit=true means the update
    // still installs on next regular quit, so "Later" isn't "Never";
    // it's "I'll get it next time I close the app."
    setDismissedForVersion(version);
  }

  function handleSkipForever() {
    if (!version) return;
    try { localStorage.setItem(SKIP_STORAGE_KEY, version); } catch { /* ignore */ }
    setDismissedForVersion(version);
  }

  async function handleInstall() {
    if (!version) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await window.aios?.installUpdate?.();
      // On success: the OS-level swap quits this app, so we won't render
      // anything past this line. On Mac, if the app isn't in /Applications,
      // the install IPC handler moves it (auto-restarts) which also exits.
      // We only reach the failure branch if the IPC returned an error
      // structure (e.g. permissions, declined system dialog).
      if (result && !result.ok) {
        setInstalling(false);
        setInstallError(result.error || result.reason || "Install failed");
      }
    } catch (err) {
      setInstalling(false);
      setInstallError(err instanceof Error ? err.message : String(err));
    }
  }

  if (installError) {
    return (
      <ConfirmModal
        open={true}
        title="Update couldn't install"
        message={installError}
        confirmLabel="Try again"
        cancelLabel="Later"
        onConfirm={() => { setInstallError(null); handleInstall(); }}
        onCancel={handleLater}
      />
    );
  }

  return (
    <ConfirmModal
      open={true}
      title="Update ready"
      message={`AIOS Desktop v${version} downloaded and ready to install. ${installing ? "Installing…" : "The app will restart."}`}
      confirmLabel={installing ? "Installing…" : "Install & restart"}
      cancelLabel="Later"
      onConfirm={installing ? () => {} : handleInstall}
      onCancel={installing ? () => {} : handleLater}
    />
  );
}
