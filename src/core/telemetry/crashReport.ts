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

/** Where the error surfaced. Beyond the three raw traps, `boot` is a failure
 *  the entry caught before the app could mount (`main.tsx`'s boot promise — the
 *  shell showed a notice instead of sitting on "Loading…" forever), and
 *  `dom-desync` reports a crash the app *prevented* (see `core/dom/domGuard`:
 *  something rewrote the DOM under Preact and the guard repaired the placement
 *  instead of letting it throw) — counted, never paged. Five chunk-load
 *  refinements (see [`resolveCrashKind`] and [`chunkFailureKind`]) tell the
 *  proxy how bad the rest was:
 *  `stale-chunk` = a lazy surface failed post-boot but was handled in place
 *  (the user got a refresh prompt, the app kept running — the proxy logs it
 *  below paging level); `chunk-unreachable` = the app went down on a chunk
 *  load, but re-requesting that chunk proved it is still being served (or the
 *  network couldn't be reached at all), so the fault is the visitor's
 *  connection, not our deploy — counted, never paged; `stale-shell` = the chunk
 *  is genuinely gone (the re-request 404'd) AND the shell people are being
 *  served right now is a *different* build from the one this tab booted — a
 *  client whose cache outlived the deploy and could not reload past it; the
 *  deploy itself is fine — counted, never paged; `shell-unverified` = the chunk
 *  is gone but the live shell could not be read (timed out, blocked, carried no
 *  entry script) — also never paged, but sent as its own kind so a regression in
 *  that probe shows up as a count instead of as silence; `stale-chunk-fatal` =
 *  the chunk is gone AND the live shell is *this* build, so the deploy visitors
 *  receive right now references a chunk it doesn't serve — that one pages. */
export type CrashKind =
  | "error"
  | "unhandledrejection"
  | "boundary"
  | "boot"
  | "dom-desync"
  | "stale-chunk"
  | "chunk-unreachable"
  | "stale-shell"
  | "shell-unverified"
  | "stale-chunk-fatal";

/** Every kind the client can send — pinned against [`KIND_MAX_LENGTH`] in
 *  `crashReport.test.ts`. */
export const CRASH_KINDS: readonly CrashKind[] = [
  "error",
  "unhandledrejection",
  "boundary",
  "boot",
  "dom-desync",
  "stale-chunk",
  "chunk-unreachable",
  "stale-shell",
  "shell-unverified",
  "stale-chunk-fatal",
];

/** The proxy clamps `kind` to this many characters (`KIND_MAX` in
 *  `telemetry.rs`) by silent truncation. A longer kind would land as a different
 *  string — and one that merely *started* with `stale-chunk-fatal` would be
 *  demoted to routine by the truncation alone, since the proxy pages on the
 *  exact string. Nothing enforces this at runtime; the test does. */
export const KIND_MAX_LENGTH = 20;

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
  /**
   * Set only on a `stale-chunk-fatal` report, and only because this client read
   * the live shell itself, at crash time, and found it to be this very build
   * (see `probeLiveShell`). It says "my fatality verdict is first-hand", and it
   * exists for the proxy's benefit rather than ours.
   *
   * The proxy keeps its own answer to the same question, because clients too old
   * to ask it cannot be fixed — they ship from a service-worker cache and keep
   * their reporter for as long as their tab stays open (`server/src/live_build.rs`).
   * But that answer is a cached read of an edge-cached shell, so it can be some
   * minutes behind, while this one is a live fetch made at the moment the app
   * died. Without this flag the staler opinion would silently overrule the
   * fresher one and a genuinely broken deploy could go unreported for the length
   * of that window. With it, the proxy speaks only for the clients that had no
   * opinion — so the override narrows to nothing as old bundles drain, which is
   * exactly the population it was added for.
   */
  shellVerified?: boolean;
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

/** Truncate to at most `max` UTF-16 units without ever splitting a surrogate
 *  pair. A cut between the two halves of an emoji leaves a lone surrogate,
 *  which `JSON.stringify` writes as a `\ud83d`-style escape that serde_json
 *  refuses to decode — so the proxy would reject the whole beacon and the crash
 *  would be lost, not merely shortened. */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
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
 *  - Any other stale chunk (the top-level `ErrorBoundary`, a raw window trap,
 *    a `boot` failure the entry caught with no recovery step left): rewritten
 *    to `stale-chunk-fatal` — nothing recovered and nothing handled it, so the
 *    app went down. That is only a *provisional* answer: it says the failure
 *    was fatal, not that our deploy caused it. The reporter re-requests the
 *    chunk and reads the live shell, and only their agreement keeps this shape
 *    (see [`chunkFailureKind`]).
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

