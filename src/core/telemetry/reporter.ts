/**
 * Frontend crash reporter — the browser glue around the pure core in
 * `crashReport.ts`.
 *
 * The editor UI runs in the browser, so a runtime error that blanks it is
 * otherwise invisible to us unless a user reports it. This installs the two global
 * traps every uncaught error passes through — `error` (uncaught exceptions) and
 * `unhandledrejection` (dropped promises) — plus a hook the React
 * `ErrorBoundary` calls, and beacons a small, content-free crash report to the
 * proxy so failures in the wild show up in the server logs.
 *
 * It's the crash counterpart to the Activity handshake beacon
 * (`core/activity/telemetry.ts`) and shares its rules: it never throws into the
 * app, a dropped beacon is fine, and it sends only diagnostics — the error
 * message, a few stack frames, the version, and the URL *path*. Never the
 * `#hash` (that's the user's message payload), never storage, never inputs.
 *
 * Gated to production with a configured proxy: in dev the console is right
 * there, and with no proxy there's nowhere to send. Both guards are checked once
 * at install, so the handlers aren't even registered when disabled.
 */

import { proxyFetch } from "@/core/net/proxyFetch";
import { isProxyConfigured } from "@/core/guild/config";
import { isActivityMode } from "@/core/activity/runtime";
import { isStaleChunkReloadInProgress } from "@/core/pwa/staleChunkRecovery";
import {
  buildCrashPayload,
  crashSignature,
  CrashThrottle,
  isNonCrashMessage,
  resolveCrashKind,
  type CrashKind,
  type CrashPayload,
} from "./crashReport";

/** `__APP_VERSION__` is injected at build time by Vite's `define` (declared in
 *  vite-env.d.ts). Fall back to a sentinel if a build somehow omits it, so a
 *  report is never version-less. */
function appVersion(): string {
  try {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown";
  } catch {
    return "unknown";
  }
}

/** Only report from a real deployment that has somewhere to send to. */
function enabled(): boolean {
  if (typeof navigator === "undefined") return false;
  const privacySignals = navigator as Navigator & { globalPrivacyControl?: boolean };
  return (
    import.meta.env.PROD &&
    isProxyConfigured() &&
    privacySignals.globalPrivacyControl !== true &&
    navigator.doNotTrack !== "1"
  );
}

/** One throttle for the page's lifetime: dedups repeats and caps the total. */
const throttle = new CrashThrottle(5);

let installed = false;

/**
 * Install the global crash handlers. Idempotent and safe to call unconditionally
 * — it self-gates and no-ops when reporting is disabled or there's no `window`.
 * Call once, as early as possible, from the app entry.
 */
export function installCrashReporter(): void {
  if (installed || typeof window === "undefined" || !enabled()) return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    // Prefer the real Error (has a stack); fall back to the message string.
    report("error", event.error ?? event.message);
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    report("unhandledrejection", event.reason);
  });
}

/**
 * Report an error caught by the React `ErrorBoundary`. Exposed separately
 * because a boundary swallows the error before it reaches `window.onerror`, so
 * it would otherwise go unreported. Self-gates like the global handlers.
 */
export function reportBoundaryError(error: unknown): void {
  if (!enabled()) return;
  report("boundary", error);
}

/**
 * Report a post-boot lazy-chunk failure that `ChunkErrorBoundary` handled in
 * place (the surface showed a refresh prompt; the app kept running). Sent as
 * `stale-chunk`, which the proxy logs below paging level — routine deploy skew
 * is worth counting (a spike means an SW precache gap) but not a page. The
 * shared `report` path still drops it while a boot recovery reload is in
 * flight, and dedups repeats via the throttle.
 */
export function reportHandledStaleChunk(error: unknown): void {
  if (!enabled()) return;
  report("stale-chunk", error);
}

/** Shared path: build → throttle → beacon. Never throws. */
function report(kind: CrashKind, error: unknown): void {
  try {
    const payload = buildCrashPayload({
      kind,
      error,
      // Path ONLY — never `location.hash` (the share payload) or the query.
      path: typeof location !== "undefined" ? location.pathname : "",
      surface: isActivityMode() ? "activity" : "web",
      version: appVersion(),
    });
    // Some things the browser hands to `onerror` aren't crashes at all (the
    // ResizeObserver loop notice). Drop them before the throttle so they can't
    // spend a slot the next real crash needs.
    if (isNonCrashMessage(payload.message)) return;
    // Stale-chunk policy (see resolveCrashKind): dropped while the boot
    // recovery is already reloading past it; kept as `stale-chunk` when a
    // ChunkErrorBoundary handled it in place; escalated to `stale-chunk-fatal`
    // when nothing did — that last shape is the one that still pages.
    const resolvedKind = resolveCrashKind(kind, payload.message, isStaleChunkReloadInProgress());
    if (resolvedKind === null) return;
    payload.kind = resolvedKind;
    const sig = crashSignature(resolvedKind, payload.message, payload.stack);
    if (!throttle.shouldSend(sig)) return;
    send(payload);
  } catch {
    // A reporter that throws is worse than one that misses a crash.
  }
}

/** Fire-and-forget beacon. `keepalive` so it still flushes if the crash tears the
 *  page down; all errors swallowed — telemetry must never perturb the app. */
function send(payload: CrashPayload): void {
  try {
    void proxyFetch("/api/telemetry/crash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let telemetry disturb the app */
  }
}
