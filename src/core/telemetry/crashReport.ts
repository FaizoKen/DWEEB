/**
 * Pure crash-report logic — no browser globals, no network.
 *
 * The browser glue in `reporter.ts` supplies the raw pieces (a thrown value, the
 * current path, the surface); everything here is a pure transform so it can be
 * unit-tested without a DOM. Two jobs:
 *
 *  1. **Shape** an untrusted thrown value into a bounded, content-free wire
 *     payload — the error message, a few stack frames, version, surface, and the
 *     URL *path* (never the `#hash`, which carries the user's message). The proxy
 *     re-clamps everything, but clamping here too keeps the beacon small on the
 *     wire and the intent obvious at the call site.
 *
 *  2. **Throttle** so a crash *loop* (a render error that re-throws every frame)
 *     can't turn into a flood of beacons: each distinct signature is sent once,
 *     and a hard per-session cap bounds the total regardless.
 */

/** Where the error surfaced. Beyond the three raw traps, `dom-desync` reports a
 *  crash the app *prevented* (see `core/dom/domGuard`: something rewrote the DOM
 *  under Preact and the guard repaired the placement instead of letting it
 *  throw) — counted, never paged. Three chunk-load refinements (see
 *  [`resolveCrashKind`] and [`chunkFailureKind`]) tell the proxy how bad the
 *  rest was:
 *  `stale-chunk` = a lazy surface failed post-boot but was handled in place
 *  (the user got a refresh prompt, the app kept running — the proxy logs it
 *  below paging level); `chunk-unreachable` = the app went down on a chunk
 *  load, but re-requesting that chunk proved it is still being served (or the
 *  network couldn't be reached at all), so the fault is the visitor's
 *  connection, not our deploy — counted, never paged; `stale-chunk-fatal` =
 *  the same failure took the app down *and* the chunk is genuinely gone
 *  (the re-request 404'd) — that one still pages, because it means a broken
 *  deploy or an SW precache gap. */
export type CrashKind =
  | "error"
  | "unhandledrejection"
  | "boundary"
  | "dom-desync"
  | "stale-chunk"
  | "chunk-unreachable"
  | "stale-chunk-fatal";

/** The content-free beacon sent to `POST /api/telemetry/crash`. */
export interface CrashPayload {
  kind: CrashKind;
  message: string;
  stack: string;
  version: string;
  /** Which bundle is reporting — see [`CrashInput.build`]. */
  build: string;
  surface: string;
  path: string;
}

/** Everything the pure builder needs; the glue reads these from the environment. */
export interface CrashInput {
  kind: CrashKind;
  /** The raw thrown value — an `Error`, a string, or anything at all. */
  error: unknown;
  /** `location.pathname` only (the caller must not pass query or hash). */
  path: string;
  /** `"web"` or `"activity"`. */
  surface: string;
  /** The app release version (package.json semver). */
  version: string;
  /**
   * Identity of the running bundle (`__BUILD_ID__` — the commit, or a build
   * timestamp). Distinct from `version`, which is the release semver and has
   * read `1.0.0` since launch: the app ships from a service-worker cache, so
   * clients keep beaconing from a bundle for weeks after it is replaced, and
   * without this a log line can't say whether it comes from a build that
   * already contains the fix for what it is reporting.
   */
  build: string;
}

// Client-side caps. Mirror the server's (`telemetry.rs`) so what we build is what
// lands in a log line — a touch of headroom on the message since the server is
// the final authority.
const MESSAGE_MAX = 300;
const STACK_MAX = 800;
/** Stack traces are deep and mostly noise after the throwing frames; the top few
 *  identify the site, and more just eats the byte budget. */
const STACK_FRAMES = 6;

/**
 * Coax an unknown thrown value into a `{ message, stack }` pair without ever
 * throwing itself (a reporter that crashes on a weird throw is worse than
 * useless). Handles the common shapes: `Error`, a bare string, an object with a
 * `message`, and the truly unexpected (numbers, `null`, symbols).
 */
export function describeError(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || "Error",
      stack: typeof error.stack === "string" ? error.stack : "",
    };
  }
  if (typeof error === "string") {
    return { message: error, stack: "" };
  }
  // ErrorEvent-like / object with a message, but not an Error instance.
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      const stack = (error as { stack?: unknown }).stack;
      return { message, stack: typeof stack === "string" ? stack : "" };
    }
  }
  // Anything else: a best-effort, never-throwing string.
  return { message: safeStringify(error), stack: "" };
}

