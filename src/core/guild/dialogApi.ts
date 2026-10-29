/**
 * Proxy calls only the lazy dialogs make — the Send panel (never-expire slots,
 * webhook create/edit/delete, a custom bot's webhook flow, the thread picker's
 * list), the message directory, and Collaborate's invite link.
 *
 * They share the request helpers and error shape of `./api` but live apart
 * from it because that client is on the boot path (sign-in, the server's
 * roles/channels/emoji, its plan) and Rollup places a module in one chunk
 * whole: sharing the file carried every one of these into the critical bundle.
 * `./api` re-exports the types, so type imports stay where they were.
 */

import { PROXY_BASE_URL } from "./config";
import {
  GuildApiError,
  getJson,
  isValidGuildId,
  toApiError,
  withFresh,
  type GuildWebhook,
} from "./api";

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
  // occupying messages so the UI can offer to free one. The one other 409,
  // `slot_taken`, means another server holds this message's slot: no slot of
  // ours would help, and only Message Info (which proves where the message
  // lives) can move it here.
  if (res.status === 409) {
    let body: PermanentSlots & { error?: string };
    try {
      body = (await res.json()) as PermanentSlots & { error?: string };
    } catch {
      throw new GuildApiError("The server returned an unexpected response.", res.status);
    }
    if (body.error === "slot_taken") {
      throw new GuildApiError(
        "Another server holds this message's never-expire slot. Run Message Info on the message in Discord to move the slot to this server.",
        res.status,
      );
    }
    return { full: true, slots: body };
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

// ── Custom bots ─────────────────────────────────────────────────────────────

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

/** One thread or forum post a webhook in its channel can post into (see
 *  `routes::channel_threads`). `type` 10 = announcement thread, 11 = public
 *  thread (forum and media posts are public threads). */
export interface ChannelThread {
  id: string;
  name: string;
  type: number;
  /** Closed (archived). A webhook post reopens it. */
  archived: boolean;
  /** Locked — only moderators can reopen or post in it. */
  locked: boolean;
  /** A forum's pinned post. */
  pinned: boolean;
}

/** `GET /api/guilds/:id/channels/:channelId/threads` response. */
export interface ChannelThreads {
  /** Open threads (pinned first, then newest activity), then recently
   *  archived ones. */
  threads: ChannelThread[];
  /** Older archived threads exist past the ones listed. */
  more_archived: boolean;
  /** False when the bot can't read this channel's archived threads, so only
   *  the open ones are listed. */
  archived_listed: boolean;
  /** The channel's own Discord type (15 forum, 16 media, …), or null from a
   *  proxy predating the field. */
  channel_type: number | null;
}

/** `GET /api/guilds/:id/channels/:channelId/threads` — the threads and forum
 *  posts this channel's webhooks can post into. Manage-Webhooks gated, like
 *  the webhook list. */
export async function fetchChannelThreads(
  guildId: string,
  channelId: string,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ChannelThreads> {
  const guild = guildId.trim();
  const channel = channelId.trim();
  if (!isValidGuildId(guild) || !isValidGuildId(channel)) {
    throw new GuildApiError("That doesn't look like a valid channel.", 0);
  }
  const body = await getJson<Partial<ChannelThreads>>(
    withFresh(`/api/guilds/${guild}/channels/${channel}/threads`, opts.force ?? false),
    opts.signal,
  );
  return {
    threads: Array.isArray(body.threads) ? body.threads : [],
    more_archived: body.more_archived === true,
    archived_listed: body.archived_listed !== false,
    channel_type: typeof body.channel_type === "number" ? body.channel_type : null,
  };
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
