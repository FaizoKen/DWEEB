import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { isActivityMode } from "@/core/activity/runtime";
import { installCrashReporter } from "@/core/telemetry/reporter";
import { installStaleChunkRecovery } from "@/core/pwa/staleChunkRecovery";
import { trackAnalytics } from "@/core/telemetry/analytics";
import "@/styles/global.css";

const bootStartedAt = performance.now();

// Trap uncaught errors and dropped promises as early as possible — before either
// surface boots — so a crash during startup is reported too. Self-gates to a
// production build with a configured proxy; a no-op otherwise.
installCrashReporter();

// Arm deploy-skew recovery before the first dynamic import below: a stale
// cached shell whose hashed chunks were purged by a newer deploy gets one
// automatic reload onto the fresh build instead of dying at boot (see
// core/pwa/staleChunkRecovery). Must precede `bootActivity`/`bootWeb`, whose
// imports are exactly the ones that fail in that state.
installStaleChunkRecovery();

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
  // Start the editor chunk immediately. The common path used to wait for two
  // OAuth chunks, install/acquisition helpers and service-worker registration
  // before even discovering App, leaving the first paint idle on cold mobile
  // connections. OAuth-return popups are rare; accepting this speculative
  // fetch there removes a full serial network stage for every real visit.
  const appPromise = import("@/app/App");
  const installPromptPromise = import("@/core/pwa/installPrompt");
  const acquisitionPromise = import("@/core/seo/acquisition");

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
  const [{ App }, { captureInstallPrompt }, { captureSeoAcquisition }] = await Promise.all([
    appPromise,
    installPromptPromise,
    acquisitionPromise,
  ]);
  captureInstallPrompt();
  captureSeoAcquisition();
  let finishedBoot = false;
  const finishBoot = (event: Event) => {
    if (finishedBoot) return;
    finishedBoot = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("dweeb:app-ready"));
        const surface =
          event instanceof CustomEvent && event.detail?.surface === "directory"
            ? "directory"
            : "builder";
        trackAnalytics("app_surface_ready", {
          boot_ms: performance.now() - bootStartedAt,
          surface,
        });
        schedulePwaRegistration();
      });
    });
  };
  // App reports when either the editor or the lazy first-visit gallery has
  // actually committed. Measuring the lightweight Suspense placeholder would
  // understate boot time and let analytics/precache race the critical surface.
  window.addEventListener("dweeb:surface-ready", finishBoot, { once: true });
  // A directory view is an interactive landing surface, not builder
  // activation. Count `builder_ready` only once the actual editor commits.
  window.addEventListener(
    "dweeb:builder-ready",
    () => trackAnalytics("builder_ready", { boot_ms: performance.now() - bootStartedAt }),
    { once: true },
  );
  mount(<App />);
}

/**
 * Install/update the offline worker only after the first app paint. Workbox
 * downloads every precache entry during registration; doing that before mount
 * made optional offline bytes compete with the editor and its media for LCP.
 */
function schedulePwaRegistration(): void {
  if (!import.meta.env.PROD) return;
  const run = () => void registerWebPwa();
  // A first visit commits a lightweight shell before its lazy gallery becomes
  // interactive. Give that critical chunk a real head start; rIC alone can run
  // immediately in the network gap and make Workbox's full precache compete.
  globalThis.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: 5_000 });
    } else {
      globalThis.setTimeout(run, 1_500);
    }
  }, 8_000);
}

async function registerWebPwa(): Promise<void> {
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
