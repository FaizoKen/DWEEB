/**
 * Deploy-skew recovery — get a tab whose boot chunks are gone onto a shell whose
 * chunks exist, and never loop doing it.
 *
 * GitHub Pages serves `index.html` with ~10-minute HTTP caching and purges old
 * hashed chunks on every deploy, and the service worker precaches the shell it
 * installed with. So a tab can boot a *stale* shell — from the browser's HTTP
 * cache, from a history/session-restore navigation, or from a worker whose
 * precache no longer serves its own chunks — whose `import()`s 404. The browser
 * surfaces that as `TypeError: Failed to fetch dynamically imported module`, and
 * without recovery the page is dead on its "Loading…" shell.
 *
 * The recovery is a **ladder** of at most two automatic navigations per build,
 * per tab, decided by the pure [`planStaleChunkRecovery`] and run from the boot
 * promise's `.catch` in `main.tsx` (so it only ever sees the error class it is
 * for, and only before the app has mounted):
 *
 *  1. **Reload.** Cheap and standard: revalidates the document for an
 *     uncontrolled tab, and preserves a healthy precache. It cannot escape a
 *     shell a service worker is serving from its precache — the worker answers
 *     a reload, and any `/?…` navigation, with the same cached shell — which is
 *     exactly the 2026-09-11 page: a tab on a 42-hour-old build, chunks purged,
 *     whose one reload came back on the same stale shell and reported it as
 *     `stale-chunk-fatal`.
 *  2. **Bypass.** Unregister every service worker for this origin (web surface
 *     only — the Activity never registers one), then navigate to the same URL
 *     with a [`REFRESH_PARAM`] nonce. Unregistering makes the navigation
 *     uncontrolled, so it reaches the network; the nonce defeats the browser's
 *     HTTP cache. (It does *not* bust the Pages CDN, which ignores the query —
 *     freshness there rests on the deploy purge, which is fine for any shell
 *     older than that ~10-minute window.) The nonce is stripped from the URL
 *     again at the very start of the next boot ([`installStaleChunkRecovery`]).
 *  3. Nothing. `main.tsx` turns the boot shell into a notice with a button, and
 *     reports the failure, whose kind the reporter settles by probing.
 *
 * Guards, each of which a one-line slip would break, so each is pinned by a test:
 *
 *  - **Storage-gated.** A step runs only after its attempt is recorded in
 *    `sessionStorage` (per tab, survives the navigation) *and read back*; if
 *    storage is unavailable there is no automatic step — without the record a
 *    persistent failure would navigate forever, and a loop is strictly worse
 *    than a notice.
 *  - **Nonce-gated.** A boot whose URL already carried the refresh nonce never
 *    bypasses again, whatever storage says.
 *  - **Capped per tab.** At most [`MAX_AUTOMATIC_NAVIGATIONS`] automatic
 *    navigations per [`NAVIGATION_WINDOW_MS`], independent of the build key —
 *    two builds both failing at boot (a broken deploy landing behind a CDN that
 *    still hands out the previous shell) would otherwise earn a fresh ladder on
 *    every alternation.
 *  - **Boot only.** Once the app surface has committed (`dweeb:surface-ready`)
 *    an automatic navigation could throw away the user's in-progress message.
 *    The boot promise cannot reject after that, but the policy checks anyway.
 *  - **Not into the void.** The bypass never runs offline, and a reload runs
 *    offline only under a controlling worker (which may serve it): an
 *    uncontrolled navigation with no network lands on the browser's error
 *    page, a strictly worse place than the notice.
 *  - **Watched.** A navigation that never commits (blocked, refused, thrown,
 *    or cancelled by the user leaving and coming back through the back/forward
 *    cache) would otherwise leave the tab frozen *and* mute the reporter, which
 *    drops chunk beacons while a recovery is in flight. A watchdog, cancelled
 *    by `pagehide` and re-triggered by a persisted `pageshow`, hands the failure
 *    back to the caller instead.
 *
 * Post-boot chunks are covered by the SW precache and, where a tab is
 * uncontrolled anyway, by `ui/ChunkErrorBoundary`, which turns a failed lazy
 * surface into a "refresh to update" prompt instead of a top-boundary crash.
 */

