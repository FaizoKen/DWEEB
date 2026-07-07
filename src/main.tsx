import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { isActivityMode } from "@/core/activity/runtime";
import { installCrashReporter } from "@/core/telemetry/reporter";
import "@/styles/global.css";

// Trap uncaught errors and dropped promises as early as possible — before either
// surface boots — so a crash during startup is reported too. Self-gates to a
// production build with a configured proxy; a no-op otherwise.
installCrashReporter();

// Discord launches the Activity at our domain root with `?frame_id=…` in the
// query (the Developer Portal's Root Mapping points there). Detect that and boot
// the embedded surface; otherwise boot the web app.
//
// BOTH paths are loaded dynamically, so neither surface's code weighs on the
// other's first load. In particular the embedded Activity never downloads the
// web shell (`App` → Builder chrome, the OAuth popup flows, template/AI/feedback
// wiring, the service-worker update prompt), and the public site never downloads
// the Embedded App SDK. The always-run entry itself stays tiny — just the branch
// decision — so the code split is the whole payload difference between surfaces.
if (isActivityMode()) {
  void bootActivity();
} else {
  void bootWeb();
}

/** Mount `node` under the shared StrictMode + ErrorBoundary root. */
function mount(node: ReactNode): void {
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("Missing #root element. Check index.html.");
  }
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>{node}</ErrorBoundary>
    </StrictMode>,
  );
}

async function bootActivity(): Promise<void> {
  const { ActivityApp } = await import("@/activity/ActivityApp");
  mount(<ActivityApp />);
}

async function bootWeb(): Promise<void> {
  // When we're an OAuth popup returning (webhook create / login / add-bot), hand
  // the result back to the window that opened us and close — never boot the full
  // app in the popup. These flows are web-only, so they're imported here rather
  // than in the always-run entry, keeping them out of the Activity's payload.
  const [{ relayPopupIfApplicable }, { botAddFlow, loginFlow, webhookFlow }] = await Promise.all([
    import("@/core/oauth/popupFlow"),
    import("@/core/oauth/flows"),
  ]);
  if (
    relayPopupIfApplicable(webhookFlow) ||
    relayPopupIfApplicable(loginFlow) ||
    relayPopupIfApplicable(botAddFlow)
  ) {
    return;
  }

  // Start listening for the browser's PWA install signal as early as the real
  // app boot allows — before the app chunk mounts. Chromium fires
  // `beforeinstallprompt` only after the manifest + service worker are verified
  // (which happens well after this runs), and capturing it lets the Builder's
  // "Install app" menu replay the real native dialog on demand (see
  // core/pwa/installPrompt). A no-op on browsers that never fire it.
  const { captureInstallPrompt } = await import("@/core/pwa/installPrompt");
  captureInstallPrompt();

  // Register the precache service worker (production only — the dev SW would
  // fight HMR). A new deploy installs in the background and waits (see the
  // `registerType: "prompt"` rationale in vite.config.ts), so this never
  // hot-swaps chunks under an open tab. When it's ready we surface a persistent
  // Discord-style "Update" button (see `UpdatePrompt`); clicking it activates the
  // waiting worker via this same `updateSW` and reloads onto the new build.
  if (import.meta.env.PROD) {
    const [{ registerSW }, { useUpdateStore }] = await Promise.all([
      import("virtual:pwa-register"),
      import("@/core/state/updateStore"),
    ]);
    const updateSW = registerSW({
      onNeedRefresh() {
        useUpdateStore.getState().markReady(updateSW);
      },
    });
  }

  const { App } = await import("@/app/App");
  mount(<App />);
}
