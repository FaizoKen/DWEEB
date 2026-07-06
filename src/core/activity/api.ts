/**
 * The two proxy calls unique to the embedded Activity: exchanging the SDK's
 * authorization code for an access token, and publishing the built message into
 * the Activity's channel (which a sandboxed iframe can't do against discord.com
 * directly). Both ride the shared `proxyFetch`, so the bearer token is attached
 * and the URL is remapped through Discord's proxy automatically.
 */

import { proxyFetch } from "@/core/net/proxyFetch";
import type { PermanentSlots, PlanInfo } from "@/core/guild/api";

/** Read the proxy's `{ error }` body for a failed call, with a sane fallback. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* non-JSON body — fall through */
  }
  return `Request failed (${res.status}).`;
}

/** `POST /api/activity/token` — exchange the SDK's authorization code for a
 *  Discord access token (the proxy holds the client secret). */
export async function exchangeCode(code: string): Promise<string> {
  let res: Response;
  try {
    res = await proxyFetch("/api/activity/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("The server returned an unexpected response.");
  return body.access_token;
}

/** Result of a successful publish/update: the message + a jump link. `webhook_id`
 *  identifies the webhook that posted it, so a later edit targets exactly that
 *  one (see {@link editPostedMessage}); `application_id` names the custom bot it
 *  was posted as (null/absent = DWEEB), so the edit rides the same identity. */
export interface ActivityPostResult {
  message_id: string;
  channel_id: string;
  guild_id: string;
  url: string | null;
  webhook_id?: string;
  application_id?: string | null;
  /** True when a never-expire slot was claimed for this post (the user opted in
   *  and it succeeded). Absent/false on an ordinary post. */
  permanent?: boolean;
  /** A user-facing reason the requested never-expire claim couldn't be granted
   *  (e.g. all slots full) — null/absent when there was nothing to report. */
  permanent_error?: string | null;
}

/** `POST /api/activity/post` — post the built message into the channel. By
 *  default through a DWEEB-owned webhook (the proxy reuses or creates one);
 *  with `applicationId` set, through that custom bot's connected Activity
 *  webhook instead, so the message appears under the server's own bot. When
 *  `makePermanent` is set the proxy also spends a never-expire slot on the new
 *  message (best-effort; reported back via `permanent` / `permanent_error`). */
export async function publishToChannel(
  guildId: string,
  channelId: string,
  message: unknown,
  makePermanent = false,
  applicationId: string | null = null,
): Promise<ActivityPostResult> {
  let res: Response;
  try {
    res = await proxyFetch("/api/activity/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guild_id: guildId,
        channel_id: channelId,
        message,
        make_permanent: makePermanent,
        application_id: applicationId ?? "",
      }),
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ActivityPostResult;
}

/** One identity the Activity can post as: DWEEB itself, or a registered custom
 *  bot. A custom bot is pickable when `ready` (its Activity webhook is
 *  connected); otherwise `can_connect` says whether the one-time connect flow
 *  is available (a client secret is on file — without it, registering again on
 *  the web with the secret is the fix). */
export type ActivityIdentity =
  | { kind: "dweeb" }
  | {
      kind: "custom";
      application_id: string;
      name: string;
      ready: boolean;
      can_connect: boolean;
    };

/** `GET /api/activity/identities` — who the Activity can post as in the
 *  destination server. Always includes DWEEB; custom bots appear when the
 *  server has registered any. Gated like the post itself (Manage Webhooks). */
export async function fetchActivityIdentities(
  guildId: string,
  signal?: AbortSignal,
): Promise<ActivityIdentity[]> {
  let res: Response;
  try {
    res = await proxyFetch(`/api/activity/identities?guild_id=${encodeURIComponent(guildId)}`, {
      signal,
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  const body = (await res.json()) as { identities?: ActivityIdentity[] };
  return body.identities ?? [{ kind: "dweeb" }];
}

/** `POST /api/activity/connect-bot` — mint the authorize URL for the one-time
 *  "connect your bot" flow. The caller opens it externally (the sandboxed
 *  iframe can't navigate to discord.com); once the user approves, the proxy
 *  captures the webhook server-side and pushes a `bot_connected` frame into
 *  this `instanceId`'s collab room, so the dialog selects the bot the instant
 *  OAuth completes (it also flips `ready` in {@link fetchActivityIdentities}
 *  as a fallback). */
export async function startConnectCustomBot(
  guildId: string,
  applicationId: string,
  instanceId: string,
): Promise<string> {
  let res: Response;
  try {
    res = await proxyFetch("/api/activity/connect-bot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guild_id: guildId,
        application_id: applicationId,
        instance_id: instanceId,
      }),
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  const body = (await res.json()) as { url?: string };
  if (!body.url) throw new Error("The server returned an unexpected response.");
  return body.url;
}

/** `GET /api/activity/permanent` — never-expire slot usage for the destination
 *  guild, so the pre-post confirm can offer the "Never expire" toggle. The
 *  bearer-gated twin of the web app's `/api/guilds/:id/permanent`; returns the
 *  same `{ cap, used, ttl_days, items }` shape. Throws `{ status: 501 }` when the
 *  feature is off on this deployment — callers hide the toggle on it. */
export async function fetchActivityPermanentSlots(
  guildId: string,
  signal?: AbortSignal,
): Promise<PermanentSlots> {
  let res: Response;
  try {
    res = await proxyFetch(`/api/activity/permanent?guild_id=${encodeURIComponent(guildId)}`, {
      signal,
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) {
    const err = new Error(await errorMessage(res)) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as PermanentSlots;
}

/** `GET /api/activity/plan` — the destination server's tier + per-feature limits,
 *  for the Activity's quiet plan indicator. The bearer-gated twin of the web
 *  app's `/api/guilds/:id/plan`; returns the same `{ tier, limits, billing }`
 *  shape. Resolves to null on any failure (feature off, not a member, network) —
 *  the caller simply hides the indicator, so it never blocks the builder. */
export async function fetchActivityPlan(
  guildId: string,
  signal?: AbortSignal,
): Promise<PlanInfo | null> {
  try {
    const res = await proxyFetch(`/api/activity/plan?guild_id=${encodeURIComponent(guildId)}`, {
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as PlanInfo;
  } catch {
    return null;
  }
}

/** Result of a successful restore: the raw Discord message to decode into the
 *  editor, plus the same identifiers a {@link ActivityPostResult} carries so a
 *  follow-up edit can target the restored message in place. */
export interface ActivityRestoreResult extends ActivityPostResult {
  /** The raw Discord message object — decode it with `attachEditorFields`. */
  message: unknown;
}

/** `POST /api/activity/restore` — pull a message DWEEB posted in the channel back
 *  out of Discord. Unlike the web app's Restore, no webhook URL is needed: the
 *  proxy resolves the DWEEB-owned webhook from the channel, so the caller supplies
 *  only a message id. A 404 means the id isn't a message DWEEB posted here. */
export async function restorePostedMessage(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<ActivityRestoreResult> {
  let res: Response;
  try {
    res = await proxyFetch("/api/activity/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guild_id: guildId, channel_id: channelId, message_id: messageId }),
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ActivityRestoreResult;
}

/** `POST /api/activity/edit` — PATCH a message previously posted from this
 *  Activity, through the same webhook that authored it. `webhookId` names the
 *  exact webhook (from the original post); `applicationId` names the custom bot
 *  the message was posted as (null = DWEEB), so the proxy edits through that
 *  bot's connected Activity webhook. Either way the webhook is re-verified
 *  server-side before the edit. */
export async function editPostedMessage(
  guildId: string,
  channelId: string,
  messageId: string,
  webhookId: string,
  message: unknown,
  applicationId: string | null = null,
): Promise<ActivityPostResult> {
  let res: Response;
  try {
    res = await proxyFetch("/api/activity/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guild_id: guildId,
        channel_id: channelId,
        message_id: messageId,
        webhook_id: webhookId,
        application_id: applicationId ?? "",
        message,
      }),
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ActivityPostResult;
}
