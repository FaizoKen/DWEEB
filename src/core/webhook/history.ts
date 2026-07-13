/**
 * Recent-webhooks list.
 *
 * An entry is added when the user successfully sends a message or clicks
 * "Save webhook" — both go through `rememberWebhook`. A URL the user only
 * typed without sending is never persisted.
 *
 * Each entry records the webhook's own `name`, captured from Discord at save
 * time.
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
  /** Unix millis, set on save and refreshed on use. */
  lastUsedAt: number;
  /** Bot vs. person, captured at verify time. Absent on pre-v1 entries. */
  ownerKind?: WebhookOwnerKind;
  /** Owning application's id when `ownerKind` is "bot" — lets the Send panel
   *  tell a DWEEB/custom-bot webhook from an unrelated app's without a
   *  re-verify. Absent on person/follower webhooks and on older entries. */
  applicationId?: string;
  /** Avatar hash captured at save time; null when the webhook has no picture. */
  avatar?: string | null;
  /** Channel the webhook posts to, captured at verify time. Absent on older entries. */
  channelId?: string;
  /** Guild the webhook belongs to, captured at verify time. Absent when Discord omits it. */
  guildId?: string;
  /** Channel *name* (e.g. "general"), resolved when the webhook was created via
   *  the `webhook.incoming` flow. Lets same-named webhooks be told apart by
   *  destination without signing in. Absent when it couldn't be resolved. */
  channelName?: string;
  /** Server *name*, resolved alongside `channelName`. */
  guildName?: string;
  /** Unix millis when a health check (verify GET) last found this webhook gone
   *  on Discord — deleted, or its token revoked (404/401). Absent while the
   *  webhook is reachable; cleared automatically if a later check succeeds. */
  deletedAt?: number;
}

const OWNER_KINDS: readonly WebhookOwnerKind[] = ["bot", "user", "follower", "unknown"];

function safeParse(raw: string | null): WebhookHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is WebhookHistoryEntry => {
        if (
          !e ||
          typeof e !== "object" ||
          typeof e.id !== "string" ||
          typeof e.url !== "string" ||
          typeof e.lastUsedAt !== "number"
        ) {
          return false;
        }
        // localStorage is user/script-controlled input. Keep the credential
        // boundary pinned to a canonical Discord execute URL, and make sure the
        // separately stored id cannot disagree with the URL it labels.
        const parsedUrl = parseWebhookUrl(e.url);
        return parsedUrl !== null && parsedUrl.id === e.id && parsedUrl.url === e.url;
      })
      .map((e) => ({
        ...e,
        // Pre-name entries (saved before this field existed) get an empty name
        // and fall back to "(unlabeled)" in the UI.
        name: typeof (e as { name?: unknown }).name === "string" ? e.name : "",
        // Drop anything that isn't a known owner kind so stale/garbage values
        // don't leak into the UI.
        ownerKind: OWNER_KINDS.includes(e.ownerKind as WebhookOwnerKind) ? e.ownerKind : undefined,
        applicationId:
          typeof (e as { applicationId?: unknown }).applicationId === "string"
            ? e.applicationId
            : undefined,
        // Keep only a string hash; anything else (incl. old entries) → no avatar.
        avatar: typeof (e as { avatar?: unknown }).avatar === "string" ? e.avatar : null,
        // Snowflakes only; older entries (saved before these fields) → undefined.
        channelId:
          typeof (e as { channelId?: unknown }).channelId === "string" ? e.channelId : undefined,
        guildId: typeof (e as { guildId?: unknown }).guildId === "string" ? e.guildId : undefined,
        channelName:
          typeof (e as { channelName?: unknown }).channelName === "string"
            ? e.channelName
            : undefined,
        guildName:
          typeof (e as { guildName?: unknown }).guildName === "string" ? e.guildName : undefined,
        deletedAt:
          typeof (e as { deletedAt?: unknown }).deletedAt === "number" ? e.deletedAt : undefined,
      }));
  } catch {
    return [];
  }
}

export function loadHistory(): WebhookHistoryEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return safeParse(localStorage.getItem(STORAGE_KEY)).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch {
    // Browsers can expose localStorage while throwing on access (privacy
    // settings, sandboxed frames, a disabled origin). Recents are optional and
    // must never turn a successful Discord request into an apparent failure.
    return [];
  }
}

