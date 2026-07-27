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
  backgroundFailureKind,
  buildCrashPayload,
  chunkFailureKind,
  chunkProbeUrl,
  crashSignature,
  CrashThrottle,
  describeError,
  isForeignCodeError,
  isNonCrashMessage,
  resolveCrashKind,
  type ChunkProbe,
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

/** `__BUILD_ID__`, the sibling define that identifies *this bundle* rather than
 *  the release. See `CrashInput.build` for why a report needs both. */
function buildId(): string {
  try {
    return typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "unknown";
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

/**
 * Report a rejection from optional post-boot background work — something the app
 * fires and forgets, that nothing on screen waits for (today: the service-worker
 * registration in `main.tsx`). Pass this as the `.catch` of such a task so the
 * rejection is *handled* rather than escaping to the global trap, where a failed
 * chunk load would be escalated to the page-worthy `stale-chunk-fatal` even
 * though the app never faltered. See [`backgroundFailureKind`] for the policy
 * (and the 2026-07-27 page that motivated it); a genuine fault in our own code
 * still reports — and pages — exactly as an unhandled rejection would.
 */
export function reportBackgroundFailure(error: unknown): void {
  if (!enabled()) return;
  report(backgroundFailureKind(describeError(error).message), error);
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
      build: buildId(),
    });
    // Some things the browser hands to `onerror` aren't crashes at all (the
    // ResizeObserver loop notice). Drop them before the throttle so they can't
    // spend a slot the next real crash needs.
    if (isNonCrashMessage(payload.message)) return;
    // Stale-chunk policy (see resolveCrashKind): dropped while the boot
    // recovery is already reloading past it; kept as `stale-chunk` when a
    // ChunkErrorBoundary handled it in place; escalated to `stale-chunk-fatal`
    // when nothing did. That escalation is provisional — it is checked against
    // the server below before the page-worthy shape is allowed out.
    const resolvedKind = resolveCrashKind(kind, payload.message, isStaleChunkReloadInProgress());
    if (resolvedKind === null) return;
    // Someone else's code (an extension/userscript/console script with an
    // unattributed stack, or a muted cross-origin script) crashing in our page
    // is not our crash — don't spend a beacon or a throttle slot on it. Checked
    // after the stale-chunk resolve so a Safari stale-chunk-fatal (whose stack
    // can be sparse) is never mistaken for foreign code. The proxy applies the
    // same rule to beacons from clients older than this filter.
    if (isForeignCodeError(resolvedKind, payload.message, payload.stack)) return;
    payload.kind = resolvedKind;
    // Throttle on the resolved kind, before any verification: the slot must be
    // claimed synchronously so a crash loop can't fire a probe per frame.
    const sig = crashSignature(resolvedKind, payload.message, payload.stack);
    if (!throttle.shouldSend(sig)) return;
    if (resolvedKind === "stale-chunk-fatal") {
      // "The app went down on a chunk load" — but not yet whose fault. Ask the
      // server whether that chunk is actually gone before sending the one shape
      // that pages. Probe from the UNCLAMPED message: a URL truncated by the
      // 300-char cap would 404 and manufacture a false page.
      void verifyChunkFailure(payload, describeError(error).message);
      return;
    }
    send(payload);
  } catch {
    // A reporter that throws is worse than one that misses a crash.
  }
}

/** How long to wait for the probe before calling the network unreachable. Long
 *  enough to outlast a slow link, short enough that the beacon still goes out
 *  while the page is alive. */
const PROBE_TIMEOUT_MS = 4_000;

/**
 * Re-request the chunk that failed and send the beacon with the kind its answer
 * justifies (see [`chunkFailureKind`]). Deliberately delays the beacon by up to
 * `PROBE_TIMEOUT_MS`: telemetry is best-effort and losing a report to a closed
 * tab costs far less than paging the maintainer about a visitor's dropped
 * connection. Never throws and never rejects — an escaping rejection here would
 * land straight back in our own `unhandledrejection` trap.
 */
async function verifyChunkFailure(payload: CrashPayload, rawMessage: string): Promise<void> {
  try {
    const origin = typeof location !== "undefined" ? location.origin : "";
    const url = origin ? chunkProbeUrl(rawMessage, origin) : null;
    payload.kind = chunkFailureKind(url === null ? "unknown" : await probeChunk(url));
  } catch {
    payload.kind = chunkFailureKind("unknown");
  }
  send(payload);
}

/** Ask our own host whether `url` is still served. Same-origin by construction
 *  (`chunkProbeUrl` guarantees it) and credential-free — this is a liveness
 *  question about a public static asset, nothing more. */
async function probeChunk(url: string): Promise<ChunkProbe> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      // Bypass every cache: a cached hit would answer for the deploy the tab
      // booted on, which is exactly the question we're asking.
      cache: "no-store",
      mode: "same-origin",
      credentials: "omit",
      signal: controller.signal,
    });
    if (res.ok) return "served";
    // 4xx is the host saying the asset is gone — the deploy-skew signature.
    // A 5xx is our host being broken, which is neither skew nor the visitor.
    return res.status >= 400 && res.status < 500 ? "missing" : "unknown";
  } catch {
    // Aborted, offline, DNS failure, blocked by an extension — the same class
    // of fault that killed the original import.
    return "unreachable";
  } finally {
    globalThis.clearTimeout(timer);
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
