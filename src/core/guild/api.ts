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
import { proxyFetch } from "@/core/net/proxyFetch";
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
  /**
   * Whether the signed-in user holds Manage Webhooks (or Administrator/owner)
   * in this server — the gate for the Webhook Manager. Optional so a response
   * from a proxy predating the field is treated as `false` (no access shown).
   */
  can_manage_webhooks?: boolean;
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

/**
 * Absolute Discord CDN URL for a guild's icon, or `null` when the guild has no
 * custom icon. `icon` is the hash Discord returns on the guild object. Animated
 * icons (hash prefixed `a_`) are served as `.gif`; everything else as `.webp`.
 * `size` must be a power of two in 16…4096 — defaults to 256 so the URL is usable
 * as a webhook avatar or thumbnail, not just a tiny list glyph.
 */
export function guildIconUrl(id: string, icon: string | null, size = 256): string | null {
  if (!icon) return null;
  const ext = icon.startsWith("a_") ? "gif" : "webp";
  return `https://cdn.discordapp.com/icons/${id}/${icon}.${ext}?size=${size}`;
}

/** Append `?fresh=true` when a caller wants to bypass the proxy's short-TTL
 *  cache — used by the manual "Refresh" so it pulls live data straight from
 *  Discord, while every passive load keeps hitting the cache to spare Discord's
 *  rate limit. The proxy re-warms the cache on a fresh read, so one user's
 *  refresh keeps the next person's load fast. */
function withFresh(path: string, force: boolean): string {
  return force ? `${path}?fresh=true` : path;
}

/** GET helper: credentialed fetch + normalised errors. `signal` is optional.
 *  Routes through `proxyFetch` so the embedded Activity's bearer token is
 *  attached automatically (the web app keeps using its session cookie). */
async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await proxyFetch(path, { method: "GET", signal });
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

// ── Plan (per-server premium, MEE6/Dyno-style) ─────────────────────────────
// Premium is sold per Discord server: a Stripe subscription is bound to one
// guild and raises that server's quotas. The proxy resolves a server's tier from
// the subscriptions bound to it (see `server/src/stripe.rs`). These caps only
// ever raise numeric quotas — nothing is paywall-locked.

/** A DWEEB plan tier, from `GET /api/guilds/:id/plan`. */
export type PlanTier = "free" | "plus" | "pro";

/** Per-tier numeric quotas; `null` means unlimited. */
export interface PlanLimits {
  schedules: number | null;
  permanent: number | null;
  custom_bots: number | null;
  coeditors: number | null;
  /** Message-library entries per server. */
  library: number | null;
}

/** A server's plan, from `GET /api/guilds/:id/plan`. */
export interface PlanInfo {
  tier: PlanTier;
  limits: PlanLimits;
  /** Whether in-app billing (embedded checkout) is available on this deployment
   *  (Stripe configured server-side). When false the pricing modal is
   *  informational only. */
  billing: boolean;
}

/** `GET /api/guilds/:id/plan` — that server's tier + limits. Returns null when
 *  not signed in (401), so callers treat anonymous as "no plan loaded". Always
 *  resolves to a real tier when authorized (the proxy fails open to Free). */
