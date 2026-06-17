/**
 * URL-hash share state.
 *
 * Share state lives in the URL hash (`#s=<token>`) so:
 *  - The server never sees it (privacy, plus avoids CDN cache poisoning).
 *  - Page reloads keep the message intact.
 *  - The static host's SPA fallback never gets in the way.
 *
 * The reader returns the token only if the prefix matches — anything else
 * (e.g. `#dialog=share`) is ignored, leaving room for other hash-based UI.
 */

const HASH_KEY = "s";

/**
 * Extra hash params an "Edit in DWEEB" link carries beside `s=` — the message's
 * origin on Discord: webhook id (`w`), message id (`m`), and, for a threaded
 * message, thread id (`t`). All three are non-secret identifiers (visible to
 * anyone who can read the message); the webhook *token* needed to edit it never
 * travels — the editor resolves it from the browser's own saved webhooks.
 */
const ORIGIN_KEYS = { webhookId: "w", messageId: "m", threadId: "t" } as const;

export interface ShareLinkOrigin {
  /** Webhook snowflake — keys the lookup into saved webhooks. */
  webhookId: string;
  /** The message to edit. */
  messageId: string;
  /** Thread the message lives in, when it's a threaded message. */
  threadId?: string;
}

export function readShareTokenFromHash(hash: string): string | null {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!trimmed) return null;
  const params = new URLSearchParams(trimmed);
  const value = params.get(HASH_KEY);
  return value && value.length > 0 ? value : null;
}

/**
 * Read the origin identifiers an "Edit in DWEEB" link carries. Returns null
 * unless both the webhook and message ids are present (a plain share link, or
 * one missing either id, has no usable origin).
 */
export function readShareOriginFromHash(hash: string): ShareLinkOrigin | null {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!trimmed) return null;
  const params = new URLSearchParams(trimmed);
  const webhookId = params.get(ORIGIN_KEYS.webhookId);
  const messageId = params.get(ORIGIN_KEYS.messageId);
  if (!webhookId || !messageId) return null;
  return { webhookId, messageId, threadId: params.get(ORIGIN_KEYS.threadId) || undefined };
}

/**
 * Build a full sharable URL for the current document. Replaces any existing
 * `s=` value but preserves other hash fragments so deep-linkable UI keeps
 * working alongside share links.
 */
export function buildShareUrl(token: string, location: Location = window.location): string {
  const url = new URL(location.href);
  const hashBody = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(hashBody);
  params.set(HASH_KEY, token);
  url.hash = params.toString();
  return url.toString();
}

/** Writes the token into `location.hash` without scrolling the page. */
export function writeShareTokenToHash(token: string): void {
  const url = buildShareUrl(token);
  window.history.replaceState(null, "", url);
}

/**
 * Strips the share token — and any "Edit in DWEEB" origin params that rode
 * alongside it — from the URL hash, leaving other hash params untouched.
 */
export function clearShareTokenFromHash(): void {
  const url = new URL(window.location.href);
  const hashBody = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(hashBody);
  params.delete(HASH_KEY);
  for (const key of Object.values(ORIGIN_KEYS)) params.delete(key);
  const next = params.toString();
  url.hash = next.length > 0 ? next : "";
  window.history.replaceState(null, "", url.toString());
}
