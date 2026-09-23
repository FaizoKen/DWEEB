/**
 * What a pasted message link says about the thread its message lives in — for
 * the web Restore tab, which reads a message through the webhook that posted it.
 *
 * A message link is `…/channels/<server>/<channel>/<message>`, and for a
 * message inside a thread or forum post Discord puts the *thread's* id in the
 * channel segment. A webhook reads its own messages from the channel it posts
 * in, and from a thread under it only when given that thread's id. So:
 *
 *  - a link whose channel segment is the webhook's own channel is a message in
 *    the channel itself, and must **not** be sent as a `thread_id` — Discord
 *    answers "Unknown Channel";
 *  - one whose segment is any other *regular* channel of the server isn't a
 *    thread either (threads never appear in the server's channel list — the
 *    same test the Activity's `planRestore` uses), so it also sends none; the
 *    read then fails with the usual "only messages this webhook posted";
 *  - any other segment, beside a webhook whose channel is known, is the thread;
 *  - with the webhook's channel still unknown it *may* be the thread: the
 *    Restore tab prefills it as such and settles it (one webhook GET) before
 *    reading, rather than guess.
 */

import { parseMessageChannelId } from "./send";

export type LinkThread =
  /** A bare id, or text that isn't a message link: nothing to infer. */
  | { kind: "none" }
  /** The message sits in a channel, not a thread: send no thread id. */
  | { kind: "channel"; channelId: string }
  /** The message lives in this thread (the webhook posts in another channel). */
  | { kind: "thread"; threadId: string }
  /** The webhook's channel isn't known yet: this is the thread if the two differ. */
  | { kind: "unknown"; threadId: string };

export function linkThread(
  input: string,
  context: {
    /** The channel the chosen webhook posts in, when known. */
    webhookChannelId?: string | null;
    /** Whether an id is a regular channel of the connected server. */
    isKnownChannel?: (id: string) => boolean;
  },
): LinkThread {
  const channelId = parseMessageChannelId(input);
  if (!channelId) return { kind: "none" };
  const { webhookChannelId, isKnownChannel } = context;
  if (channelId === webhookChannelId || isKnownChannel?.(channelId)) {
    return { kind: "channel", channelId };
  }
  return webhookChannelId
    ? { kind: "thread", threadId: channelId }
    : { kind: "unknown", threadId: channelId };
}

/** The thread id a link implies (what the Restore tab prefills), if any. */
export function linkThreadId(thread: LinkThread): string | null {
  return thread.kind === "thread" || thread.kind === "unknown" ? thread.threadId : null;
}
