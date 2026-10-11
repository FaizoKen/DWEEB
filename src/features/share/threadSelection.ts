/**
 * The rules behind the Send panel's thread picker, kept apart from the
 * component so they can be pinned by tests.
 */

import type { ChannelThread } from "@/core/guild/api";

/** Forum (15) and media (16) channels: every message lives in a post, so a
 *  webhook post needs either an existing post (`thread_id`) or a new post's
 *  title (`thread_name`) — Discord refuses one with neither. */
export function isForumType(type: number | null | undefined): boolean {
  return type === 15 || type === 16;
}

/** At this many threads the list gets a search box. */
export const THREAD_SEARCH_THRESHOLD = 8;

/** Threads whose name contains `query` (case-insensitive), or every thread. */
export function filterThreads(threads: ChannelThread[], query: string): ChannelThread[] {
  const q = query.trim().toLowerCase();
  if (!q) return threads;
  return threads.filter((t) => t.name.toLowerCase().includes(q) || t.id === q);
}

/**
 * Whether a send would post into a forum/media channel with neither a post to
 * reply in nor a title for a new one — the 400 Discord answers with "Webhooks
 * posted to forum channels must have a thread_name or thread_id". Only a new
 * post can hit it (an update edits a message that already lives in a post),
 * and only when the channel is known to be a forum.
 */
export function forumNeedsPost(opts: {
  mode: "new" | "update";
  channelType: number | null | undefined;
  threadId: string;
  postTitle: string | undefined;
}): boolean {
  return (
    opts.mode === "new" &&
    isForumType(opts.channelType) &&
    opts.threadId.trim() === "" &&
    (opts.postTitle ?? "").trim() === ""
  );
}

/** The short tags a thread row carries, in display order. */
export function threadTags(thread: ChannelThread, forum: boolean): string[] {
  const tags: string[] = [];
  if (thread.pinned) tags.push("Pinned");
  if (thread.locked) tags.push("Locked");
  else if (thread.archived) tags.push(forum ? "Closed" : "Archived");
  return tags;
}
