/**
 * "Install app" dialog.
 *
 * DWEEB has been an installable PWA since the manifest + precache service
 * worker shipped, but the only ways in were browser chrome. This dialog is the
 * app's own front door, and it adapts to what the current browser supports:
 *
 *  - Chromium (Chrome/Edge/…): we captured `beforeinstallprompt` in
 *    `core/pwa/installPrompt`, so a single "Install app" button replays the
 *    real native dialog — no instructions to read.
 *  - Everyone else (iOS/Safari, macOS Safari, desktop Firefox, …): those
 *    browsers install from their own menus, so we show the exact per-platform
 *    steps (detected from the UA) instead.
 *
 * Self-contained: reads open/close from `installStore`, so any entry point just
 * calls `openInstall()`. `App` mounts it lazily only while open.
 */

import { useMemo, useState } from "react";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { InstallIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import {
  detectInstallPlatform,
  promptInstall,
  type InstallPlatform,
} from "@/core/pwa/installPrompt";
import { useInstallState } from "./useInstallState";
import { useInstallStore } from "./installStore";
import styles from "./InstallDialog.module.css";

/** Ordered, human steps for browsers without a scriptable install prompt. */
const MANUAL_STEPS: Record<Exclude<InstallPlatform, "chromium">, string[]> = {
  ios: [
    "Open this page in Safari (other iOS browsers can’t add to the Home Screen).",
    "Tap the Share button — the square with an upward arrow — in the toolbar.",
    "Choose “Add to Home Screen”, then tap “Add”.",
  ],
  android: [
    "Open your browser’s menu (the ⋮ in the top-right).",
    "Tap “Install app” — or “Add to Home screen” on some browsers.",
    "Confirm, and DWEEB lands on your home screen.",
  ],
  "safari-mac": [
    "In Safari, click the Share button in the toolbar.",
    "Choose “Add to Dock”.",
    "DWEEB opens in its own window from the Dock.",
  ],
  firefox: [
    "Firefox on desktop can’t install web apps directly.",
    "Open this page in Chrome, Edge, or Safari to install it — or bookmark it here for one-click access.",
  ],
  unknown: [
    "Look for an “Install” or “Add to Home Screen” option in your browser’s menu or address bar.",
    "Not seeing one? Chrome, Edge, and Safari all support installing DWEEB.",
  ],
};

const PLATFORM_HEADING: Record<Exclude<InstallPlatform, "chromium">, string> = {
  ios: "Add to your Home Screen",
  android: "Add to your home screen",
  "safari-mac": "Add to your Dock",
  firefox: "Installing on Firefox",
  unknown: "Install from your browser",
};

export function InstallDialog() {
  const close = useInstallStore((s) => s.closeInstall);
  const { canPrompt } = useInstallState();

  // Detected once per open — the UA doesn't change mid-session.
  const platform = useMemo(() => detectInstallPlatform(), []);
  // Set from the Install click until the browser's prompt settles. The dialog's
  // path is held on this rather than read live from `canPrompt` alone:
  // `promptInstall()` spends the captured event — flipping `canPrompt` off —
  // *before* the browser's sheet opens, so a live read swapped the native path
  // for the manual steps (and "Opening…" never showed) while the user was still
  // answering the browser.
  const [prompting, setPrompting] = useState(false);
  const native = canPrompt || prompting;

  const install = async () => {
    if (prompting) return;
    setPrompting(true);
    // Called straight from the click, before any other await: the browser only
    // shows its sheet during the click's user activation.
    const outcome = await promptInstall();
    setPrompting(false);
    if (outcome === "accepted") {
      pushToast("Installing DWEEB…", "success");
      close();
    } else if (outcome === "dismissed") {
      // User saw the native prompt and backed out — respect that and close.
      // (The captured event is spent now anyway, so re-showing our dialog would
      // flip it to the manual-steps fallback, which reads as nagging.)
      close();
    } else {
      // "unavailable": the captured prompt was spent or withdrawn before we
      // could replay it (a race). Keep the dialog open — with the native event
      // gone it now shows the per-platform manual steps — and point there.
      pushToast("Use your browser’s install option below.", "info");
    }
  };

  // The native button is the whole story on Chromium; elsewhere we lead with
  // the per-platform steps. `steps`/`heading` only apply on the manual path.
  const steps = native ? null : MANUAL_STEPS[platform === "chromium" ? "unknown" : platform];
  const heading = PLATFORM_HEADING[platform === "chromium" ? "unknown" : platform];

  const footer = native ? (
    <>
      <Button variant="secondary" onClick={close}>
        Not now
      </Button>
      <Button
        variant="primary"
        leadingIcon={<InstallIcon />}
        onClick={() => void install()}
        disabled={prompting}
      >
        {prompting ? "Opening…" : "Install app"}
      </Button>
    </>
  ) : (
    <Button variant="secondary" onClick={close}>
      Got it
    </Button>
  );

  return (
    <Modal open onClose={close} title="Install DWEEB" footer={footer}>
      <div className={styles.hero} aria-hidden="true">
        <span className={styles.heroIcon}>
          <InstallIcon size={26} />
        </span>
      </div>

      <p className={styles.lead}>
        Add DWEEB to your device for a full-screen, app-like window — no browser bars, its own icon
        on your home screen or dock, and the editor still works offline.
      </p>

      {native ? (
        <p className={styles.note}>
          {prompting ? (
            "Answer your browser’s prompt to finish installing."
          ) : (
            <>
              Click <strong>Install app</strong> below to add it now.
            </>
          )}
        </p>
      ) : (
        <div className={styles.steps}>
          <h3 className={styles.stepsHeading}>{heading}</h3>
          <ol className={styles.stepList}>
            {steps!.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      <p className={styles.fine}>
        DWEEB stays private either way — everything runs in your browser, and installing changes
        nothing about that.
      </p>
    </Modal>
  );
}