import { isActivityMode } from "@/core/activity/runtime";
import { describeError, isStaleChunkMessage } from "@/core/telemetry/crashReport";

/** The automatic step already spent on a build, in ladder order. */
export type RecoveryStep = "reload" | "bypass";

/** What one tab remembers across its recovery navigations. */
export interface RecoveryRecord {
  /** The shell the last automatic step was taken for — see [`buildKey`]. */
  build: string;
  /** The furthest rung climbed for that shell. */
  step: RecoveryStep;
  /** When each automatic navigation happened (epoch ms), newest last. Bounded
   *  to the recent past by [`recentNavigations`]. */
  navigations: number[];
}

/** Everything the decision depends on, gathered by the glue below. Pure so the
 *  policy is unit-testable without a DOM. */
export interface RecoveryPlanInput {
  /** Has the app surface committed? (`dweeb:surface-ready` fired) */
  bootFinished: boolean;
  /** Is the failure a chunk-load failure at all? Only that class has a shell to
   *  reload past; a genuine bug in the entry boots identically every time. */
  staleChunk: boolean;
  /** Identifies the shell currently running — see [`buildKey`]. */
  buildKey: string;
  /** The recorded attempt, if any — `null` when storage is empty or unreadable. */
  record: RecoveryRecord | null;
  /** Did this boot's URL carry the refresh nonce (a bypass already landed here)? */
  arrivedViaRefresh: boolean;
  /** `navigator.onLine !== false` — an uncontrolled navigation offline lands on
   *  the browser's error page, a strictly worse place than the notice. */
  online: boolean;
  /** Is a service worker controlling this document? The one case in which a
   *  reload can succeed offline — the worker may serve it from its precache. */
  controlled: boolean;
  /** `Date.now()`, injected so the cap can be tested. */
  now: number;
}

/** The next automatic step, or `none` when it is the caller's turn. */
export type RecoveryPlan = RecoveryStep | "none";

/** Absolute per-tab ceiling on automatic navigations in a rolling window. Two
 *  full ladders (reload + bypass, twice) is the most any legitimate sequence of
 *  deploys can need in ten minutes; anything beyond it is a loop. */
export const MAX_AUTOMATIC_NAVIGATIONS = 4;
export const NAVIGATION_WINDOW_MS = 10 * 60 * 1000;

/** Navigations from `record` that still count against the cap at `now`. */
export function recentNavigations(record: RecoveryRecord | null, now: number): number[] {
  return (record?.navigations ?? []).filter(
    (at) => now - at >= 0 && now - at < NAVIGATION_WINDOW_MS,
  );
}

/** Which rung, if any, a failed boot should climb next. */
export function planStaleChunkRecovery(input: RecoveryPlanInput): RecoveryPlan {
  // Past boot a navigation could destroy unsaved editor state — never automatic.
  if (input.bootFinished) return "none";
  // Only a chunk that failed to load has a fresher shell to reload onto.
  if (!input.staleChunk) return "none";
  if (recentNavigations(input.record, input.now).length >= MAX_AUTOMATIC_NAVIGATIONS) return "none";
  const spent = input.record?.build === input.buildKey ? input.record.step : null;
  if (spent === null) {
    // Offline, only a controlling worker can answer a reload; an uncontrolled
    // one lands on the browser's error page, where the notice is the better place.
    return input.online || input.controlled ? "reload" : "none";
  }
  if (spent === "reload") {
    // A bypass already brought us here, or the network isn't there to bypass to.
    if (input.arrivedViaRefresh || !input.online) return "none";
    return "bypass";
  }
  return "none";
}

