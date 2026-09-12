import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { isActivityMode } from "@/core/activity/runtime";
import {
  installCrashReporter,
  reportBackgroundFailure,
  reportBootFailure,
  reportDomDesync,
} from "@/core/telemetry/reporter";
import { describeError, isStaleChunkMessage } from "@/core/telemetry/crashReport";
import { installDomDesyncGuard } from "@/core/dom/domGuard";
import {
  installStaleChunkRecovery,
  recoverFromBootFailure,
  refreshPastStaleShell,
} from "@/core/pwa/staleChunkRecovery";
import {
  bootNoticeCopy,
  markBootShellUpdating,
  renderBootNotice,
  type BootNoticeReason,
} from "@/core/pwa/bootFailure";
import { trackAnalytics } from "@/core/telemetry/analytics";
import "@/styles/global.css";

const bootStartedAt = performance.now();

// Trap uncaught errors and dropped promises as early as possible — before either
// surface boots — so a crash during startup is reported too. Self-gates to a
// production build with a configured proxy; a no-op otherwise.
installCrashReporter();

// Make Preact's DOM bookkeeping survive a page something else rewrites —
// notably an in-page translator, which moves our text nodes into `<font>`
// wrappers and made the next render throw the whole app to the ErrorBoundary
// (see core/dom/domGuard). Must precede the first render, and its one-per-page
// report needs the reporter installed above.
installDomDesyncGuard(reportDomDesync);

// Arm deploy-skew recovery before the first dynamic import below: it strips the
// refresh nonce a previous recovery navigation may have left in the URL (before
// anything reads the URL for app state) and starts watching for the surface to
// commit. The recovery itself runs from `onBootFailure`: a stale cached shell
// whose hashed chunks were purged by a newer deploy climbs a short ladder of
// navigations onto the fresh build instead of dying at boot, and a boot that
// cannot be recovered ends in a notice, never a frozen "Loading…" (see
// core/pwa/staleChunkRecovery and core/pwa/bootFailure).
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
//
// Both boots are caught: a rejection here used to fall into the global
// `unhandledrejection` trap with the shell still saying "Loading…", which is how
// the 2026-09-11 stale-shell crash reached the maintainer twice from one tab
// while the visitor got nothing at all.
if (isActivityMode()) {
  void bootActivity().catch(onBootFailure);
} else {
  void bootWeb().catch(onBootFailure);
}

/**
 * The boot promise rejected — a chunk didn't load, or the entry threw. Climb the
 * recovery ladder if a rung is left (the shell says "Updating…" meanwhile);
 * otherwise turn the shell into a notice and report. Runs for both surfaces.
 */
function onBootFailure(error: unknown): void {
  console.error("[boot]", error);
  const outcome = recoverFromBootFailure(error, () => showBootFailure(error));
  if (outcome === "in-flight") return;
  if (outcome === "navigating") {
    markBootShellUpdating();
    return;
  }
  showBootFailure(error);
}

let bootFailureReported = false;

/** No automatic step left (or one never committed): the shell becomes the
 *  notice, its button is the manual path, and the failure is reported once. */
function showBootFailure(error: unknown): void {
  const { message } = describeError(error);
  const stale = isStaleChunkMessage(message);
  const reason: BootNoticeReason = stale
    ? navigator.onLine === false
      ? "offline"
      : "stale-chunk"
    : "error";
  const copy = bootNoticeCopy(
    reason,
    isActivityMode() ? "activity" : "web",
    stale ? undefined : message,
  );
  const button = renderBootNotice(copy);
  if (button) {
    button.addEventListener("click", () => {
      if (reason !== "stale-chunk") {
        window.location.reload();
        return;
      }
      // The bypass step on demand: fetch the shell afresh, past any worker. The
      // button is disabled until the navigation commits or is declared stuck.
      button.disabled = true;
      button.textContent = "Refreshing…";
      const restore = () => {
        button.disabled = false;
        button.textContent = copy.action;
      };
      if (!refreshPastStaleShell(restore)) restore();
    });
  }
  if (!bootFailureReported) {
    bootFailureReported = true;
    reportBootFailure(error);
  }
}

/** How long the outgoing boot shell takes to dissolve. Must match the
 *  `seo-boot-exit` animation in global.css. */
const BOOT_SHELL_EXIT_MS = 220;

