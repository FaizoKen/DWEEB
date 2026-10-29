/**
 * When the send receipt may carry an ad.
 *
 * DWEEB shows one ad, in one place: under the "Message posted" receipt, after
 * the work is done. Everything here exists to keep that from becoming the
 * thing people remember about the tool:
 *
 * - **Never on a paid server.** Plus and Pro servers are ad-free; a send whose
 *   destination is one of them shows nothing (`adFree.ts` decides).
 * - **Never in the Discord Activity.** It's someone else's client, and its CSP
 *   blocks third-party hosts anyway.
 * - **Never a first impression.** The first successful send in a browser is the
 *   moment the tool proves itself, so it stays clean.
 * - **At most once every few minutes.** Someone iterating on a message hits
 *   Update again and again; one ad per round of edits is plenty.
 * - **Never against a privacy signal or a data-saver.** A browser sending Global
 *   Privacy Control or Do Not Track gets no ad (it gets no analytics either), and
 *   Save-Data skips the third-party bytes.
 * - **Never a nag.** An ad blocker simply means no slot — no "please disable".
 * - **Never with state in the address bar.** The ad request carries the page
 *   URL, and a share link's hash is the message itself.
 *
 * The decision is a pure function of those facts so it can be tested; the
 * remembered part (sends so far, when an ad last showed) lives in one
 * throw-safe localStorage record.
 */

/** Minimum gap between two receipts that carry an ad. */
export const AD_COOLDOWN_MS = 3 * 60_000;

/** Below this viewport height the receipt has no room to spare for an ad. */
export const AD_MIN_VIEWPORT_HEIGHT = 560;

export interface SendAdFacts {
  /** Both AdSense ids are configured for this build. */
  configured: boolean;
  /** Running embedded as the Discord Activity. */
  activity: boolean;
  /** The browser sends Global Privacy Control or Do Not Track. */
  privacySignal: boolean;
  /** The browser asked to save data (`navigator.connection.saveData`). */
  saveData: boolean;
  /** The ad script already failed to load on this page (an ad blocker, mostly). */
  blocked: boolean;
  /** The address bar still carries a query or hash. The ad request includes the
   *  page's URL, and DWEEB keeps state there — a share link's `#s=` *is* the
   *  whole message. Boot strips all of it once read, so this is a guard for the
   *  case where something didn't. */
  addressHoldsState: boolean;
  /** Viewport height in CSS pixels. */
  viewportHeight: number;
  /** Successful sends recorded in this browser *before* this one. */
  priorSends: number;
  /** When an ad last showed on a receipt (ms epoch), if ever. */
  lastShownAt: number | null;
  now: number;
}

/** Whether this receipt may try to show an ad. The paid-server check is
 *  separate (it may need the network) and runs after this says yes. */
export function sendAdAllowed(facts: SendAdFacts): boolean {
  if (!facts.configured || facts.activity) return false;
  if (facts.privacySignal || facts.saveData || facts.blocked) return false;
  if (facts.addressHoldsState) return false;
  if (facts.viewportHeight < AD_MIN_VIEWPORT_HEIGHT) return false;
  if (facts.priorSends < 1) return false;
  const gap = facts.lastShownAt === null ? Infinity : facts.now - facts.lastShownAt;
  // A clock that moved backwards (a negative gap) must not silence ads until it
  // catches up, so only a gap inside the window counts.
  return !(gap >= 0 && gap < AD_COOLDOWN_MS);
}

const STORAGE_KEY = "dweeb.ads.receipt.v1";

export interface AdRecord {
  sends: number;
  lastShownAt: number | null;
}

const EMPTY: AdRecord = { sends: 0, lastShownAt: null };

/** Read the record. Missing, unreadable (blocked site data throws on
 *  `getItem`) and malformed all read as a fresh browser. */
export function readAdRecord(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): AdRecord {
  if (!storage) return EMPTY;
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const { sends, lastShownAt } = parsed as Record<string, unknown>;
    return {
      sends:
        typeof sends === "number" && Number.isFinite(sends) && sends > 0 ? Math.floor(sends) : 0,
      lastShownAt:
        typeof lastShownAt === "number" && Number.isFinite(lastShownAt) ? lastShownAt : null,
    };
  } catch {
    return EMPTY;
  }
}

function writeAdRecord(record: AdRecord, storage: Pick<Storage, "setItem"> | undefined): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Quota or blocked storage: the worst case is one more ad-free receipt.
  }
}

/** Count a successful send. Read-modify-write, since every tab shares the record. */
export function recordSend(storage: Storage | undefined = safeStorage()): void {
  const current = readAdRecord(storage);
  writeAdRecord({ ...current, sends: Math.min(current.sends + 1, 1_000_000) }, storage);
}

/** Note that a receipt showed an ad, starting the cooldown. */
export function recordAdShown(now: number, storage: Storage | undefined = safeStorage()): void {
  writeAdRecord({ ...readAdRecord(storage), lastShownAt: now }, storage);
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Global Privacy Control or Do Not Track — the same test `gtag-init.js` runs
 *  before loading analytics. */
export function browserSendsPrivacySignal(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  const win =
    typeof window === "undefined" ? undefined : (window as Window & { doNotTrack?: string });
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1" || win?.doNotTrack === "1";
}

/** The browser's Save-Data preference, where it exposes one. */
export function browserSavesData(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}