/** Query parameter the bypass step appends so the shell is fetched afresh.
 *  Stripped again at the next boot; never written into any page, so it cannot
 *  reach the crawlable HTML the SEO audit inspects. */
export const REFRESH_PARAM = "dweeb-refresh";

/** The key of one `a=b` query part (or the whole part when it has no `=`). */
function queryKey(part: string): string {
  const eq = part.indexOf("=");
  return eq === -1 ? part : part.slice(0, eq);
}

/** Whether a `location.search` string carries the refresh nonce. */
export function hasRefreshParam(search: string): boolean {
  const query = search.startsWith("?") ? search.slice(1) : search;
  return query.split("&").some((part) => queryKey(part) === REFRESH_PARAM);
}

/**
 * The same location with the refresh nonce appended. Verbatim string surgery on
 * `search` and `hash` — never a `URL`/`searchParams` round trip, which would
 * re-encode the Activity's launch query (`frame_id`, `instance_id`, …), the
 * legacy `template=`/`entry=` hand-offs and the `#hash` share payload.
 */
export function withRefreshParam(
  location: { pathname: string; search: string; hash: string },
  nonce: string,
): string {
  const param = `${REFRESH_PARAM}=${nonce}`;
  const search = location.search ? `${location.search}&${param}` : `?${param}`;
  return `${location.pathname}${search}${location.hash}`;
}

/** `search` with only the refresh nonce's part removed — every other part,
 *  empty ones included, stays byte-for-byte; untouched when it isn't there. */
export function stripRefreshParam(search: string): string {
  if (!hasRefreshParam(search)) return search;
  const query = search.startsWith("?") ? search.slice(1) : search;
  const kept = query.split("&").filter((part) => queryKey(part) !== REFRESH_PARAM);
  return kept.length > 0 ? `?${kept.join("&")}` : "";
}

/** sessionStorage (per-tab, survives navigation) key holding the [`RecoveryRecord`]. */
const STORAGE_KEY = "dweeb.stale-chunk-reload";

/** Parse a stored record. A pre-ladder client stored the bare build key, which
 *  meant "reload spent"; anything unparseable reads as no record, the bounded
 *  direction — the claim is what actually gates a navigation. */
export function parseRecoveryRecord(raw: string | null): RecoveryRecord | null {
  if (raw === null || raw === "") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object") {
      const { build, step, navigations } = value as Partial<RecoveryRecord>;
      if (typeof build === "string" && (step === "reload" || step === "bypass")) {
        return {
          build,
          step,
          navigations: Array.isArray(navigations)
            ? navigations.filter(
                (at): at is number => typeof at === "number" && Number.isFinite(at),
              )
            : [],
        };
      }
    }
    return null;
  } catch {
    return { build: raw, step: "reload", navigations: [] };
  }
}

let installed = false;
let bootFinished = false;
let reloadInitiated = false;
let arrivedViaRefresh = false;
let watchdog: ReturnType<typeof setTimeout> | null = null;
let onRestored: ((event: PageTransitionEvent) => void) | null = null;

/** True from the moment a recovery navigation has been requested until it tears
 *  the page down (or the watchdog gives up on it). The crash reporter uses this
 *  to drop the stale-chunk beacons that are already being recovered from, and
 *  the chunk boundaries to hold their prompts. */
export function isStaleChunkReloadInProgress(): boolean {
  return reloadInitiated;
}

/**
 * Identity of the shell that is running, for the one-ladder-per-build guard.
 *
 * `__BUILD_ID__` (vite.config.ts) changes on exactly the event that should grant
 * a tab a fresh recovery attempt: a new deploy. `__APP_VERSION__` used to serve
 * here and doesn't work — it reads from package.json, which sat at `1.0.0`
 * across every deploy for months, so "once per version, per tab" degraded to
 * "once per tab, ever": a long-lived tab that recovered from one deploy's skew
 * could never recover from the next, and reported it as page-worthy
 * `stale-chunk-fatal` instead.
 *
 * Falls back to this module's own chunk URL, which Vite also hashes per build.
 * Any per-build-unique string works; a *constant* would still keep the loop
 * guard sound, it would just share one ladder across every build.
 */
