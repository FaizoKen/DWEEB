/**
 * Local registry of schedules created from this browser.
 *
 * A scheduled post is owned by its **manage token** (returned once at creation;
 * the server keeps only a hash). To let an anonymous user manage their schedules
 * later we stash `{ id, manageToken }` here, mirroring `core/webhook/history.ts`.
 * Signed-in users also get a server-side cross-device list (`listMine`), but this
 * registry is what makes management work with no account at all.
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
  return safeParse(localStorage.getItem(STORAGE_KEY)).sort((a, b) => b.createdAt - a.createdAt);
}

function persist(entries: LocalSchedule[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

/** Record a freshly-created schedule + its manage token. */
export function rememberSchedule(entry: LocalSchedule): void {
  const all = loadLocalSchedules().filter((e) => e.id !== entry.id);
  persist([entry, ...all]);
}

/** Forget a schedule (after it's canceled). */
export function forgetSchedule(id: string): void {
  persist(loadLocalSchedules().filter((e) => e.id !== id));
}

/** The manage token for a locally-known schedule, if any. */
export function getManageToken(id: string): string | undefined {
  return loadLocalSchedules().find((e) => e.id === id)?.manageToken;
}
