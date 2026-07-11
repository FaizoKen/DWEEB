/**
 * The two proxy calls unique to the embedded Activity: exchanging the SDK's
 * authorization code for an access token, and publishing the built message into
 * the Activity's channel (which a sandboxed iframe can't do against discord.com
 * directly). Both ride the shared `proxyFetch`, so the bearer token is attached
 * and the URL is remapped through Discord's proxy automatically.
 */

import { proxyFetch } from "@/core/net/proxyFetch";
import type { PermanentAddResult, PermanentSlots, PlanInfo } from "@/core/guild/api";
import type { CollectedFile } from "@/core/serialization/attachments";

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

/**
 * Build the request init for a proxy post/edit that may carry uploaded files.
 * Without files it's the plain JSON body the proxy has always accepted; with
 * files it becomes `multipart/form-data` — `payload_json` holding that same
 * JSON body plus `files[i]` parts — which the proxy parses and forwards to
 * Discord's webhook endpoint verbatim, mirroring the web builder's direct
 * multipart send. Content-Type is left unset on the multipart branch so the
 * browser stamps the boundary itself.
 */
function jsonOrMultipart(body: Record<string, unknown>, files: CollectedFile[]): RequestInit {
  if (files.length === 0) {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }
  const form = new FormData();
  form.append("payload_json", JSON.stringify(body));
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    form.append(`files[${i}]`, f.file, f.filename);
  }
  return { method: "POST", body: form };
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
 *  message (best-effort; reported back via `permanent` / `permanent_error`).
 *  `files` carries the message's in-session uploads (from
 *  `prepareMessagePayload`) — the call switches to multipart so the proxy can
 *  forward the bytes to Discord alongside the payload. */
export async function publishToChannel(
  guildId: string,
  channelId: string,
  message: unknown,
  makePermanent = false,
  applicationId: string | null = null,
  files: CollectedFile[] = [],
): Promise<ActivityPostResult> {
  let res: Response;
  try {
    res = await proxyFetch(
      "/api/activity/post",
      jsonOrMultipart(
        {
          guild_id: guildId,
          channel_id: channelId,
          message,
          make_permanent: makePermanent,
          application_id: applicationId ?? "",
        },
        files,
      ),
    );
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ActivityPostResult;
}

/** Result of a successful schedule: the stored schedule's id and when it fires
 *  (unix seconds — echo of the requested time, post-validation). */
export interface ActivityScheduleResult {
  id: string;
  next_run_at: number;
}

/** `POST /api/activity/schedule` — store the built message server-side and post
 *  it later (one-time), through the same DWEEB-owned webhook a live post rides.
 *  The proxy resolves the webhook itself — the iframe never sees credentials —
 *  and the schedule lands in the same store the web app's Scheduled tab manages.
 *  Always posts as DWEEB (a custom bot's roaming webhook could drift to another
 *  channel before the schedule fires). `makePermanent` asks the worker to spend
 *  a never-expire slot on the message once it's posted. */
export async function schedulePostToChannel(
  guildId: string,
  channelId: string,
  message: unknown,
  startAt: number,
  tz: string,
  destLabel?: string,
  makePermanent = false,
): Promise<ActivityScheduleResult> {
  let res: Response;
  try {
    res = await proxyFetch("/api/activity/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guild_id: guildId,
        channel_id: channelId,
        message,
        start_at: startAt,
        tz,
        dest_label: destLabel,
        make_permanent: makePermanent,
      }),
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ActivityScheduleResult;
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

/** `POST /api/activity/permanent` — spend a never-expire slot on a posted
 *  message, from the gallery's pin chip. The bearer twin of the web app's
 *  `addPermanentMessage`, with the same result shape: a 409 "all slots taken"
 *  isn't an error — it comes back as `{ full: true }` with the occupying slots
 *  so the UI can explain instead of dead-ending. */
export async function addActivityPermanentMessage(
  guildId: string,
  messageId: string,
  channelId: string,
): Promise<PermanentAddResult> {
  let res: Response;
  try {
    res = await proxyFetch("/api/activity/permanent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guild_id: guildId, message_id: messageId, channel_id: channelId }),
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (res.status === 409) {
    try {
      return { full: true, slots: (await res.json()) as PermanentSlots };
    } catch {
      throw new Error("The server returned an unexpected response.");
    }
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return { full: false, slots: (await res.json()) as PermanentSlots };
}

/** `DELETE /api/activity/permanent` — give a slot back, from the gallery's pin
 *  chip. The bearer twin of the web app's `removePermanentMessage`; a 404
 *  (already freed) is treated as success — the goal state is reached either
 *  way, so the fresh list is fetched and returned. */
export async function removeActivityPermanentMessage(
  guildId: string,
  messageId: string,
): Promise<PermanentSlots> {
  const qs = `guild_id=${encodeURIComponent(guildId)}&message_id=${encodeURIComponent(messageId)}`;
  let res: Response;
  try {
    res = await proxyFetch(`/api/activity/permanent?${qs}`, { method: "DELETE" });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (res.status === 404) return fetchActivityPermanentSlots(guildId);
  if (!res.ok) throw new Error(await errorMessage(res));
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
 *  server-side before the edit. `files` carries in-session uploads exactly as
 *  on {@link publishToChannel} — multipart when present. */
export async function editPostedMessage(
  guildId: string,
  channelId: string,
  messageId: string,
  webhookId: string,
  message: unknown,
  applicationId: string | null = null,
  files: CollectedFile[] = [],
): Promise<ActivityPostResult> {
  let res: Response;
  try {
    res = await proxyFetch(
      "/api/activity/edit",
      jsonOrMultipart(
        {
          guild_id: guildId,
          channel_id: channelId,
          message_id: messageId,
          webhook_id: webhookId,
          application_id: applicationId ?? "",
          message,
        },
        files,
      ),
    );
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ActivityPostResult;
}
