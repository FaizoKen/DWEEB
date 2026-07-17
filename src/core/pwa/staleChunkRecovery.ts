/**
 * Deploy-skew recovery — reload once when a lazy chunk fails to load at boot.
 *
 * GitHub Pages serves `index.html` with ~10-minute HTTP caching and purges old
 * hashed chunks on every deploy. A visitor who isn't service-worker-controlled
 * yet (first visit, or the delayed registration in main.tsx hasn't run) can
 * therefore boot a just-stale shell whose `import()`s 404 — the browser surfaces
 * that as `TypeError: Failed to fetch dynamically imported module`, the page is
 * dead, and the crash reporter pages the maintainer about a non-bug. The SW
 * precache protects already-controlled tabs; this module covers everyone else.
 *
 * Vite wraps every built dynamic import in a preload helper that dispatches a
 * cancelable `vite:preloadError` on `window` *before* rethrowing, so a failed
 * chunk fetch is observable at one choke point. The recovery is the boring,
 * correct one: reload, which revalidates the document and boots the fresh shell.
 * Three guards keep it safe:
 *
 *  - **Once per version, per tab.** The attempt is recorded in `sessionStorage`
 *    keyed by the build version; if the reload lands on the same stale shell
 *    (or storage is unwritable) there is no second reload and the error reports
 *    normally — a reload loop is strictly worse than a crash report.
 *  - **Boot only.** Once the app surface has committed (`dweeb:surface-ready`)
 *    an automatic reload could throw away the user's in-progress message, so
 *    recovery disarms. Post-boot chunks are covered by the SW precache and,
 *    where a tab is uncontrolled anyway, by `ui/ChunkErrorBoundary`, which
 *    turns a failed lazy surface into a "refresh to update" prompt instead of
 *    a top-boundary crash.
 *  - **Never `preventDefault()`.** The import is left to reject so callers
 *    don't continue with an `undefined` module namespace; the reporter instead
 *    recognizes the in-flight recovery (`isStaleChunkReloadInProgress`) and
 *    drops the matching beacon — a self-healing event is not a crash.
 */

/** Everything the reload decision depends on, gathered by the glue below.
 *  Pure so the policy is unit-testable without a DOM. */
export interface StaleChunkReloadInput {
  /** Has the app surface committed? (`dweeb:surface-ready` fired) */
  bootFinished: boolean;
  /** The running build's version. */
  version: string;
  /** The version a previous reload attempt was recorded for, if any. */
  attemptedVersion: string | null;
}

/** Whether a failed chunk load should trigger the one recovery reload. */
export function shouldAttemptStaleChunkReload(input: StaleChunkReloadInput): boolean {
  // Past boot a reload could destroy unsaved editor state — never automatic.
  if (input.bootFinished) return false;
  // One attempt per version: a second failure on the same shell means the
  // reload didn't get a fresher one, so reloading again would just loop.
  return input.attemptedVersion !== input.version;
}

/** sessionStorage (per-tab, survives the reload) key holding the version the
 *  recovery reload was attempted for. */
const STORAGE_KEY = "dweeb.stale-chunk-reload";

let installed = false;
let bootFinished = false;
let reloadInitiated = false;

/** True from the moment a recovery reload has been requested until navigation
 *  actually tears the page down. The crash reporter uses this to drop the
 *  stale-chunk rejections that are already being recovered from. */
export function isStaleChunkReloadInProgress(): boolean {
  return reloadInitiated;
}

/** Mirror of reporter.ts's fallback-guarded read of the build-time version. */
function appVersion(): string {
  try {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown";
  } catch {
    return "unknown";
  }
}

function readAttemptedVersion(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Record the attempt before navigating; a read-back verifies the write stuck.
 *  Returns false when storage is unavailable — then we must NOT reload, because
 *  without the marker a persistent failure would reload forever. */
function claimReloadAttempt(version: string): boolean {
  try {
    sessionStorage.setItem(STORAGE_KEY, version);
    return sessionStorage.getItem(STORAGE_KEY) === version;
  } catch {
    return false;
  }
}

/**
 * Arm the recovery. Idempotent; call once from the entry, before the first
 * dynamic import. Production-only: in dev Vite serves modules straight from
 * source, so a preload error there is a real bug to see in the console, not
 * deploy skew to reload past.
 */
export function installStaleChunkRecovery(): void {
  if (installed || typeof window === "undefined" || !import.meta.env.PROD) return;
  installed = true;

  window.addEventListener(
    "dweeb:surface-ready",
    () => {
      bootFinished = true;
    },
    { once: true },
  );

  window.addEventListener("vite:preloadError", () => {
    if (reloadInitiated) return;
    const decision = shouldAttemptStaleChunkReload({
      bootFinished,
      version: appVersion(),
      attemptedVersion: readAttemptedVersion(),
    });
    if (!decision) return;
    if (!claimReloadAttempt(appVersion())) return;
    reloadInitiated = true;
    // Reload revalidates the top-level document even inside its HTTP
    // freshness window, so the new shell (and its live chunks) come down.
    // The URL — including the `#hash` share payload — is preserved.
    window.location.reload();
  });
}
