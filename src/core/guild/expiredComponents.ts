/**
 * Offer to turn back on the components a message lost to the expiry gate.
 *
 * A message read back from Discord keeps every `disabled` flag it has, and the
 * flag doesn't say who set it: the dispatcher when a click arrived past the TTL,
 * or the author. Restoring an expired message and posting it again therefore
 * posts its buttons dead. The proxy's never-expire revive used to hide that,
 * clearing every `disabled` seconds after a post, which also switched authors'
 * disabled buttons back on — so that revive now only touches messages past the
 * TTL (`could_have_expired`), and this is what takes care of the repost.
 *
 * Only the person loading the message can tell a dead button from a deliberate
 * "Sold out", so nothing is changed without asking. Same test as the proxy's:
 * old enough to have expired, and something a click can reach.
 */

import { walk, type EditorId, type WebhookMessage } from "@/core/schema";
import { useMessageStore } from "@/core/state/messageStore";
import { messageSentAt } from "@/lib/snowflake";
import { pushToast } from "@/ui/Toast";
import { COMPONENT_TTL_DAYS } from "./config";

const DAY_MS = 86_400_000;

/** The disabled components of `message` that the expiry gate could have disabled. */
export function possiblyExpiredIds(
  message: WebhookMessage,
  messageId: string,
  nowMs: number,
  ttlDays: number | null,
): EditorId[] {
  const sentAt = messageSentAt(messageId);
  if (ttlDays === null || sentAt === null) return [];
  if (nowMs - sentAt.getTime() < ttlDays * DAY_MS) return [];
  const ids: EditorId[] = [];
  for (const node of walk(message)) {
    if ("custom_id" in node && node.custom_id && "disabled" in node && node.disabled) {
      ids.push(node._id);
    }
  }
  return ids;
}

/** After a message from Discord (`messageId`) loads into the editor: offer to
 *  turn its possibly expired components back on. Silent when there are none. */
export function offerToEnableExpired(messageId: string): void {
  const { message, enableComponents } = useMessageStore.getState();
  const ids = possiblyExpiredIds(message, messageId, Date.now(), COMPONENT_TTL_DAYS);
  if (ids.length === 0) return;
  const one = ids.length === 1;
  pushToast(
    one
      ? "This message has a disabled button or menu, probably from expiring."
      : `This message has ${ids.length} disabled buttons or menus, probably from expiring.`,
    "info",
    {
      action: { label: one ? "Turn it on" : "Turn them on", onClick: () => enableComponents(ids) },
    },
  );
}
