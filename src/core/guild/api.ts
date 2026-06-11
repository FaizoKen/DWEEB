/**
 * Typed client for the DWEEB proxy.
 *
 * All requests are credentialed (`credentials: "include"`) so the session
 * cookie set during Discord login rides along — the proxy uses it to authorize
 * reads. Errors are normalised onto `GuildApiError` carrying the proxy's
 * `{ error, status, retry_after }` shape; a `401` specifically means "not signed
 * in / session expired", which callers translate into a re-login prompt.
 */

import { PROXY_BASE_URL } from "./config";
import type { GuildRole } from "./types";

/** Discord snowflakes are 17–20 digits today; accept a small range with slack. */
const SNOWFLAKE_RE = /^\d{15,25}$/;

/** Raw `/bootstrap` body — the proxy's trimmed Discord shapes, pre-indexing. */
export interface BootstrapResponse {
  roles: GuildRole[];
  channels: RawChannel[];
  emojis: RawEmoji[];
}

/** Channel as the proxy sends it: `name` may be null, `type` is numeric. */
interface RawChannel {
  id: string;
  name: string | null;
  type: number;
  position?: number | null;
  parent_id?: string | null;
}

/** Emoji as the proxy sends it: `id`/`name` may be null on edge cases. */
interface RawEmoji {
  id: string | null;
  name: string | null;
  animated?: boolean;
  available?: boolean;
}

/** The signed-in user, from `GET /auth/me`. */
export interface AuthUser {
  id: string;
  name: string;
  avatar_url: string | null;
}

/** One server in the picker, from `GET /api/guilds`. */
export interface PickerGuild {
  id: string;
  name: string;
  icon: string | null;
  /** Whether the DWEEB bot is already a member (else the user must add it). */
  bot_present: boolean;
}

/** A failed proxy call, carrying the HTTP status and any rate-limit hint. */
export class GuildApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "GuildApiError";
  }
}

/** True when the error means "not signed in / session expired". */
export function isAuthError(e: unknown): boolean {
  return e instanceof GuildApiError && e.status === 401;
}

/** True when `id` looks like a Discord snowflake. */
export function isValidGuildId(id: string): boolean {
  return SNOWFLAKE_RE.test(id.trim());
}

/** Append `?fresh=true` when a caller wants to bypass the proxy's short-TTL
 *  cache — used by the manual "Refresh" so it pulls live data straight from
 *  Discord, while every passive load keeps hitting the cache to spare Discord's
 *  rate limit. The proxy re-warms the cache on a fresh read, so one user's
 *  refresh keeps the next person's load fast. */
function withFresh(path: string, force: boolean): string {
  return force ? `${path}?fresh=true` : path;
}

