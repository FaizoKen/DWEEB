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

/** `GET /api/guilds` — the signed-in user's usable servers. */
export async function fetchUserGuilds(): Promise<PickerGuild[]> {
  const body = await getJson<{ guilds: PickerGuild[] }>("/api/guilds");
  return body.guilds ?? [];
}

/** `GET /api/guilds/:id/bootstrap` — a server's roles, channels, and emojis. */
export async function fetchBootstrap(
  guildId: string,
  signal?: AbortSignal,
): Promise<BootstrapResponse> {
  const id = guildId.trim();
  if (!isValidGuildId(id)) {
    throw new GuildApiError("That doesn't look like a valid server ID.", 0);
  }
  return getJson<BootstrapResponse>(`/api/guilds/${id}/bootstrap`, signal);
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