/** What fetching the *live shell* (`/`) told us about the deploy visitors are
 *  receiving right now, compared with the shell this tab booted from — judged by
 *  the module entry script each references, which Vite hashes per build.
 *  `same` = the live shell is this very build; `different` = it is another
 *  build (the client cannot order builds, so not "newer"); `unknown` = it could
 *  not be fetched or carried no module entry. */
export type ShellProbe = "same" | "different" | "unknown";

/**
 * Final kind for a chunk load that took the app down, given what the two probes
 * found. **Only `missing` + `same` pages.**
 *
 * The wording engines use for a failed `import()` describes the *symptom*, and
 * the symptom of deploy skew is identical to the symptom of a visitor's flaky
 * connection. Treating the two as one shipped in 1.0.0 and paged the maintainer
 * on 2026-07-28: four `stale-chunk-fatal` beacons naming `acquisition-*.js` and
 * `useBarWidth-*.css`, both of which were being served, from the very build the
 * live `index.html` pointed at — the shell and its chunks were the same, current
 * deploy, and the fetches had simply failed. So the chunk probe: the fatal shape
 * requires the server to *confirm* the chunk is gone. Everything else reports as
 * `chunk-unreachable`: still counted at the proxy (the app did go down for that
 * user, and a spike is worth seeing), never a page, because nothing we deploy
 * could have prevented it.
 *
 * A gone chunk is still not proof of a broken deploy — it paged the maintainer
 * again on 2026-09-11: a tab booted a shell 22 days older than the live deploy
 * (build `e699a38eec` of 2026-08-20 against a live `25373c3a08` — the 42 hours
 * often quoted is the age of the *replacement*, not of the tab, and reading it
 * as the tab's age is what made this look like an edge case rather than the
 * norm it is), its chunks were long purged,
 * and the boot recovery's one reload could not get it a fresher shell. The
 * deploy everyone else was receiving was fine. The old rule read "recovery
 * exhausted + chunk gone" as "broken deploy", but that shape is also exactly what
 * a *stale client* produces. Hence the shell probe: the live `/` is fetched and
 * its module entry compared with ours. `different` means the tab is the stale
 * party (`stale-shell`, counted, never paged); only `same` — the shell people are
 * served right now names a chunk it doesn't serve — is a broken deploy.
 *
 * Erring away from paging on either `unknown` is deliberate, and the same
 * argument twice over. `chunk-unreachable` covers the cases where we have no
 * evidence at all — Safari's "Importing a module script failed." carries no
 * URL, a cross-origin chunk isn't ours to probe. `shell-unverified` covers a
 * shell fetch that timed out on a slow link, was blocked, or carried no entry
 * script: a genuinely broken deploy still pages through every other visitor
 * whose probes complete, which is the large majority, and the one cause that
 * would be *ours* — the parser no longer matching the shell Vite emits — is
 * caught by the post-build audit gate (`scripts/seo/audit.ts`), not left to the
 * paging channel. It is a distinct kind rather than folded into `stale-shell`
 * so that a probe regression is visible as a count in the log, not as silence.
 */
export function chunkFailureKind(probe: ChunkProbe, shell: ShellProbe): CrashKind {
  if (probe !== "missing") return "chunk-unreachable";
  switch (shell) {
    case "same":
      return "stale-chunk-fatal";
    case "different":
      return "stale-shell";
    default:
      return "shell-unverified";
  }
}

/** One `<script …>` start tag, with its attribute soup captured. */
const SCRIPT_START_TAG = /<script\b([^>]*)>/gi;
/** `type="module"` (any quoting) inside a tag's attributes. The lookahead keeps
 *  `type=modules` or `type="module-x"` from matching. */
const MODULE_TYPE = /\btype\s*=\s*(?:"module"|'module'|module(?=[\s/>]|$))/i;
/** The `src` attribute's value, in any quoting. */
const SRC_ATTRIBUTE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * The `src` of the first `<script type="module">` in an HTML document — the
 * shell's module entry, which Vite hashes per build — or `null` when there is
 * none.
 *
 * A pure string scan on purpose: it runs in the crash reporter against a
 * fetched shell, in Vitest (Node, no DOM), and in the post-build audit under
 * Bun, so `DOMParser` is available in exactly none of the places that need to
 * test it. Attribute order is not assumed — the shell Vite emits is
 * `<script type="module" crossorigin src="…">`, `crossorigin` between the two
 * attributes the scan cares about — and inline module scripts (no `src`) and
 * the shell's classic/JSON-LD scripts are skipped.
 */
