/**
 * Recent-webhooks list.
 *
 * An entry is added when the user successfully sends a message or clicks
 * "Save webhook" — both go through `rememberWebhook`. A URL the user only
 * typed without sending is never persisted.
 *
 * Each entry records the webhook's own `name` (captured from Discord at save
 * time) plus an optional user `label` that overrides it for display. The label
 * is set by renaming inline in the recents list, not before saving.
 *
 * Storage is plain `localStorage` keyed by `STORAGE_KEY`. The key includes a
 * version suffix so a future shape change can ignore the old data instead of
 * trying to migrate it.
 */

import { parseWebhookUrl, type WebhookOwnerKind } from "./send";

const STORAGE_KEY = "dweeb.webhook_history.v1";
const MAX_ENTRIES = 5;

export interface WebhookHistoryEntry {
  /** Webhook snowflake (parsed from the URL). */
  id: string;
  /** Canonical execute URL. */
  url: string;
  /** The webhook's own name, as Discord returned it at save time. May be empty. */
  name: string;
  /** Optional user override shown instead of `name`; edited inline in the list. */
  label: string;
  /** Unix millis, set on save and refreshed on use. */
  lastUsedAt: number;
  /** Bot vs. person, captured at verify time. Absent on pre-v1 entries. */
  ownerKind?: WebhookOwnerKind;
  /** Avatar hash captured at save time; null when the webhook has no picture. */
  avatar?: string | null;
  /** Channel the webhook posts to, captured at verify time. Absent on older entries. */
  channelId?: string;
  /** Guild the webhook belongs to, captured at verify time. Absent when Discord omits it. */
  guildId?: string;
}

const OWNER_KINDS: readonly WebhookOwnerKind[] = ["bot", "user", "follower", "unknown"];

function safeParse(raw: string | null): WebhookHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is WebhookHistoryEntry =>
          e &&
          typeof e === "object" &&
          typeof e.id === "string" &&
          typeof e.url === "string" &&
          typeof e.label === "string" &&
          typeof e.lastUsedAt === "number",
      )
      .map((e) => ({
        ...e,
        // Pre-name entries (saved before this field existed) get an empty name
        // and fall back to the label/ "(unlabeled)" in the UI.
        name: typeof (e as { name?: unknown }).name === "string" ? e.name : "",
        // Drop anything that isn't a known owner kind so stale/garbage values
        // don't leak into the UI.
        ownerKind: OWNER_KINDS.includes(e.ownerKind as WebhookOwnerKind) ? e.ownerKind : undefined,
        // Keep only a string hash; anything else (incl. old entries) → no avatar.
        avatar: typeof (e as { avatar?: unknown }).avatar === "string" ? e.avatar : null,
        // Snowflakes only; older entries (saved before these fields) → undefined.
        channelId:
          typeof (e as { channelId?: unknown }).channelId === "string" ? e.channelId : undefined,
        guildId: typeof (e as { guildId?: unknown }).guildId === "string" ? e.guildId : undefined,
      }));
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
 * a single record. Each supplied field falls back to the existing value when
 * omitted, so a re-save that only knows the owner won't wipe a name or a
 * user's inline label.
 */
export function rememberWebhook(
  rawUrl: string,
  fields: {
    name?: string;
    label?: string;
    ownerKind?: WebhookOwnerKind;
    avatar?: string | null;
    channelId?: string;
    guildId?: string;
  } = {},
): WebhookHistoryEntry | null {
  const parsed = parseWebhookUrl(rawUrl);
  if (!parsed) return null;

  const all = loadHistory();
  const existing = all.find((e) => e.id === parsed.id);
  const entry: WebhookHistoryEntry = {
    id: parsed.id,
    url: parsed.url,
    name: fields.name?.trim() || existing?.name || "",
    label: fields.label?.trim() || existing?.label || "",
    lastUsedAt: Date.now(),
    ownerKind: fields.ownerKind ?? existing?.ownerKind,
    // `null` is a real value ("no picture"), so only fall back when omitted.
    avatar: fields.avatar !== undefined ? fields.avatar : (existing?.avatar ?? null),
    channelId: fields.channelId ?? existing?.channelId,
    guildId: fields.guildId ?? existing?.guildId,
  };

  const next = [entry, ...all.filter((e) => e.id !== parsed.id)].slice(0, MAX_ENTRIES);
  persist(next);
  return entry;
}

/**
 * Set the user's custom label on a saved entry — backs the inline rename in
 * the recents list. Position and `lastUsedAt` are left untouched. Passing an
 * empty string clears the label so the webhook's own name shows again.
 */
export function renameWebhook(id: string, label: string): void {
  const all = loadHistory();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx]!, label: label.trim() };
  persist(all);
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
