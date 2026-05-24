/**
 * App shell.
 *
 * Lays out the toolbar + builder/preview split and hosts cross-cutting
 * features (share dialog, welcome dialog, toast viewport, keyboard shortcuts,
 * share-URL bootstrap, draft auto-save).
 *
 * First-visit flow:
 *  1. `bootstrap()` in the store seeds either a saved draft or the showcase
 *     preset.
 *  2. If the URL carries `#s=…`, `useShareUrlBootstrap` replaces it shortly.
 *  3. If the user has never dismissed the welcome dialog, it auto-opens so
 *     beginners get an obvious first click (template / blank / continue /
 *     import) instead of staring at an unfamiliar editor.
 *  4. From then on, every message change is persisted to `localStorage` via
 *     `useAutoSaveDraft` so a refresh restores the in-progress message.
 */

import { useState } from "react";
import { Toolbar } from "@/features/toolbar/Toolbar";
import { Builder } from "@/features/builder/Builder";
import { Preview } from "@/features/preview/Preview";
import { ShareDialog } from "@/features/share/ShareDialog";
import { WelcomeDialog } from "@/features/welcome/WelcomeDialog";
import { ToastViewport } from "@/ui/Toast";
import { hasSeenWelcome, markWelcomeSeen } from "@/core/state/draftStorage";
import { readShareTokenFromHash } from "@/core/serialization";
import { useShareUrlBootstrap } from "./useShareUrlBootstrap";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useAutoSaveDraft } from "./useAutoSaveDraft";

/**
 * Decides whether to auto-show the welcome dialog on mount. Skips it when:
 *  - the user has dismissed it before (returning visitor), or
 *  - the URL carries a share token (the user landed on someone else's link
 *    — interrupting that with onboarding would be confusing).
 */
function shouldAutoShowWelcome(): boolean {
  if (typeof window === "undefined") return false;
  if (readShareTokenFromHash(window.location.hash)) return false;
  return !hasSeenWelcome();
}

export function App() {
  useShareUrlBootstrap();
  useKeyboardShortcuts();
  useAutoSaveDraft();

  // The Share dialog is shared by every toolbar CTA on the right; `shareInitialTab`
  // picks which panel each entry point lands on so each button feels dedicated
  // even though they reuse the same dialog.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareInitialTab, setShareInitialTab] = useState<"send" | "share" | "restore">("send");
  const [welcomeOpen, setWelcomeOpen] = useState(shouldAutoShowWelcome);

  const openShareDialog = (tab: "send" | "share" | "restore") => {
    setShareInitialTab(tab);
    setShareOpen(true);
  };

  const dismissWelcome = () => {
    markWelcomeSeen();
    setWelcomeOpen(false);
  };

  const restoreFromWelcome = () => {
    // The user explicitly chose "Restore from Discord" in the welcome dialog.
    // Dismiss welcome (counts as making a choice) and drop them straight on
    // the Restore tab so they don't have to hunt for it again.
    dismissWelcome();
    openShareDialog("restore");
  };

  return (
    <div className="app-shell">
      <Toolbar
        onShare={() => openShareDialog("share")}
        onSend={() => openShareDialog("send")}
        onRestore={() => openShareDialog("restore")}
        onStartOver={() => setWelcomeOpen(true)}
      />
      <main className="app-shell__workspace">
        <section
          className="app-shell__pane app-shell__pane--builder"
          aria-label="Component builder"
        >
          <Builder />
        </section>
        <section className="app-shell__pane app-shell__pane--preview" aria-label="Message preview">
          <Preview />
        </section>
      </main>
      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        initialTab={shareInitialTab}
      />
      <WelcomeDialog
        open={welcomeOpen}
        onDismiss={dismissWelcome}
        onRestoreFromDiscord={restoreFromWelcome}
      />
      <ToastViewport />
    </div>
  );
}