export async function fetchGuildPlan(guildId: string): Promise<PlanInfo | null> {
  const id = guildId.trim();
  if (!isValidGuildId(id)) return null;
  try {
    return await getJson<PlanInfo>(`/api/guilds/${id}/plan`);
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

// ── Collaboration links ─────────────────────────────────────────────────────

/** A collaboration link minted by `POST /api/guilds/:id/activity-invite`. */
export interface ActivityInvite {
  /** The `discord.gg/{code}` invite slug. */
  code: string;
  /** The full shareable URL — `https://discord.gg/{code}`. */
  url: string;
  /** ISO-8601 expiry, or null for a never-expiring invite. */
  expires_at: string | null;
}

/**
 * `POST /api/guilds/:id/activity-invite` `{ channel_id }` — mint a Discord
 * Activity invite for a channel. Opening the returned `discord.gg/…` link drops
 * whoever clicks it into that channel with DWEEB launched, so a group lands in one
 * shared instance and co-edits live — the "Collaborate in Discord" hand-off.
 * `channelId` is a text or voice channel in the server (Discord accepts activity
 * invites in both).
 */
export async function createActivityInvite(
  guildId: string,
  channelId: string,
): Promise<ActivityInvite> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/guilds/${guildId.trim()}/activity-invite`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channelId.trim() }),
    });
  } catch {
    throw new GuildApiError("Couldn't reach the server. Check your connection.", 0);
  }
  if (!res.ok) throw await toApiError(res);
  try {
    return (await res.json()) as ActivityInvite;
  } catch {
    throw new GuildApiError("The server returned an unexpected response.", res.status);
  }
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
  /** Paused because the server is over its current plan cap: the grant is kept
   *  but its components expire normally until the server re-upgrades. Absent on
   *  responses from a deployment without plan enforcement. */
  suspended?: boolean;
}

/** A cap the proxy sends to mean "unlimited" (matches `UNLIMITED_SLOTS` in
 *  `server/src/entitlement.rs`) — a Pro tier. Rendered as "Unlimited" rather
 *  than the raw number. */
export const UNLIMITED_CAP = 1_000_000;

/** True when a slot/registration cap is effectively unlimited. */
export function isUnlimitedCap(cap: number): boolean {
  return cap >= UNLIMITED_CAP;
}

/** A server's permanent-slot state, as every slot endpoint returns it. */
export interface PermanentSlots {
  /** Slots the server may hold. */
  cap: number;
  /** Active grants (counts against `cap`). Excludes suspended ones. */
  used: number;
  /** Grants paused because the server is over its plan cap — kept, not counted.
   *  Absent when the deployment has no plan enforcement. */
  suspended?: number;
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

// ── Custom bots (bring your own Discord app) ───────────────────────────────
// A server may register its own Discord application so the DWEEB interactions
// dispatcher serves it too: components on messages sent by *their* bot then
// work through DWEEB's plugins. Each server gets a quota of registrations
// (default 1 — the `cap` in every response is the source of truth, never
// hardcode it).

/** One registered custom app. */
export interface CustomBotItem {
  application_id: string;
  /** The app's name, resolved from Discord at registration; empty when the
   *  lookup didn't pan out (an update retries it). */
  name: string;
  /** Unix millis when it was registered. */
  added_at: number;
  /** Whether a client secret is stored (encrypted) — what enables the
   *  one-click "create webhook from this bot" option in the Send dialog. */
  has_secret: boolean;
  /** Whether the dispatcher has ever received a validly-signed interaction for
   *  this app — i.e. the owner finished pointing its Interactions Endpoint URL
   *  back at DWEEB with the right public key. Drives the "Connected" status. */
  verified: boolean;
  /** Paused because the server is over its current plan cap: the registration is
   *  kept but its bot's interactions stop being served until the server
   *  re-upgrades. Absent without plan enforcement. */
  suspended?: boolean;
}

/** A server's custom-bot state, as every custom-bot endpoint returns it. */
export interface CustomBots {
  /** Registrations the server may hold. */
  cap: number;
  /** Active registrations (counts against `cap`). Excludes suspended ones. */
  used: number;
  /** Registrations paused because the server is over its plan cap. Absent when
   *  the deployment has no plan enforcement. */
  suspended?: number;
  items: CustomBotItem[];
}

/** Outcome of a register: both refusals carry the current state so the UI can
 *  explain (`quota_full` — free a registration first; `app_taken` — that app
 *  already belongs to another server). */
export type CustomBotAddResult =
  | { ok: true; bots: CustomBots }
  | { ok: false; reason: "quota_full" | "app_taken"; bots: CustomBots };

/** `GET /api/guilds/:id/custom-apps` — quota usage + registered apps. A 501
 *  means the deployment doesn't run the feature; callers hide the UI on it. */
export async function fetchCustomBots(guildId: string, signal?: AbortSignal): Promise<CustomBots> {
  const id = guildId.trim();
  if (!isValidGuildId(id)) {
    throw new GuildApiError("That doesn't look like a valid server ID.", 0);
  }
  return getJson<CustomBots>(`/api/guilds/${id}/custom-apps`, signal);
}

/** `POST /api/guilds/:id/custom-apps` — register the server's own app.
 *  The display name isn't sent: the server fetches the app's real name from
 *  Discord. The client secret is sealed server-side at rest and never
 *  returned; it's what makes webhook creation from this bot a single click
 *  later. Re-registering the same app updates key/secret in place (the fix
 *  path for a mistyped value) without spending a new quota slot. */
export async function addCustomBot(
  guildId: string,
  applicationId: string,
  publicKey: string,
  clientSecret: string,
): Promise<CustomBotAddResult> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/guilds/${guildId.trim()}/custom-apps`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        application_id: applicationId.trim(),
        public_key: publicKey.trim(),
        client_secret: clientSecret.trim(),
      }),
    });
  } catch {
    throw new GuildApiError("Couldn't reach the server. Check your connection.", 0);
  }
  // 409 = refused but explainable — the body carries why and the current state.
  if (res.status === 409) {
    try {
      const body = (await res.json()) as CustomBots & { error?: string };
      const reason = body.error === "app_taken" ? "app_taken" : "quota_full";
      return { ok: false, reason, bots: body };
    } catch {
      throw new GuildApiError("The server returned an unexpected response.", res.status);
    }
  }
  if (!res.ok) throw await toApiError(res);
  try {
    return { ok: true, bots: (await res.json()) as CustomBots };
  } catch {
    throw new GuildApiError("The server returned an unexpected response.", res.status);
  }
}