function persist(entries: WebhookHistoryEntry[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

/**
 * Upsert an entry. The URL is canonicalized via `parseWebhookUrl` so two
 * paste variants (trailing slash, different version path, etc.) merge into
 * a single record. Each supplied field falls back to the existing value when
 * omitted, so a re-save that only knows the owner won't wipe a name.
 */
export function rememberWebhook(
  rawUrl: string,
  fields: {
    name?: string;
    ownerKind?: WebhookOwnerKind;
    applicationId?: string;
    avatar?: string | null;
    channelId?: string;
    guildId?: string;
    channelName?: string;
    guildName?: string;
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
    lastUsedAt: Date.now(),
    ownerKind: fields.ownerKind ?? existing?.ownerKind,
    applicationId: fields.applicationId ?? existing?.applicationId,
    // `null` is a real value ("no picture"), so only fall back when omitted.
    avatar: fields.avatar !== undefined ? fields.avatar : (existing?.avatar ?? null),
    channelId: fields.channelId ?? existing?.channelId,
    guildId: fields.guildId ?? existing?.guildId,
    channelName: fields.channelName ?? existing?.channelName,
    guildName: fields.guildName ?? existing?.guildName,
  };

  const next = [entry, ...all.filter((e) => e.id !== parsed.id)].slice(0, MAX_ENTRIES);
  return persist(next) ? entry : null;
}

export function touchWebhook(id: string): boolean {
  const all = loadHistory();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  const updated = { ...all[idx]!, lastUsedAt: Date.now() };
  const next = [updated, ...all.filter((e) => e.id !== id)].slice(0, MAX_ENTRIES);
  return persist(next);
}

export function forgetWebhook(id: string): boolean {
  return persist(loadHistory().filter((e) => e.id !== id));
}

/**
 * Apply fresh metadata from a live verify (GET) to a saved entry, in place.
 * Backs the recents health check, so a webhook renamed / re-pictured / moved on
 * Discord stops showing stale details. Unlike `rememberWebhook` this never
 * reorders the list or bumps `lastUsedAt` — merely opening the dialog mustn't
 * reshuffle recents — and it leaves the creation-time
 * `channelName`/`guildName` alone. A successful verify also proves the webhook
 * is alive, so any `deletedAt` flag is cleared.
 *
 * Returns true only when a field actually changed, so the caller can skip a
 * redundant persist + re-render.
 */
export function refreshWebhook(
  id: string,
  fields: {
    name?: string;
    avatar?: string | null;
    ownerKind?: WebhookOwnerKind;
    applicationId?: string;
    channelId?: string;
    guildId?: string;
  },
): boolean {
  const all = loadHistory();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  const cur = all[idx]!;
  const next: WebhookHistoryEntry = {
    ...cur,
    name: fields.name?.trim() || cur.name,
    avatar: fields.avatar !== undefined ? fields.avatar : cur.avatar,
    ownerKind: fields.ownerKind ?? cur.ownerKind,
    applicationId: fields.applicationId ?? cur.applicationId,
    channelId: fields.channelId ?? cur.channelId,
    guildId: fields.guildId ?? cur.guildId,
    deletedAt: undefined,
  };
  if (
    next.name === cur.name &&
    next.avatar === cur.avatar &&
    next.ownerKind === cur.ownerKind &&
    next.applicationId === cur.applicationId &&
    next.channelId === cur.channelId &&
    next.guildId === cur.guildId &&
    next.deletedAt === cur.deletedAt
  ) {
    return false;
  }
  all[idx] = next;
  return persist(all);
}

/**
 * Flag a saved entry whose verify GET came back 404 (deleted) or 401 (token
 * revoked) — it can no longer receive messages. In place, like `refreshWebhook`.
 * Returns true only when it newly sets the flag (already-flagged entries are a
 * no-op) so the caller can avoid a redundant re-render.
 */
export function markWebhookGone(id: string): boolean {
  const all = loadHistory();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0 || all[idx]!.deletedAt) return false;
  all[idx] = { ...all[idx]!, deletedAt: Date.now() };
  return persist(all);
}

export function clearHistory(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    // Optional local recents must not destabilise the surrounding flow.
    return false;
  }
}