/** GET helper: credentialed fetch + normalised errors. `signal` is optional. */
async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}${path}`, {
      method: "GET",
      credentials: "include",
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new GuildApiError("Couldn't reach the server. Check your connection.", 0);
  }
  if (!res.ok) throw await toApiError(res);
  try {
    return (await res.json()) as T;
  } catch {
    throw new GuildApiError("The server returned an unexpected response.", res.status);
  }
}

/** `GET /auth/me` — returns the user, or null when not signed in (401). */
export async function fetchMe(): Promise<AuthUser | null> {
  try {
    return await getJson<AuthUser>("/auth/me");
  } catch (e) {
    if (isAuthError(e)) return null;
    throw e;
  }
}

/** `GET /api/guilds` — the signed-in user's usable servers. Pass `force` on a
 *  manual refresh to bypass the proxy's cache and pull a live list. */
export async function fetchUserGuilds(force = false): Promise<PickerGuild[]> {
  const body = await getJson<{ guilds: PickerGuild[] }>(withFresh("/api/guilds", force));
  return body.guilds ?? [];
}

/** `GET /api/guilds/:id/bootstrap` — a server's roles, channels, and emojis.
 *  Pass `force` on a manual refresh to bypass the proxy's cache. */
export async function fetchBootstrap(
  guildId: string,
  signal?: AbortSignal,
  force = false,
): Promise<BootstrapResponse> {
  const id = guildId.trim();
  if (!isValidGuildId(id)) {
    throw new GuildApiError("That doesn't look like a valid server ID.", 0);
  }
  return getJson<BootstrapResponse>(withFresh(`/api/guilds/${id}/bootstrap`, force), signal);
}

/**
 * `GET /api/guilds/:id/emojis` — just a server's custom emoji. Lighter than
 * `bootstrap`; used to gather emoji from the user's *other* bot servers without
 * also pulling their roles and channels.
 */
export async function fetchGuildEmojis(guildId: string, signal?: AbortSignal): Promise<RawEmoji[]> {
  const id = guildId.trim();
  if (!isValidGuildId(id)) {
    throw new GuildApiError("That doesn't look like a valid server ID.", 0);
  }
  return getJson<RawEmoji[]>(`/api/guilds/${id}/emojis`, signal);
}

// ── Permanent component slots ───────────────────────────────────────────────
// Messages exempted from the component expiry (the interactions dispatcher
// disables plugin buttons/selects COMPONENT_TTL_DAYS after a message is sent).
// Each server gets a fixed number of exemption slots, managed here through the
// proxy, which checks the signed-in user manages the server.

/** One message currently occupying a permanent slot. */
export interface PermanentSlotItem {
  message_id: string;
  channel_id: string;
  /** Unix millis when the slot was granted. */
  added_at: number;
}

/** A server's permanent-slot state, as every slot endpoint returns it. */
export interface PermanentSlots {
  /** Slots the server may hold. */
  cap: number;
  used: number;
  /** Days components stay clickable on ordinary messages; null = no expiry
   *  configured on this deployment (so permanence is moot). */
  ttl_days: number | null;
  items: PermanentSlotItem[];
}

/** Outcome of an add: `full` carries the occupying slots so the UI can offer
 *  freeing one instead of surfacing a dead-end error. */
export type PermanentAddResult =
  | { full: false; slots: PermanentSlots }
  | { full: true; slots: PermanentSlots };

/** `GET /api/guilds/:id/permanent` — slot usage + current permanent messages.
 *  A 501 means the deployment doesn't run the feature; callers typically hide
 *  the UI on it (`e.status === 501`). */
export async function fetchPermanentSlots(
  guildId: string,
  signal?: AbortSignal,
): Promise<PermanentSlots> {
  const id = guildId.trim();
  if (!isValidGuildId(id)) {
    throw new GuildApiError("That doesn't look like a valid server ID.", 0);
  }
  return getJson<PermanentSlots>(`/api/guilds/${id}/permanent`, signal);
}

/** `POST /api/guilds/:id/permanent` — spend a slot on a message. Idempotent:
 *  re-adding an already-permanent message succeeds. */
export async function addPermanentMessage(
  guildId: string,
  messageId: string,
  channelId: string,
): Promise<PermanentAddResult> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/guilds/${guildId.trim()}/permanent`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_id: messageId, channel_id: channelId }),
    });
  } catch {
    throw new GuildApiError("Couldn't reach the server. Check your connection.", 0);
  }
  // 409 = every slot is taken. Not an exception — the body carries the
  // occupying messages so the UI can offer to free one.
  if (res.status === 409) {
    try {
      return { full: true, slots: (await res.json()) as PermanentSlots };
    } catch {
      throw new GuildApiError("The server returned an unexpected response.", res.status);
    }
  }
  if (!res.ok) throw await toApiError(res);
  try {
    return { full: false, slots: (await res.json()) as PermanentSlots };
  } catch {
    throw new GuildApiError("The server returned an unexpected response.", res.status);
  }
}

/** `DELETE /api/guilds/:id/permanent/:messageId` — give a slot back. A 404
 *  (already freed) is treated as success: the goal state is reached either
 *  way, so the fresh list is fetched and returned. */
export async function removePermanentMessage(
  guildId: string,
  messageId: string,
): Promise<PermanentSlots> {
  let res: Response;
  try {
    res = await fetch(
      `${PROXY_BASE_URL}/api/guilds/${guildId.trim()}/permanent/${messageId.trim()}`,
      { method: "DELETE", credentials: "include" },
    );
  } catch {
    throw new GuildApiError("Couldn't reach the server. Check your connection.", 0);
  }
  if (res.status === 404) return fetchPermanentSlots(guildId);
  if (!res.ok) throw await toApiError(res);
  try {
    return (await res.json()) as PermanentSlots;
  } catch {
    throw new GuildApiError("The server returned an unexpected response.", res.status);
  }
}

/** `POST /auth/logout` — clear the session. Best-effort; never throws. */
export async function postLogout(): Promise<void> {
  try {
    await fetch(`${PROXY_BASE_URL}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    // Network hiccup on logout is harmless — the client state resets regardless.
  }
}

/** Map the proxy's JSON error body onto a `GuildApiError`, with sane fallbacks. */
async function toApiError(res: Response): Promise<GuildApiError> {
  let message = friendlyStatus(res.status);
  let retryAfter: number | undefined;
  try {
    const body = (await res.json()) as { error?: string; retry_after?: number };
    if (typeof body.error === "string" && body.error) message = body.error;
    if (typeof body.retry_after === "number") retryAfter = body.retry_after;
  } catch {
    // Non-JSON error body — keep the status-derived message.
  }
  return new GuildApiError(message, res.status, retryAfter);
}

/** A human default for statuses whose body we couldn't parse. */
function friendlyStatus(status: number): string {
  switch (status) {
    case 401:
      return "Sign in with Discord to load server data.";
    case 403:
      return "You can only load servers you manage.";
    case 404:
      return "Server not found — make sure the DWEEB bot has been added to it.";
    case 429:
      return "Rate limited — try again in a moment.";
    default:
      return `Request failed (${status}).`;
  }
}

// Re-export the raw shapes so the store's indexer can normalise them.
export type { RawChannel, RawEmoji };