export function moduleEntryFromHtml(html: string): string | null {
  for (const tag of html.matchAll(SCRIPT_START_TAG)) {
    const attributes = tag[1] ?? "";
    if (!MODULE_TYPE.test(attributes)) continue;
    const src = SRC_ATTRIBUTE.exec(attributes);
    if (!src) continue;
    const value = (src[1] ?? src[2] ?? src[3] ?? "").trim();
    if (value) return value.replace(/&amp;/g, "&");
  }
  return null;
}

/** The `<meta name="dweeb-build">` stamped into the shell by `stampBuildMeta`
 *  (vite.config.ts). Attribute order is not assumed, and `name` is matched
 *  exactly so a longer name can't be taken for this one. */
const BUILD_META_TAG = /<meta\b([^>]*)>/gi;
// `(?:^|[\s/])` rather than `\b`: JS word boundaries match after a hyphen, so
// `\bname=` also matches `data-name=` — which would read an attribute that is
// not the marker. The Rust twin requires the same preceding character, and this
// pair has to agree, since the audit gate below runs only the TypeScript one.
const BUILD_META_NAME =
  /(?:^|[\s/])name\s*=\s*(?:"dweeb-build"|'dweeb-build'|dweeb-build(?=[\s/>]|$))/i;
const BUILD_META_CONTENT = /(?:^|[\s/])content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
/** Everything `vite.config.ts`'s `buildId()` can produce — a short sha, with an
 *  optional `-dirty`, or a `t<base36>` timestamp — and nothing a hostile origin
 *  could use to forge a log line on the proxy. Kept in step with
 *  `is_plausible_build` in `server/src/live_build.rs`. */
const BUILD_META_VALUE = /^[A-Za-z0-9\-_.]{1,32}$/;

/**
 * The build id an HTML shell declares — the `__BUILD_ID__` of the bundle it
 * belongs to — or `null` when it carries none.
 *
 * Nothing in the browser reads this: the *proxy* does, off the live shell, as
 * the authority for "is the client reporting this crash running the build we
 * are serving right now?" (`server/src/live_build.rs`, which mirrors this
 * scan). It lives here beside [`moduleEntryFromHtml`] because it is the same
 * kind of thing — a pure string scan over a shell, part of the paging decision,
 * and testable in Vitest and in the post-build audit, neither of which has a
 * DOM. The audit runs it over the real `dist/index.html` so markup drift fails
 * the build rather than silently un-gating the paging channel.
 */
export function buildMetaFromHtml(html: string): string | null {
  for (const tag of html.matchAll(BUILD_META_TAG)) {
    const attributes = tag[1] ?? "";
    if (!BUILD_META_NAME.test(attributes)) continue;
    const content = BUILD_META_CONTENT.exec(attributes);
    if (!content) continue;
    const value = (content[1] ?? content[2] ?? content[3] ?? "").trim();
    if (BUILD_META_VALUE.test(value)) return value;
  }
  return null;
}

/**
 * Compare the module entry this tab booted from with the one the live shell
 * names. Pathnames only: ours is absolute (`import.meta.url` of the entry
 * chunk), the shell's is root-relative, and the origin is the same by
 * construction. `unknown` when either side is missing or unparseable — which
 * [`chunkFailureKind`] never pages on.
 */
