/** First millisecond of 2015 — the epoch Discord snowflakes count from. */
const DISCORD_EPOCH_MS = 1420070400000n;

/** When a message was sent, decoded from its snowflake id. Editing a message
 *  doesn't change its id, so this (plus the component TTL) is the true expiry
 *  anchor. Null when the id doesn't look like a snowflake. */
export function messageSentAt(messageId: string): Date | null {
  if (!/^\d{15,25}$/.test(messageId)) return null;
  return new Date(Number((BigInt(messageId) >> 22n) + DISCORD_EPOCH_MS));
}