/** `String(x)` that can't throw (a Symbol, or an object with a hostile
 *  `toString`), falling back to the value's type. */
function safeStringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return `<unstringifiable ${typeof value}>`;
  }
}

/** Keep only the top `n` non-empty lines of a stack — the frames nearest the
 *  throw — trimmed of surrounding whitespace. */
export function topFrames(stack: string, n: number = STACK_FRAMES): string {
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, n)
    .join("\n");
}

/** Truncate to at most `max` characters (never mid-surrogate-pair concerns here —
 *  the server clamps by `char` too, and these are ASCII-ish code paths). */
function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * A stable signature for de-duplication: the same bug throwing every frame
 * produces the same signature, so the throttle sends it once. Deliberately
 * coarse (kind + message + first frame) — a differing line/column shouldn't
 * defeat de-dup, but a genuinely different error should get through.
 */
export function crashSignature(kind: CrashKind, message: string, stack: string): string {
  const firstFrame =
    stack
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return `${kind}|${message}|${firstFrame}`;
}

/**
 * Browser-emitted signals that arrive on `window.onerror` but are not crashes —
 * nothing threw, nothing is broken, and the app carries on. Reporting them costs
 * a beacon, a log line, and (via the log alerter) a page for a non-event, so they
 * are dropped before the throttle ever sees them.
 *
 * Kept deliberately tiny and exact-prefix-matched: this list suppresses real
 * signal if it grows loose, so an entry earns its place only by being a *spec'd*
 * non-error the browser reports as one.
 *
 *  - **ResizeObserver loop** — fired when a resize callback changes the size of
 *    an element it observes, so the browser can't finish delivering in that
 *    frame. It settles on the next frame by design. Ours are engineered not to
 *    do this (see `lib/useBarWidth`), but any observer on the page can emit it —
 *    a component we add later, a library, an extension — and it is never
 *    actionable as a crash. Both spellings are the same condition: Chrome's
 *    legacy wording, then the current spec's.
 */
const NON_CRASH_MESSAGES = [
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
];

/** Whether `message` is a browser non-error we deliberately don't report. */
export function isNonCrashMessage(message: string): boolean {
  const trimmed = message.trim();
  // Some browsers prefix the message with "Uncaught " (or a script-error tag)
  // before it reaches `onerror`, so match on containment, not equality.
  return NON_CRASH_MESSAGES.some((known) => trimmed.includes(known));
}

/**
 * How each engine words a dynamic `import()` whose chunk failed to load.
 * Matched case-insensitively on containment: the message carries the chunk URL
 * and browsers vary the "Uncaught (in promise) TypeError:" framing. The last
 * entry is Vite's own preload-helper wording for a failed CSS dep.
 *
 * These messages are emitted for *any* failed fetch, not only a 404 — an
 * offline tab, a dropped mobile connection and a blocking extension produce
 * exactly the same words as deploy skew does. Matching one therefore only says
 * "a chunk didn't load"; [`chunkFailureKind`] is what decides whose fault it was.
 */
const STALE_CHUNK_MESSAGES = [
  "failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "importing a module script failed", // Safari
  "unable to preload css", // Vite preload helper
];

/**
 * Whether `message` is a failed lazy-chunk load. Not unconditionally dropped
 * like `isNonCrashMessage` — see [`resolveCrashKind`] for the policy.
 */
export function isStaleChunkMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return STALE_CHUNK_MESSAGES.some((known) => lower.includes(known));
}

/**
 * Final wire kind for a report, folding in the whole stale-chunk policy.
 * Returns `null` when the report should be dropped entirely.
 *
 *  - Not a stale-chunk message: the kind passes through untouched.
 *  - Stale chunk while the boot recovery's reload is in flight: dropped — a
 *    self-healing deploy-skew event is not a crash.
 *  - Stale chunk reported as handled (`stale-chunk`, from `ChunkErrorBoundary`
 *    catching a post-boot lazy-surface failure): kept as-is. The proxy logs it
 *    below paging level — the user got a refresh prompt and the app kept
 *    running, but a spike still flags an SW precache gap.
 *  - Any other stale chunk (the top-level `ErrorBoundary`, a raw
 *    window trap): rewritten to `stale-chunk-fatal` — nothing recovered and
 *    nothing handled it, so the app went down. That is only a *provisional*
 *    answer: it says the failure was fatal, not that our deploy caused it. The
 *    reporter re-requests the chunk and downgrades to `chunk-unreachable`
 *    unless the server confirms it is gone (see [`chunkFailureKind`]).
 */