export function shellProbeVerdict(
  ownEntry: string | null,
  liveEntry: string | null,
  base: string,
): ShellProbe {
  if (!ownEntry || !liveEntry) return "unknown";
  try {
    const own = new URL(ownEntry, base).pathname;
    const live = new URL(liveEntry, base).pathname;
    return own === live ? "same" : "different";
  } catch {
    return "unknown";
  }
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
 * URL schemes a browser gives only to code from an extension package — never
 * to anything a web origin serves, so a frame carrying one cannot be ours.
 * Each is evidenced (2026-09-14 research): `chrome-extension` is every
 * Chromium browser, Edge included (verified first-hand in Chrome 152 and Edge
 * 153); `moz-extension` is Firefox, for extension scripts a page loads by URL;
 * `safari-web-extension` and `safari-extension` are Safari's web and legacy
 * extensions; `webkit-masked-url` is Safari 16+, which prints every extension
 * script's URL as `webkit-masked-url://hidden/` and never masks an http(s) or
 * blob one.
 *
 * Mirrored as `EXTENSION_SCHEMES` in `telemetry.rs`; both are pinned by
 * `server/src/foreign-code-vectors.json`. Add a scheme only on evidence that it
 * reaches a page's stacks on an engine DWEEB can boot on — and never http(s):
 * [`wireStack`] promotes an http(s) frame precisely because no change to this
 * list can ever count one as foreign.
 */
export const EXTENSION_SCHEMES: readonly string[] = [
  "chrome-extension",
  "moz-extension",
  "safari-extension",
  "safari-web-extension",
  "webkit-masked-url",
];

/**
 * Firefox (128+) names no page-world extension script by URL: it compiles every
 * one as `<anonymous code>`, deliberately, so pages cannot read them
 * (`ExtensionContent.sys.mjs`), and it uses that name for nothing else. So the
 * token counts as an extension location — without it, Firefox's rendering of
 * the very MetaMask rejection below (`connect@<anonymous code>:7:84292`) would
 * name no location at all and keep paging. Not to be confused with V8's
 * `<anonymous>`, which is any code that has no URL.
 */
export const GECKO_MAIN_WORLD = "<anonymous code>";

/** Whose code a stack names — see [`frameOrigin`]. Also logged by the proxy
 *  (`frames=`) on the two crash lines that turn on it: the foreign-code line it
 *  demotes and the `web app crash` line it pages. */
export type FrameOrigin = "none" | "page" | "extension" | "mixed";

/** Every control character (Unicode Cc — exactly what Rust's `char::is_control`
 *  means). */
const CONTROL_CHARACTER = /\p{Cc}/gu;

/**
 * `text` as the proxy reads it: `clamp_field` (`telemetry.rs`) turns every
 * control character into a space before anything is judged. The client judges
 * that same text, so the two cannot disagree over layout — a `\n` inside the
 * Gecko token, or before "Script error", reads as the space the proxy will see.
 * (No scheme run or `://` can contain either, so it changes no URL location.)
 */
function asProxyReads(text: string): string {
  return text.replace(CONTROL_CHARACTER, " ");
}

/** `[A-Za-z0-9+.-]`: the characters a URL scheme is made of (RFC 3986). */
function isSchemeChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2e
  );
}

/** One `://` in a text: the whole scheme run before it, lowercased (possibly
 *  empty), where that run starts, and where the `://` itself starts. */
interface UrlLocation {
  scheme: string;
  start: number;
  at: number;
}

/** Every `://` in `text`, left to right, each with the whole scheme run before
 *  it. A hand scan, not a regex, so it yields exactly the runs `telemetry.rs`'s
 *  byte scan does — the empty run included, which a letter-anchored regex would
 *  skip. Scheme characters are ASCII, so UTF-16 and UTF-8 agree. */
function locations(text: string): UrlLocation[] {
  const found: UrlLocation[] = [];
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", at + 3)) {
    let start = at;
    while (start > 0 && isSchemeChar(text.charCodeAt(start - 1))) start--;
    found.push({ scheme: text.slice(start, at).toLowerCase(), start, at });
  }
  return found;
}

function isExtensionScheme(scheme: string): boolean {
  return EXTENSION_SCHEMES.includes(scheme);
}

function isWebScheme(scheme: string): boolean {
  return scheme === "http" || scheme === "https";
}

/**
 * Whose code a stack names, judged from every location in it.
 *
 * A location is each `://`, read with the **whole** run of scheme characters
 * before it and compared whole, ASCII-case-insensitively, against
 * [`EXTENSION_SCHEMES`] — so a malformed run (`1chrome-extension`, or none at
 * all) counts as ours, the paging side — plus each [`GECKO_MAIN_WORLD`] token.
 * Frames that name no location (`<anonymous>`, `[native code]`,
 * `async Promise.all (index 0)`, a bare `fn@`) are ignored, and so is layout:
 * the text is judged as the proxy reads it ([`asProxyReads`]), so a stack
 * reaches the same answer whether its lines are joined by newlines or spaces.
 *
 * `none` = no location at all; `page` = locations, none an extension's;
 * `extension` = locations, every one an extension's; `mixed` = both.
 */
