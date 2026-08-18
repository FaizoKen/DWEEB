/**
 * Discord calls, on top of the web app's own webhook client.
 *
 * Everything here funnels into `core/webhook/send.ts` — the same module the
 * browser uses — so a message posted through MCP is byte-for-byte the message
 * the editor would have posted: same wire payload, same `?with_components=true`,
 * same `flags`, same error phrasing. Only two things are added:
 *
 *  - a **deadline** on every request. The browser can leave a fetch hanging
 *    behind a spinner; a stdio server cannot, because the client is blocked on
 *    the response and has no way to see progress.
 *  - a **webhook metadata cache**, so `send_message` can hand back a real jump
 *    link (`discord.com/channels/<guild>/<channel>/<message>`) without paying a
 *    second round-trip on every post. It is looked up once per destination and
 *    is strictly best-effort — a failure costs the link, never the send.
 *
 * Deleting a posted message is the one operation the app never needed, so it
 * is implemented here, deliberately reusing the app's `describeError` so its
 * failures read like every other Discord failure.
 */

import {
  describeError,
  fetchWebhookMessage,
  sendToWebhook,
  updateWebhookMessage,
  verifyWebhook,
  classifyWebhookOwner,
  webhookAvatarHash,
  webhookAvatarUrl,
  webhookChannelId,
  webhookGuildId,
  type FetchResult,
  type ParsedWebhookUrl,
  type SendResult,
  type VerifyResult,
} from "@/core/webhook/send";
import type { WebhookMessage } from "@/core/schema/types";

export interface CallOptions {
  timeoutMs: number;
  threadId?: string;
}

/** Every call carries its own deadline; nothing here may hang. */
function deadline(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export function send(
  parsed: ParsedWebhookUrl,
  message: WebhookMessage,
  options: CallOptions,
): Promise<SendResult> {
  return sendToWebhook(parsed, message, {
    threadId: options.threadId,
    // `wait` is always on: without it Discord answers 204 with no body, and the
    // caller learns neither the message id (needed to edit or delete it later)
    // nor whether the message actually rendered.
    wait: true,
    signal: deadline(options.timeoutMs),
  });
}

export function update(
  parsed: ParsedWebhookUrl,
  messageId: string,
  message: WebhookMessage,
  options: CallOptions,
): Promise<SendResult> {
  return updateWebhookMessage(parsed, messageId, message, {
    threadId: options.threadId,
    signal: deadline(options.timeoutMs),
  });
}

export function fetchMessage(
  parsed: ParsedWebhookUrl,
  messageId: string,
  options: CallOptions,
): Promise<FetchResult> {
  return fetchWebhookMessage(parsed, messageId, {
    threadId: options.threadId,
    signal: deadline(options.timeoutMs),
  });
}

export function verify(parsed: ParsedWebhookUrl, options: CallOptions): Promise<VerifyResult> {
  return verifyWebhook(parsed, { signal: deadline(options.timeoutMs) });
}

export type DeleteResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Delete a message this webhook posted. Same authorization rule as fetch and
 * update: the token proves the right to touch its own messages and nothing
 * else, so Discord 404s for anyone else's.
 */
export async function deleteMessage(
  parsed: ParsedWebhookUrl,
  messageId: string,
  options: CallOptions,
): Promise<DeleteResult> {
  const url = new URL(`${parsed.url}/messages/${encodeURIComponent(messageId)}`);
  if (options.threadId) url.searchParams.set("thread_id", options.threadId);

  let res: Response;
  try {
    res = await fetch(url.toString(), { method: "DELETE", signal: deadline(options.timeoutMs) });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: `Couldn't reach Discord: ${(e as Error).message}`,
    };
  }
  if (res.status === 204 || res.ok) return { ok: true };

  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { ok: false, status: res.status, error: describeError(res.status, body) };
}

/* ─── Webhook identity ───────────────────────────────────────────────── */

export interface WebhookInfo {
  id: string;
  name: string | null;
  channel_id: string | null;
  guild_id: string | null;
  avatar_url: string | null;
  owner: { kind: string; badge: string; label: string; application_id: string | null };
}

export function describeWebhook(id: string, webhook: Record<string, unknown>): WebhookInfo {
  const owner = classifyWebhookOwner(webhook);
  return {
    id,
    name: typeof webhook.name === "string" ? webhook.name : null,
    channel_id: webhookChannelId(webhook),
    guild_id: webhookGuildId(webhook),
    avatar_url: webhookAvatarHash(webhook)
      ? webhookAvatarUrl(id, webhookAvatarHash(webhook))
      : null,
    owner: {
      kind: owner.kind,
      badge: owner.badge,
      label: owner.label,
      application_id: owner.applicationId,
    },
  };
}

/**
 * Per-process cache of webhook metadata, keyed by webhook id. A webhook's
 * channel and guild do not change under a token (moving one needs Manage
 * Webhooks, which this server never has), so a single lookup per destination
 * holds for the life of the process.
 */
export class WebhookInfoCache {
  private readonly entries = new Map<string, WebhookInfo>();

  get(id: string): WebhookInfo | undefined {
    return this.entries.get(id);
  }

  set(info: WebhookInfo): void {
    this.entries.set(info.id, info);
  }

  /** Look up metadata, fetching it once. Returns null when the lookup fails —
   *  callers must treat the answer as a nicety, never a precondition. */
  async resolve(parsed: ParsedWebhookUrl, options: CallOptions): Promise<WebhookInfo | null> {
    const cached = this.entries.get(parsed.id);
    if (cached) return cached;
    const result = await verify(parsed, options);
    if (!result.ok) return null;
    const info = describeWebhook(parsed.id, result.webhook);
    this.entries.set(info.id, info);
    return info;
  }
}

/**
 * Build the client link that jumps to a posted message.
 *
 * Both ids are required. Discord's link format has a `@me` form for DMs, and
 * substituting it for a guild we simply failed to look up would hand back a
 * link that goes nowhere — worse than no link, because it looks like one. A
 * webhook always lives in a guild channel, so an absent guild id means the
 * lookup failed, not that the message is in a DM.
 */
export function messageLink(
  guildId: string | null | undefined,
  channelId: string | null | undefined,
  messageId: string,
): string | null {
  if (!guildId || !channelId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