/** `DELETE /api/guilds/:id/custom-apps/:applicationId` — unregister. A 404
 *  (already gone) is treated as success: the goal state is reached either
 *  way, so the fresh list is fetched and returned. */
export async function removeCustomBot(guildId: string, applicationId: string): Promise<CustomBots> {
  let res: Response;
  try {
    res = await fetch(
      `${PROXY_BASE_URL}/api/guilds/${guildId.trim()}/custom-apps/${applicationId.trim()}`,
      { method: "DELETE", credentials: "include" },
    );
  } catch {
    throw new GuildApiError("Couldn't reach the server. Check your connection.", 0);
  }
  if (res.status === 404) return fetchCustomBots(guildId);
  if (!res.ok) throw await toApiError(res);
  try {
    return (await res.json()) as CustomBots;
  } catch {
    throw new GuildApiError("The server returned an unexpected response.", res.status);
  }
}

/**
 * `POST /api/guilds/:id/custom-apps/:applicationId/webhook` — start Discord's
 * `webhook.incoming` flow under one of the server's registered custom bots,
 * so the created webhook belongs to *their* app. One click: the secret was
 * stored (encrypted) at registration, so nothing is prompted here. Returns
 * the Discord authorize URL to navigate to; the webhook comes back through
 * the same `#dweeb_webhook=` fragment as the standard flow.
 *
 * Prerequisite (shown at registration): the proxy's `/auth/callback` URL must
 * be listed under the app's OAuth2 → Redirects in the Developer Portal.
 */
export async function createCustomBotWebhook(
  guildId: string,
  applicationId: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(
      `${PROXY_BASE_URL}/api/guilds/${guildId.trim()}/custom-apps/${applicationId.trim()}/webhook`,
      { method: "POST", credentials: "include" },
    );
  } catch {
    throw new GuildApiError("Couldn't reach the server. Check your connection.", 0);
  }
  if (!res.ok) throw await toApiError(res);
  try {
    const body = (await res.json()) as { url?: string };
    if (!body.url) throw new Error();
    return body.url;
  } catch {
    throw new GuildApiError("The server returned an unexpected response.", res.status);
  }
}

// ── Webhook management (Manage Webhooks gated) ─────────────────────────────
// The Webhook Manager: enumerate, recover, create, edit, move, delete, and
// rotate a server's webhooks through the shared bot's Manage Webhooks
// permission. Every call is gated server-side on the signed-in user *also*
// holding Manage Webhooks (or Administrator/owner) in the guild, mirroring
// Discord — so a 403 here means the user lacks that permission, or the bot does
// (the message distinguishes them). These are never cached: webhook tokens are
// credentials.

/** The member who created a webhook — only known because Manage Webhooks
 *  exposes it. `name` is the display name; `avatar` is a hash or null. */
export interface WebhookCreator {
  id: string;
  name: string;
  avatar: string | null;
}