export function frameOrigin(stack: string): FrameOrigin {
  const text = asProxyReads(stack);
  let extension = text.includes(GECKO_MAIN_WORLD);
  let page = false;
  for (const { scheme } of locations(text)) {
    if (isExtensionScheme(scheme)) extension = true;
    else page = true;
  }
  if (extension) return page ? "mixed" : "extension";
  return page ? "page" : "none";
}

/** The kinds [`isForeignCodeError`] may ever claim: the two window traps. */
export function canBeForeign(kind: CrashKind): boolean {
  return kind === "error" || kind === "unhandledrejection";
}

/**
 * Whether a report describes someone else's code, not ours.
 *
 * The two window traps hear everything thrown or dropped in the page's own JS
 * world — including code we never shipped: extension scripts that run in the
 * page's world (a wallet has to, to define `window.ethereum`), userscripts,
 * bookmarklets, devtools-console experiments. (An extension's isolated-world
 * scripts never reach them.) Two of those paged the maintainer:
 *
 *  - 2026-07-24: a Safari user's foreign script blew its own stack ("Maximum
 *    call stack size exceeded.", frames `@`/`Pk@`/`Nk@` with no source URL —
 *    JSC's rendering of code that has no script URL); no deployed DWEEB bundle
 *    ever contained those symbols.
 *  - 2026-09-14: MetaMask's page-world `inpage.js` left its own connection
 *    promise unhandled — `i: Failed to connect to MetaMask`, one frame, at
 *    `chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js`.
 *    DWEEB never touches `window.ethereum`.
 *
 * Three shapes qualify:
 *
 *  - **Extension-only** (`error` and `unhandledrejection`): the stack names at
 *    least one location and every one is an extension's ([`frameOrigin`] =
 *    `extension`). Every one, not just the top frame: an extension wrapping an
 *    API we call sits *above* our own frame, and that misuse of ours pages.
 *  - **Unattributed** (`error` only): frames exist but none names a location.
 *  - **Muted cross-origin error** (`error` only): the literal "Script error."
 *    with an empty stack — the browser withheld everything about it.
 *
 * Deliberately narrow, like [`isNonCrashMessage`]: `boundary` and `boot` mean
 * the app went down and keep flowing whatever their stack (an extension-only
 * stack there is a real outage); a rejection that names no location keeps
 * flowing (our own failed `fetch` rejects with a header-only `TypeError`); an
 * empty stack with an ordinary message keeps flowing (our code can
 * `throw "string"`).
 *
 * The reporter passes the error's **full** stack — V8 keeps up to ten frames,
 * the wire only six lines, the first of them V8's `Name: message` header — and
 * [`wireStack`] builds the wire so any location this counted as ours reaches
 * it. The proxy applies the same rule to the wire (`telemetry.rs`), where it is
 * the authority, because SW-cached clients keep beaconing for weeks; with the
 * wire built that way, and both the stack and the message judged as the proxy
 * reads them ([`asProxyReads`]), it can never demote what this judged ours.
 * Both sides are pinned to `server/src/foreign-code-vectors.json`.
 */
export function isForeignCodeError(kind: CrashKind, message: string, stack: string): boolean {
  if (!canBeForeign(kind)) return false;
  const origin = frameOrigin(stack);
  if (origin === "extension") return true;
  if (kind !== "error") return false;
  if (stack.length > 0 && origin === "none") return true;
  return stack.length === 0 && asProxyReads(message).trimStart().startsWith("Script error");
}

/** The longest line [`wireStack`] promotes whole; a longer one is kept from its
 *  URL on. Well under [`STACK_MAX`], so a head always fits beside it. */
const PROMOTED_LINE_MAX = 240;
/** Room kept for the gap marker ("... 99999 lines skipped ..." is 27 units). */
const MARKER_RESERVE = 32;

/**
 * Keep `line` whole if it is short enough, else from its first location that
 * `pick` accepts — the part [`wireStack`] promoted it for — onwards. A scheme
 * run too long to keep whole goes, rather than being trimmed: the bare `://`
 * left behind still reads as ours (an empty run) on both sides, whereas cutting
 * the run's front could leave an extension's scheme standing.
 */
function fitPromoted(line: string, pick: (scheme: string) => boolean): string {
  if (line.length <= PROMOTED_LINE_MAX) return line;
  const location = locations(line).find(({ scheme }) => pick(scheme));
  if (location === undefined) return clamp(line, PROMOTED_LINE_MAX);
  const keepsRun = location.at + 3 - location.start <= PROMOTED_LINE_MAX;
  return clamp(line.slice(keepsRun ? location.start : location.at), PROMOTED_LINE_MAX);
}