/** Mount `node` under the shared StrictMode + ErrorBoundary root. */
function mount(node: ReactNode): void {
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("Missing #root element. Check index.html.");
  }
  // Keep the HTML-first product heading visible while boot chunks load, then
  // clear it out of the root immediately before Preact commits. It must never
  // survive *inside* the root: it can't stand beside App's rendered document
  // H1, and Preact's `render` treats a container's existing children as excess
  // DOM it may reuse or remove itself.
  const shell = container.querySelector<HTMLElement>("[data-seo-boot]");
  if (shell) container.replaceChildren();
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>{node}</ErrorBoundary>
    </StrictMode>,
  );
  if (shell) dismissBootShell(shell);
}

/**
 * Hand the HTML-first shell over to the rendered app without a cut.
 *
 * Dropping it outright replaced a full-screen product title with a full-screen
 * editor in one frame. On a warm load the shell is only up for ~70-200ms
 * (measured), so that reads as a flash rather than as a page loading. Instead
 * it is re-parented to <body> as an inert overlay above the app it just handed
 * over to, and faded out there — the app is already rendered underneath, so
 * nothing waits on this. Its background is the app's own chrome (see
 * `.seo-boot` in global.css), which is what keeps the dissolve to the title
 * alone instead of a cross-fade between two different-looking screens.
 */
function dismissBootShell(shell: HTMLElement): void {
  // A shell that already became the failure notice has nothing to hand over;
  // dissolving it over a live app would flash the notice. (Not reachable today —
  // a failed boot never mounts — but the invariant is cheap.)
  if (shell.dataset.seoBootState === "failed") {
    shell.remove();
    return;
  }
  // It carries an <h1> and briefly outlives App's own, so keep it out of the
  // accessibility tree and out of the way of pointers for the ~220ms it lives.
  shell.setAttribute("aria-hidden", "true");
  shell.dataset.seoBootExit = "";
  document.body.append(shell);
  const onEnd = (event: AnimationEvent) => {
    // Only our own dissolve ends the overlay — `animationend` bubbles, so a
    // descendant animation finishing first would cut the fade short, which is
    // the exact thing this exists to avoid.
    if (event.target !== shell) return;
    shell.removeEventListener("animationend", onEnd);
    shell.remove();
  };
  shell.addEventListener("animationend", onEnd);
  // `animationend` alone can't guarantee removal, and this element covers the
  // app until it goes: a backgrounded tab never runs the animation at all.
  globalThis.setTimeout(() => shell.remove(), BOOT_SHELL_EXIT_MS + 300);
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
  // Side branches only — the originals are still awaited below, so a failure
  // still surfaces once, through `onBootFailure`. Without these, a rejection
  // in the popup-flow stage below leaves three un-awaited promises behind it,
  // each of which reaches the global `unhandledrejection` trap on its own: the
  // 2026-09-11 page was one dead boot reported twice (`flows-*.js`, then
  // `App-*.js`). Never assign the result — a `.catch` in the chain would turn a
  // 404 into `undefined` and the destructuring below into a different crash.
  for (const speculative of [appPromise, installPromptPromise, acquisitionPromise]) {
    void speculative.catch(() => {});
  }

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
  // Keep the validated discovery-page handoff through initial routing even
  // though its URL token is removed before Preact mounts. An explicit "open
  // builder" click must not fall into the first-visit template directory.
  const seoEntry = captureSeoAcquisition();
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
    () => {
      trackAnalytics("builder_ready", { boot_ms: performance.now() - bootStartedAt });
      if (seoEntry) {
        trackAnalytics("seo_builder_ready", {
          source_type: seoEntry.sourceType,
          source_id: seoEntry.sourceId,
        });
      }
    },
    { once: true },
  );
  mount(<App seoEntry={seoEntry} />);
}

/**
 * Install/update the offline worker only after the first app paint. Workbox
 * downloads every precache entry during registration; doing that before mount
 * made optional offline bytes compete with the editor and its media for LCP.
 */
function schedulePwaRegistration(): void {
  if (!import.meta.env.PROD) return;
  // Handle the rejection rather than dropping it. This runs long after the app
  // is interactive and — because a backgrounded tab's timers are throttled to a
  // standstill — can fire hours later, by which time a deploy may have purged
  // the `virtual:pwa-register` chunk. Left unhandled, that 404 reached the
  // global rejection trap and was escalated to `stale-chunk-fatal`, paging the
  // maintainer (2026-07-27) about a tab whose editor was running perfectly and
  // had only missed its offline cache. See `reportBackgroundFailure`.
  const run = () => void registerWebPwa().catch(reportBackgroundFailure);
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