function buildKey(): string {
  try {
    if (typeof __BUILD_ID__ === "string" && __BUILD_ID__) return __BUILD_ID__;
  } catch {
    /* fall through */
  }
  try {
    return typeof import.meta.url === "string" && import.meta.url ? import.meta.url : "unknown";
  } catch {
    return "unknown";
  }
}

function readRecord(): RecoveryRecord | null {
  try {
    return parseRecoveryRecord(sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Record the attempt before navigating; a read-back verifies the write stuck.
 *  Returns false when storage is unavailable — then we must NOT navigate,
 *  because without the record a persistent failure would navigate forever. */
function claimRecovery(record: RecoveryRecord): boolean {
  try {
    const value = JSON.stringify(record);
    sessionStorage.setItem(STORAGE_KEY, value);
    return sessionStorage.getItem(STORAGE_KEY) === value;
  } catch {
    return false;
  }
}

/** How long a requested navigation gets to tear the page down before it is
 *  declared stuck. It only has to beat a navigation that is hung or refused,
 *  not a slow one: `pagehide` (the cancel signal) fires only when the new
 *  document commits, which on a poor link can take well over ten seconds, and
 *  declaring a working navigation stuck would flash the notice over it. */
const NAVIGATION_WATCHDOG_MS = 20_000;

/** Wait at most this long for the worker unregistrations; the navigation goes
 *  ahead regardless, since a hung registration API must not hold the tab. */
const UNREGISTER_TIMEOUT_MS = 3_000;

function armWatchdog(onStuck: () => void): void {
  disarmWatchdog();
  const stuck = () => {
    disarmWatchdog();
    reloadInitiated = false;
    onStuck();
  };
  watchdog = setTimeout(stuck, NAVIGATION_WATCHDOG_MS);
  // `pagehide` fires when the new document commits — the proof the navigation
  // happened — but also when the *user* navigates away first, which cancels
  // ours. If the browser then restores this page from its back/forward cache,
  // it comes back mid-"Updating…" with nothing pending: treat that as stuck.
  window.addEventListener(
    "pagehide",
    () => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = null;
    },
    { once: true },
  );
  onRestored = (event) => {
    if (event.persisted) stuck();
  };
  window.addEventListener("pageshow", onRestored);
}

function disarmWatchdog(): void {
  if (watchdog !== null) clearTimeout(watchdog);
  watchdog = null;
  if (onRestored !== null) window.removeEventListener("pageshow", onRestored);
  onRestored = null;
}

/** Run one navigation call; a synchronous throw is an immediate "stuck". */
function navigate(go: () => void, onStuck: () => void): void {
  try {
    go();
  } catch {
    disarmWatchdog();
    reloadInitiated = false;
    onStuck();
  }
}

function nonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Whether a service worker controls this document. Reading the container can
 *  throw in a sandboxed frame; that reads as "not controlled". */
function hasControllingWorker(): boolean {
  try {
    return typeof navigator !== "undefined" && navigator.serviceWorker?.controller != null;
  } catch {
    return false;
  }
}

/** Unregister every service worker for this origin so the next navigation is
 *  uncontrolled. Every failure — no API, a sandboxed frame throwing, a hang —
 *  means "proceed to navigate anyway". Other open tabs keep their worker until
 *  they navigate; the app re-registers one after its next successful boot. */
async function dropServiceWorkers(): Promise<void> {
  try {
    const container = navigator.serviceWorker;
    if (!container || typeof container.getRegistrations !== "function") return;
    const unregisterAll = container
      .getRegistrations()
      .then((registrations) =>
        Promise.all(
          registrations.map((registration) => registration.unregister().catch(() => false)),
        ),
      )
      .then(() => undefined);
    const deadline = new Promise<void>((resolve) => {
      setTimeout(resolve, UNREGISTER_TIMEOUT_MS);
    });
    await Promise.race([unregisterAll, deadline]);
  } catch {
    /* nothing to drop, or not allowed to ask — the navigation still helps */
  }
}

async function bypassStaleShell(onStuck: () => void): Promise<void> {
  if (!isActivityMode()) await dropServiceWorkers();
  navigate(() => {
    window.location.replace(withRefreshParam(window.location, nonce()));
  }, onStuck);
}

/** The outcome `main.tsx` acts on: `in-flight` — a recovery navigation is
 *  already tearing the page down, do nothing; `navigating` — one was just
 *  requested (the shell may say so), and `onStuck` is called if it never
 *  commits; `none` — no automatic step is left, show the notice and report. */
export type BootRecoveryOutcome = "in-flight" | "navigating" | "none";

/**
 * Decide and start the next automatic recovery step for a failed boot.
 *
 * Production-only: in dev Vite serves modules straight from source, so a
 * failed import there is a real bug to see in the console, not deploy skew to
 * navigate past. `onStuck` runs if the requested navigation never commits.
 */
export function recoverFromBootFailure(error: unknown, onStuck: () => void): BootRecoveryOutcome {
  if (reloadInitiated) return "in-flight";
  if (typeof window === "undefined" || !import.meta.env.PROD) return "none";
  const key = buildKey();
  const record = readRecord();
  const now = Date.now();
  const plan = planStaleChunkRecovery({
    bootFinished,
    staleChunk: isStaleChunkMessage(describeError(error).message),
    buildKey: key,
    record,
    arrivedViaRefresh,
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    controlled: hasControllingWorker(),
    now,
  });
  if (plan === "none") return "none";
  const claimed = claimRecovery({
    build: key,
    step: plan,
    navigations: [...recentNavigations(record, now), now].slice(-MAX_AUTOMATIC_NAVIGATIONS * 2),
  });
  if (!claimed) return "none";
  reloadInitiated = true;
  armWatchdog(onStuck);
  if (plan === "reload") {
    // Reload revalidates the top-level document even inside its HTTP freshness
    // window. The URL — including the `#hash` share payload — is preserved.
    navigate(() => {
      window.location.reload();
    }, onStuck);
  } else {
    void bypassStaleShell(onStuck);
  }
  return "navigating";
}

/**
 * The manual path behind the boot notice's button: the bypass step, on demand.
 * Storage-independent (a person pressing a button cannot loop) and idempotent —
 * returns false, and does nothing, while a navigation is already in flight.
 * Outside production it is a plain reload, since the nonce would never be
 * stripped there.
 */
export function refreshPastStaleShell(onStuck: () => void): boolean {
  if (reloadInitiated || typeof window === "undefined") return false;
  if (!import.meta.env.PROD) {
    window.location.reload();
    return true;
  }
  reloadInitiated = true;
  armWatchdog(onStuck);
  void bypassStaleShell(onStuck);
  return true;
}

/**
 * Arm the recovery. Idempotent; call once from the entry, before anything reads
 * the URL for app state: a bypass nonce left over from the previous boot is
 * removed here (and remembered, so this boot never bypasses again). Readers that
 * run even earlier — the Activity's `frame_id` check, the short-link path match —
 * key on a named parameter or the pathname and never see it.
 */
export function installStaleChunkRecovery(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  try {
    const { pathname, search, hash } = window.location;
    if (hasRefreshParam(search)) {
      arrivedViaRefresh = true;
      window.history.replaceState(
        window.history.state,
        "",
        `${pathname}${stripRefreshParam(search)}${hash}`,
      );
    }
  } catch {
    /* URL cosmetics — never let them stop the boot */
  }

  window.addEventListener(
    "dweeb:surface-ready",
    () => {
      bootFinished = true;
    },
    { once: true },
  );
}
