/**
 * What the Update tab can honestly say about the message it's about to
 * overwrite.
 *
 * The tab used to show its target only as a raw snowflake ("Which message
 * should we update? 1551955152024371211"), so nothing on screen said *which*
 * message a PATCH would replace — and a PATCH replaces all of it. This gathers
 * whatever is actually known, from the sources that know it, and invents
 * nothing:
 *
 *  - **when it was posted** — every Discord id encodes its creation time;
 *  - **where** — a pasted link names the server and channel (a thread's id
 *    when it lives in one), the posted-history row records its channel, and
 *    the chosen webhook posts in one channel;
 *  - **what it says** — the last content this tab saw posted as, or restored
 *    from, that message; else the server library's posted-history row;
 *  - **whether the editor came from it** — the store's restore origin. When it
 *    didn't, the panel warns that the update overwrites what's posted.
 */

import { messageHeadline } from "@/core/schema/headline";
import type { WebhookMessage } from "@/core/schema/types";
import { parseMessageChannelId, parseMessageGuildId } from "@/core/webhook/send";

/** Discord's epoch (2015-01-01T00:00:00Z); a snowflake counts ms from it. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** When a Discord id was minted — for a message, when it was posted. */
export function snowflakeTime(id: string): number | null {
  if (!/^\d{15,25}$/.test(id)) return null;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/** "Sep 21, 2026, 3:04 PM" in the viewer's locale and zone. */
export function formatPostedAt(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      ms,
    );
  } catch {
    return new Date(ms).toLocaleString();
  }
}

// ── What this tab last saw posted ───────────────────────────────────────────

/** A handful is plenty: the Update tab only ever asks about recent posts. */
const MAX_REMEMBERED = 20;
const postedContent = new Map<string, WebhookMessage>();

/**
 * Remember the content a message was just posted, updated or restored with —
 * in memory, this tab only (it is the user's own message, never persisted).
 */
export function rememberPostedContent(messageId: string, message: WebhookMessage): void {
  postedContent.delete(messageId);
  postedContent.set(messageId, message);
  while (postedContent.size > MAX_REMEMBERED) {
    const oldest = postedContent.keys().next().value;
    if (oldest === undefined) break;
    postedContent.delete(oldest);
  }
}

export function postedContentFor(messageId: string): WebhookMessage | undefined {
  return postedContent.get(messageId);
}

// ── The summary ─────────────────────────────────────────────────────────────

export interface UpdateTargetSources {
  messageId: string;
  /** The raw field text — a pasted link carries the server and channel. */
  input: string;
  /** The thread field's value. */
  threadId: string;
  /** The editor's restore origin (a Restore, the last send, a library load). */
  origin: { messageId: string; guildId?: string; guildName?: string; threadId?: string } | null;
  /** The connected server's posted-history row for this message, if loaded. */
  library?: {
    guild_id: string;
    channel_id?: string | null;
    thread_id?: string | null;
    dest_label?: string | null;
  } | null;
  /** Where the chosen webhook posts, when known. */
  webhook: { guildId?: string; guildName?: string; channelId?: string; channelName?: string };
  /** The last known posted content. */
  content?: WebhookMessage | null;
  /** A channel's name, when the connected server knows it. */
  channelName?: (id: string) => string | undefined;
}

export interface UpdateTargetSummary {
  /** The posted content's first line, when known. */
  headline: string | null;
  postedAt: number | null;
  /** "#general", "a thread in #general", "a thread", or null. */
  where: string | null;
  guildName: string | null;
  /** A link to the message itself, when server + channel + id are all known. */
  discordUrl: string | null;
  /** The editor's content was loaded from, or last posted as, this message. */
  fromEditorOrigin: boolean;
}

export function describeUpdateTarget(src: UpdateTargetSources): UpdateTargetSummary {
  const fromOrigin = src.origin != null && src.origin.messageId === src.messageId;
  const origin = fromOrigin ? src.origin : null;
  const linkGuild = parseMessageGuildId(src.input);
  const linkChannel = parseMessageChannelId(src.input);

  const guildId =
    (linkGuild && linkGuild !== "@me" ? linkGuild : undefined) ??
    src.library?.guild_id ??
    origin?.guildId ??
    src.webhook.guildId;
  const threadId = src.threadId.trim() || src.library?.thread_id || origin?.threadId || undefined;
  // A link's channel segment is the thread when the message lives in one, so
  // it is the right segment for the link either way.
  const linkSegment = threadId ?? linkChannel ?? src.library?.channel_id ?? src.webhook.channelId;
  const discordUrl =
    guildId && linkSegment
      ? `https://discord.com/channels/${guildId}/${linkSegment}/${src.messageId}`
      : null;

  // The channel the message (or its thread) sits in: the library's record,
  // else the webhook's own channel — never a link segment, which may be a
  // thread and has no name we could look up.
  const parentChannelId = src.library?.channel_id ?? src.webhook.channelId;
  const parentName =
    (parentChannelId ? src.channelName?.(parentChannelId) : undefined) ??
    (parentChannelId === src.webhook.channelId ? src.webhook.channelName : undefined);
  let where: string | null;
  if (threadId) where = parentName ? `a thread in #${parentName}` : "a thread";
  else if (src.library?.dest_label?.trim()) where = src.library.dest_label.trim();
  else where = parentName ? `#${parentName}` : null;

  const guildName =
    (origin?.guildName && origin.guildId === guildId ? origin.guildName : undefined) ??
    (src.webhook.guildId === guildId ? src.webhook.guildName : undefined) ??
    null;

  return {
    headline: src.content ? messageHeadline(src.content).title : null,
    postedAt: snowflakeTime(src.messageId),
    where,
    guildName,
    discordUrl,
    fromEditorOrigin: fromOrigin,
  };
}
