/**
 * The message to send when it goes into an existing thread: without the fields
 * that *start* a forum post (`thread_name`, `applied_tags`). A post can't both
 * open a new thread and go into one — Discord refuses the pair with 400 code
 * 220002 ("Webhooks posted to forum channels cannot have both a thread_name
 * and thread_id") — and a title left over in the draft is exactly that pair
 * once a post is picked. Returned unchanged when there is nothing to drop.
 *
 * Kept out of `send.ts` (and the `core/webhook` barrel) on purpose: that module
 * is on the home page's boot path, which has almost no budget left, while only
 * the Send panel needs this. The proxy applies the same rule to scheduled posts
 * and MCP sends (`discord::for_thread_target`).
 */

import type { WebhookMessage } from "@/core/schema/types";

export function forThreadTarget(
  message: WebhookMessage,
  threadId: string | null | undefined,
): WebhookMessage {
  if (!threadId?.trim()) return message;
  if (message.thread_name === undefined && message.applied_tags === undefined) return message;
  const out = { ...message };
  delete out.thread_name;
  delete out.applied_tags;
  return out;
}