/** One webhook as the proxy returns it (see `routes::webhook_json`). */
export interface GuildWebhook {
  id: string;
  /** 1 Incoming · 2 Channel Follower · 3 Application. */
  type: number;
  name: string | null;
  avatar: string | null;
  channel_id: string | null;
  guild_id: string | null;
  /** Owning app id when a bot/app made it; null for a person/follower webhook. */
  application_id: string | null;
  /** Ready-to-use execute URL — the recoverable credential. Incoming
   *  (type 1) webhooks only; null otherwise (no token exists to recover). */
  url: string | null;
  creator: WebhookCreator | null;
  /** Only on a rotate response when the old webhook couldn't be deleted. */
  rotate_warning?: string;
}

/** `GET /api/guilds/:id/webhooks` response. */
export interface GuildWebhooks {
  webhooks: GuildWebhook[];
  /** This deployment's own app id, so the FE can flag DWEEB-owned webhooks
   *  without trusting its build-time env to match the proxy. */
  dweeb_application_id: string;
}

/** `GET /api/guilds/:id/webhooks` — every webhook in the server, with recover
 *  URLs + creators. Throws `GuildApiError` (403 = the user, or the bot, lacks
 *  Manage Webhooks — the message says which). */
export async function fetchGuildWebhooks(
  guildId: string,
  signal?: AbortSignal,
): Promise<GuildWebhooks> {
  const id = guildId.trim();
  if (!isValidGuildId(id)) {
    throw new GuildApiError("That doesn't look like a valid server ID.", 0);
  }
  const body = await getJson<GuildWebhooks>(`/api/guilds/${id}/webhooks`, signal);
  return { webhooks: body.webhooks ?? [], dweeb_application_id: body.dweeb_application_id ?? "" };
}

/** `POST /api/guilds/:id/channels/:channelId/webhooks` — create an incoming
 *  webhook in a channel. `avatar` is an image data URI or omitted for the
 *  default picture. Returns the created webhook (its `url` is the new token). */
export async function createGuildWebhook(
  guildId: string,
  channelId: string,
  name: string,
  avatar?: string,
): Promise<GuildWebhook> {
  return writeWebhook(
    `/api/guilds/${guildId.trim()}/channels/${channelId.trim()}/webhooks`,
    "POST",
    avatar ? { name, avatar } : { name },
  );
}

/** Fields a webhook edit may change. `avatar: null` clears the picture;
 *  `avatar: "data:image/…"` sets it; omitting `avatar` leaves it. `channelId`
 *  moves the webhook to another channel. */
export interface WebhookEdit {
  name?: string;
  avatar?: string | null;
  channelId?: string;
}

/** `PATCH /api/guilds/:id/webhooks/:webhookId` — rename / re-avatar / move.
 *  Sends only the provided fields; `avatar: null` is forwarded verbatim to
 *  clear the picture. */
export async function modifyGuildWebhook(
  guildId: string,
  webhookId: string,
  changes: WebhookEdit,
): Promise<GuildWebhook> {
  const body: Record<string, unknown> = {};
  if (changes.name !== undefined) body.name = changes.name;
  if (changes.avatar !== undefined) body.avatar = changes.avatar; // null clears
  if (changes.channelId !== undefined) body.channel_id = changes.channelId;
  return writeWebhook(`/api/guilds/${guildId.trim()}/webhooks/${webhookId.trim()}`, "PATCH", body);
}

/** `DELETE /api/guilds/:id/webhooks/:webhookId` — delete a webhook. A 404
 *  (already gone) is treated as success — the goal state is reached either way. */
export async function deleteGuildWebhook(guildId: string, webhookId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      `${PROXY_BASE_URL}/api/guilds/${guildId.trim()}/webhooks/${webhookId.trim()}`,
      { method: "DELETE", credentials: "include" },
    );
  } catch {
    throw new GuildApiError("Couldn't reach the server. Check your connection.", 0);
  }
  if (res.status === 404) return;
  if (!res.ok) throw await toApiError(res);
}

/** Shared POST/PATCH helper for the webhook writes — credentialed JSON call
 *  returning the webhook object, with the proxy's error shape normalised. */
async function writeWebhook(
  path: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown> | undefined,
): Promise<GuildWebhook> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}${path}`, {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GuildApiError("Couldn't reach the server. Check your connection.", 0);
  }
  if (!res.ok) throw await toApiError(res);
  try {
    return (await res.json()) as GuildWebhook;
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