/**
 * The stack as sent: its top [`STACK_FRAMES`] lines within [`STACK_MAX`] units —
 * plus, when that window names no http(s) location but the full stack does, the
 * line that does promoted into the window as its last. (With no http(s)
 * location anywhere, the same goes for any location that is not an
 * extension's.)
 *
 * This carries *evidence*, never a verdict. The proxy classifies the wire alone
 * (it is the authority for every client, current or SW-cached), so a location
 * the reporter counted as ours on the full stack must reach it — or the proxy
 * would demote a crash the client judged to be ours. Without any extension
 * involved that used to happen outright: V8 spends line 1 on its
 * `Name: message` header, a multi-line or very long message (zod's
 * pretty-printed errors, a `DataCloneError` quoting source code) filled the
 * window with text, and the unattributed rule silenced our own crash on
 * Chromium. An extension's frame above ours would do the same now, whenever the
 * rest of the window — the header, V8's URL-less builtin frames — names nothing.
 *
 * An http(s) location is promoted in preference to any other, since no change
 * to [`EXTENSION_SCHEMES`] can ever reclassify one. The search starts below
 * line 1 — in V8 the `Name: message` header — so a frame is promoted rather than
 * the tail of a message; line 1 is the source only when no later line names
 * such a location. (A later line of a multi-line message still reads as a
 * frame; the verdict is the same either way.) The promoted line is budgeted
 * first and the head trimmed to fit it, so no clamp can cut its location; lines
 * left out are replaced by a `... N lines skipped ...` marker, which names no
 * location. Line 1 always leads, cut to fit if it must be — even ahead of its
 * own promoted tail — so [`crashSignature`] still keys on it. Whenever the
 * window already names an http(s) location — the normal crash of ours — the
 * result is the plain window, exactly as it was before promotion existed.
 */
export function wireStack(stack: string): string {
  const lines = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const plain = clamp(lines.slice(0, STACK_FRAMES).join("\n"), STACK_MAX);
  const hasWeb = (text: string) => locations(text).some(({ scheme }) => isWebScheme(scheme));
  const hasPage = (text: string) =>
    locations(text).some(({ scheme }) => !isExtensionScheme(scheme));
  // The first line below line 1 that `has` accepts, else line 1 itself if it
  // does, else -1.
  const sourceLine = (has: (text: string) => boolean) => {
    const later = lines.findIndex((line, i) => i > 0 && has(line));
    return later === -1 && has(lines[0] ?? "") ? 0 : later;
  };
  if (hasWeb(plain)) return plain;
  let pick = isWebScheme;
  let at = sourceLine(hasWeb);
  if (at === -1) {
    if (hasPage(plain)) return plain;
    pick = (scheme: string) => !isExtensionScheme(scheme);
    at = sourceLine(hasPage);
  }
  const target = lines[at]; // `at` is -1, and this undefined, when nothing matched
  if (target === undefined) return plain;
  const promoted = fitPromoted(target, pick);
  // Newlines before the marker and the promoted line, plus the marker itself.
  const budget = STACK_MAX - promoted.length - 2 - MARKER_RESERVE;
  // Line 1 always leads, even ahead of its own promoted tail. Otherwise up to
  // five head lines when the promoted one is line 6 (no marker needed if they
  // all fit), else four, so the marker and it still make six.
  const maxHead = at === 0 ? 1 : at <= STACK_FRAMES - 1 ? at : STACK_FRAMES - 2;
  const head: string[] = [];
  let used = 0;
  for (const [i, line] of lines.slice(0, maxHead).entries()) {
    const cost = (head.length > 0 ? 1 : 0) + line.length;
    if (used + cost <= budget) {
      head.push(line);
      used += cost;
      continue;
    }
    if (i === 0) head.push(clamp(line, budget));
    break;
  }
  const skipped = at - head.length; // negative when line 1 is its own source
  if (skipped > 0) head.push(`... ${skipped} line${skipped === 1 ? "" : "s"} skipped ...`);
  head.push(promoted);
  return head.join("\n");
}

/** Build the content-free wire payload from an untrusted thrown value. */
export function buildCrashPayload(input: CrashInput): CrashPayload {
  const { message, stack } = describeError(input.error);
  return {
    kind: input.kind,
    message: clamp(message, MESSAGE_MAX),
    stack: wireStack(stack),
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
