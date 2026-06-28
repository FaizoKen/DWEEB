/**
 * The two proxy calls unique to the embedded Activity: exchanging the SDK's
 * authorization code for an access token, and publishing the built message into
 * the Activity's channel (which a sandboxed iframe can't do against discord.com
 * directly). Both ride the shared `proxyFetch`, so the bearer token is attached
 * and the URL is remapped through Discord's proxy automatically.
 */

import { proxyFetch } from "@/core/net/proxyFetch";

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
 *  identifies the DWEEB webhook that posted it, so a later edit targets exactly
 *  that one (see {@link editPostedMessage}). */
export interface ActivityPostResult {
  message_id: string;
  channel_id: string;
  guild_id: string;
  url: string | null;
  webhook_id?: string;
}

/** `POST /api/activity/post` — post the built message into the channel through a
 *  DWEEB-owned webhook (the proxy reuses or creates one). */
export async function publishToChannel(
  guildId: string,
  channelId: string,
  message: unknown,
): Promise<ActivityPostResult> {
  let res: Response;
  try {
    res = await proxyFetch("/api/activity/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guild_id: guildId, channel_id: channelId, message }),
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ActivityPostResult;
}

/** `POST /api/activity/edit` — PATCH a message previously posted from this
 *  Activity, through the same DWEEB-owned webhook. `webhookId` names the exact
 *  webhook to edit through (from the original post); the proxy still re-verifies
 *  it's DWEEB-owned in the channel before editing. */
export async function editPostedMessage(
  guildId: string,
  channelId: string,
  messageId: string,
  webhookId: string,
  message: unknown,
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
        message,
      }),
    });
  } catch {
    throw new Error("Couldn't reach DWEEB. Check your connection and try again.");
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ActivityPostResult;
}
