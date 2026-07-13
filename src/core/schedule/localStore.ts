/**
 * Local registry of schedules created from this browser.
 *
 * A scheduled post is owned by the signed-in Discord account and also gets a
 * one-time **manage token** (the server keeps only a hash). We stash
 * `{ id, manageToken }` here, mirroring `core/webhook/history.ts`, as a local
 * recovery capability. The account-owned server list (`listMine`) remains the
 * authoritative cross-device path.
 *
 * The token is a bearer capability, so this is the same trust level as the
 * webhook history already in `localStorage` — it never leaves the browser except
 * back to the proxy that issued it.
 */

const STORAGE_KEY = "dweeb.schedules.v1";
const MAX_ENTRIES = 100;

export interface LocalSchedule {
  /** Public schedule id. */
  id: string;
  /** The bearer manage token (returned once at creation). */
  manageToken: string;
  /** Optional label, for showing something before the server view loads. */
  title?: string;
  /** Destination webhook id, for grouping/labelling. */
  webhookId?: string;
  /** Unix millis when this browser created it. */
  createdAt: number;
}

function safeParse(raw: string | null): LocalSchedule[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is LocalSchedule =>
        e &&
        typeof e === "object" &&
        typeof e.id === "string" &&
        typeof e.manageToken === "string" &&
        typeof e.createdAt === "number",
    );
  } catch {
    return [];
  }
}

export function loadLocalSchedules(): LocalSchedule[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return safeParse(localStorage.getItem(STORAGE_KEY)).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function persist(entries: LocalSchedule[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
    return true;
  } catch {
    return false;
  }
}

/** Record a freshly-created schedule + its manage token durably. */
export function rememberSchedule(entry: LocalSchedule): boolean {
  const all = loadLocalSchedules().filter((e) => e.id !== entry.id);
  return persist([entry, ...all]);
}

/** Forget a schedule (after it's canceled). */
export function forgetSchedule(id: string): boolean {
  return persist(loadLocalSchedules().filter((e) => e.id !== id));
}

/** The manage token for a locally-known schedule, if any. */
export function getManageToken(id: string): string | undefined {
  return loadLocalSchedules().find((e) => e.id === id)?.manageToken;
}