export function resolveCrashKind(
  kind: CrashKind,
  message: string,
  reloadInProgress: boolean,
): CrashKind | null {
  if (!isStaleChunkMessage(message)) return kind;
  if (reloadInProgress) return null;
  return kind === "stale-chunk" ? kind : "stale-chunk-fatal";
}

/** What re-requesting the chunk that failed to load told us.
 *  `missing` = the server answered 4xx, so the chunk really is gone;
 *  `served` = it answered it fine, so that one fetch just lost;
 *  `unreachable` = the probe itself failed (offline, DNS, blocked, timed out);
 *  `unknown` = we couldn't ask (no URL in the message, cross-origin, 5xx). */
export type ChunkProbe = "missing" | "served" | "unreachable" | "unknown";

/**
 * Final kind for a chunk load that took the app down, given what the re-request
 * found. **Only `missing` pages.**
 *
 * The wording engines use for a failed `import()` describes the *symptom*, and
 * the symptom of deploy skew is identical to the symptom of a visitor's flaky
 * connection. Treating the two as one shipped in 1.0.0 and paged the maintainer
 * on 2026-07-28: four `stale-chunk-fatal` beacons naming `acquisition-*.js` and
 * `useBarWidth-*.css`, both of which were being served, from the very build the
 * live `index.html` pointed at — the shell and its chunks were the same, current
 * deploy, and the fetches had simply failed. (Boot recovery had already spent its
 * one reload on the first failure; the retry lost the same way, which the
 * escalation rule reads as "recovery exhausted on a broken deploy".)
 *
 * So the fatal shape now requires the server to *confirm* the chunk is gone.
 * Everything else reports as `chunk-unreachable`: still counted at the proxy
 * (the app did go down for that user, and a spike is worth seeing), never a
 * page, because nothing we deploy could have prevented it.
 *
 * Erring toward `chunk-unreachable` on `unknown` is deliberate. It covers the
 * cases where we have no evidence at all — Safari's "Importing a module script
 * failed." carries no URL, a cross-origin chunk isn't ours to probe — and a
 * genuinely broken deploy still pages through every other visitor whose engine
 * does name the URL, which is the large majority.
 */
export function chunkFailureKind(probe: ChunkProbe): CrashKind {
  return probe === "missing" ? "stale-chunk-fatal" : "chunk-unreachable";
}

/** An absolute `https?://…` in the message (Chromium/Firefox both append the
 *  chunk URL), else a root-relative asset path (Vite's CSS preload wording). */
