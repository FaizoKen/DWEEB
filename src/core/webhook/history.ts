/**
 * Recent-webhooks list.
 *
 * Webhook URLs are credentials, so storage is **opt-in per entry** — adding a
 * URL to the list requires an explicit user action (the "Remember" checkbox
 * in the Send panel). We never auto-save URLs the user has only typed once.
 *
 * Storage is plain `localStorage` keyed by `STORAGE_KEY`. The key includes a
 * version suffix so a future shape change can ignore the old data instead of
 * trying to migrate it.
 */

import { parseWebhookUrl } from "./send";

const STORAGE_KEY = "dwb.webhook_history.v1";
const MAX_ENTRIES = 5;

export interface WebhookHistoryEntry {
  /** Webhook snowflake (parsed from the URL). */
  id: string;
  /** Canonical execute URL. */
  url: string;
  /** Free-form user label (e.g. "Releases · #announcements"). May be empty. */
  label: string;
  /** Unix millis, set on save and refreshed on use. */
  lastUsedAt: number;
}

function safeParse(raw: string | null): WebhookHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is WebhookHistoryEntry =>
        e &&
        typeof e === "object" &&
        typeof e.id === "string" &&
        typeof e.url === "string" &&
        typeof e.label === "string" &&
        typeof e.lastUsedAt === "number",
    );
  } catch {
    return [];
  }
}

export function loadHistory(): WebhookHistoryEntry[] {
  if (typeof localStorage === "undefined") return [];
  return safeParse(localStorage.getItem(STORAGE_KEY)).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

function persist(entries: WebhookHistoryEntry[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/**
 * Upsert an entry. The URL is canonicalized via `parseWebhookUrl` so two
 * paste variants (trailing slash, different version path, etc.) merge into
 * a single record.
 */
export function rememberWebhook(rawUrl: string, label: string): WebhookHistoryEntry | null {
  const parsed = parseWebhookUrl(rawUrl);
  if (!parsed) return null;

  const all = loadHistory();
  const existing = all.find((e) => e.id === parsed.id);
  const entry: WebhookHistoryEntry = {
    id: parsed.id,
    url: parsed.url,
    label: label.trim() || existing?.label || "",
    lastUsedAt: Date.now(),
  };

  const next = [entry, ...all.filter((e) => e.id !== parsed.id)].slice(0, MAX_ENTRIES);
  persist(next);
  return entry;
}

export function touchWebhook(id: string): void {
  const all = loadHistory();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) return;
  const updated = { ...all[idx]!, lastUsedAt: Date.now() };
  const next = [updated, ...all.filter((e) => e.id !== id)].slice(0, MAX_ENTRIES);
  persist(next);
}

export function forgetWebhook(id: string): void {
  persist(loadHistory().filter((e) => e.id !== id));
}

export function clearHistory(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}
