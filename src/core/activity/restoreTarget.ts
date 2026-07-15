/**
 * Work out what a Restore input means for the embedded Activity, whose posting
 * destination is a single channel in a fixed server (the launching guild — see
 * `core/activity/destination.test.ts`).
 *
 * The web app's Restore takes the webhook URL outright, so any channel/server is
 * fair game. Inside the Activity the proxy resolves the webhook from the *room's*
 * current channel — so a pasted message *link* can point somewhere the room isn't
 * aimed, and the four meanings need telling apart:
 *
 *   • the room's current channel (or a bare id) → read it straight away;
 *   • a *different* channel in this same server → offer to switch the room there
 *     first (only the channel moves — the server is fixed), then read it;
 *   • a thread under a channel (a forum/media post's link, whose channel segment
 *     is the thread id, or a thread under the current channel) → read the message
 *     inside that thread;
 *   • another server entirely → the fixed room can't follow it; that's the web
 *     app's job (via "Open on web").
 *
 * Without this, a link into a sibling channel was mistaken for a thread under the
 * current channel and handed to Discord as a `thread_id`, which answers "Unknown
 * Channel" — hence the switch-and-restore confirmation the dialog drives from the
 * `switch` verdict here. This only ever proposes moving the *channel*, never the
 * server.
 */

import {
  parseMessageChannelId,
  parseMessageGuildId,
  parseMessageIdInput,
} from "@/core/webhook/send";

export type RestorePlan =
  /** No usable message id in the input — nothing to do. */
  | { kind: "invalid" }
  /** A bare id, or a link already aimed at the room's current channel. */
  | { kind: "direct"; messageId: string }
  /** A link whose channel segment is a thread (a forum/media post). Read the
   *  message inside that thread of the room's current channel. */
  | { kind: "thread"; messageId: string; threadId: string }
  /** A link to a *different*, real channel in this same server — switch the room
   *  to it (with the user's confirmation) and read from there. */
  | { kind: "switch"; messageId: string; channelId: string }
  /** A link into a different server — the fixed room can't follow it. */
  | { kind: "foreign" };

export interface RestoreContext {
  /** The room's launching / destination server. */
  guildId: string;
  /** The channel the room currently posts to. */
  channelId: string;
  /** Whether `id` names a real channel in this server (from the guild store's
   *  channel list). Threads aren't in that list, which is exactly how a sibling
   *  channel (→ `switch`) is told apart from a thread id (→ `thread`). */
  isKnownChannel(id: string): boolean;
}

/**
 * Classify a Restore input against the room's fixed server + current channel.
 * Pure — the dialog supplies the live context and drives its confirm/error UI
 * off the verdict. See the module doc for the four cases.
 */
export function planRestore(input: string, ctx: RestoreContext): RestorePlan {
  const messageId = parseMessageIdInput(input);
  if (!messageId) return { kind: "invalid" };

  const linkChannelId = parseMessageChannelId(input);
  // A bare id carries no channel — restore from the room's current channel.
  if (!linkChannelId) return { kind: "direct", messageId };

  // A link into another server (a real guild id that isn't ours, or a DM's
  // `@me`): the room is bound to one server and can neither post nor read
  // anywhere else, so it can't follow the link here.
  const linkGuildId = parseMessageGuildId(input);
  if (linkGuildId && linkGuildId !== ctx.guildId) return { kind: "foreign" };

  // Already aimed at this exact channel → straight read, no switch.
  if (linkChannelId === ctx.channelId) return { kind: "direct", messageId };

  // A different, real channel in this server → propose switching to it.
  if (ctx.isKnownChannel(linkChannelId)) {
    return { kind: "switch", messageId, channelId: linkChannelId };
  }

  // Not a channel we know: it's a thread id (a forum/media post, or a thread
  // under the current channel). Read the message inside that thread.
  return { kind: "thread", messageId, threadId: linkChannelId };
}