const CHUNK_URL_PATTERNS = [
  /\bhttps?:\/\/[^\s"'<>]+/i,
  /(?:^|\s)(\/[^\s"'<>]*\.(?:js|mjs|css))(?=$|[\s)"'])/i,
];

/**
 * The same-origin URL of the chunk a load-failure message names, or `null` when
 * the message doesn't name one we may re-request.
 *
 * Same-origin is required, not incidental: the probe exists to ask *our* host
 * whether *our* asset is still there, and a cross-origin URL in an error message
 * is not something the crash reporter should be firing requests at. `null` lands
 * on `unknown`, which never pages — the safe direction.
 */
export function chunkProbeUrl(message: string, origin: string): string | null {
  for (const pattern of CHUNK_URL_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    const raw = match[1] ?? match[0];
    try {
      const url = new URL(raw, origin);
      if (url.origin !== origin) return null;
      return url.href;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The wire kind for a failure in *optional post-boot background work* — work the
 * app fires and forgets, whose failure costs the user nothing on screen (today:
 * the service-worker registration scheduled after first paint in `main.tsx`).
 *
 * Left alone, such a rejection reaches the `unhandledrejection` trap, and
 * [`resolveCrashKind`] escalates a stale chunk there to `stale-chunk-fatal` —
 * the one shape the proxy pages on, reserved for the app actually going down.
 * That is precisely what `virtual:pwa-register` did on 2026-07-27: a tab that
 * outlived a deploy 404'd the registration chunk while the editor ran perfectly,
 * and paged the maintainer over a tab that had merely missed its offline cache.
 *
 * So a stale chunk on this path reports as **handled** (`stale-chunk`, logged
 * below paging level — still counted, because a spike means many tabs are
 * outliving deploys), while anything else keeps the honest `unhandledrejection`
 * it would have had: an unexpected fault in our own code stays page-worthy
 * whether or not it happened in the background.
 */
export function backgroundFailureKind(message: string): CrashKind {
  return isStaleChunkMessage(message) ? "stale-chunk" : "unhandledrejection";
}

/**
 * The message for a `dom-desync` report — a crash `core/dom/domGuard` repaired
 * rather than a crash that happened.
 *
 * Both facts it carries answer the same question, and neither is user content:
 * the tag name of the element the stale reference node actually turned up under
 * (`FONT` is an in-page translator's fingerprint) and whichever translator left
 * markers on the document. A report saying `parent=FONT translator=google` is a
 * browser rewriting the page; one saying `parent=DIV translator=none` is a bug
 * of ours that the guard is quietly papering over, and wants investigating.
 */
export function domDesyncMessage(
  desync: { api: string; actualParent: string },
  translator: string,
): string {
  return `dom desync repaired: ${desync.api} reference under ${desync.actualParent} (translator=${translator})`;
}

/**
 * Whether a `window.onerror` report describes someone else's code, not ours.
 *
 * The global `error` trap hears every uncaught exception in the page context —
 * including code we never shipped: extension scripts injected into the page,
 * userscripts, bookmarklets, devtools-console experiments. One of those paged
 * the maintainer on 2026-07-24: a Safari user's foreign script blew its own
 * stack ("Maximum call stack size exceeded.", frames `@`/`Pk@`/`Nk@` with no
 * source URL — JSC's rendering of code that has no script URL), and no deployed
 * DWEEB bundle ever contained those symbols.
 *
 * Two shapes qualify, both only for the `error` kind (the one trap foreign
 * page-context code lands in without involving the app):
 *
 *  - **Unattributed stack**: frames exist but none carries a script URL (no
 *    `://` anywhere). Every engine prints absolute URLs for frames from real
 *    scripts, so a stack with none cannot be code we served.
 *  - **Muted cross-origin error**: the literal "Script error." shape with an
 *    empty stack — the browser withheld everything about a non-CORS
 *    cross-origin script's failure, leaving nothing to act on.
 *
 * Deliberately narrow, like [`isNonCrashMessage`]: `boundary` and
 * `unhandledrejection` reports keep flowing even with a foreign-looking stack
 * (the app actually went down / real work was dropped, and the 6-frame cut can
 * hide our deeper frames), an empty stack with an ordinary message keeps
 * flowing (our own code can `throw "string"`), and extension frames that do
 * carry a URL (`safari-web-extension://…`) keep flowing too. The proxy applies
 * the same rule server-side (`telemetry.rs`) — it is the authority, because
 * SW-cached clients without this filter keep beaconing for weeks.
 */
export function isForeignCodeError(kind: CrashKind, message: string, stack: string): boolean {
  if (kind !== "error") return false;
  if (stack.length > 0 && !stack.includes("://")) return true;
  return stack.length === 0 && message.trimStart().startsWith("Script error");
}

/** Build the content-free wire payload from an untrusted thrown value. */
export function buildCrashPayload(input: CrashInput): CrashPayload {
  const { message, stack } = describeError(input.error);
  return {
    kind: input.kind,
    message: clamp(message, MESSAGE_MAX),
    stack: clamp(topFrames(stack), STACK_MAX),
    version: input.version,
    build: input.build,
    surface: input.surface,
    path: input.path,
  };
}

/**
 * Per-session send gate. Pure and self-contained (no timers, no storage): the
 * reporter holds one instance for the page's lifetime and asks it before every
 * send. Two guards, both intentional:
 *
 *  - **Dedup:** one beacon per distinct signature, so a re-throwing render loop
 *    reports once, not once per frame.
 *  - **Hard cap:** at most `max` beacons total, so even a storm of *distinct*
 *    errors (each a new signature) can't flood the endpoint.
 */
export class CrashThrottle {
  private readonly seen = new Set<string>();
  private sent = 0;

  constructor(private readonly max: number = 5) {}

  /** Record the intent to send `signature`; returns whether it should go out.
   *  Idempotent per signature and monotonic in the total count. */
  shouldSend(signature: string): boolean {
    if (this.sent >= this.max) return false;
    if (this.seen.has(signature)) return false;
    this.seen.add(signature);
    this.sent += 1;
    return true;
  }
}
