/**
 * Webhook URL parsing — the one piece of the webhook layer the editor needs at
 * boot. It lives apart from `send.ts` so that importing it doesn't pull the
 * send/verify/update/manage requests onto the boot path: Rollup places a whole
 * module in one chunk, so a parser sharing a file with them carried every one
 * into the critical bundle. `send.ts` re-exports it for the Share dialog.
 */

/** Discord limits us to webhooks under one of these origins. */
const WEBHOOK_HOST_RE =
  /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord(?:app)?)\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/i;

export interface ParsedWebhookUrl {
  /** Webhook snowflake. Useful for de-duping history entries. */
  id: string;
  /**
   * The canonical execute URL — origin + path with any trailing slash
   * removed. Query/fragment from the user's paste are dropped so we don't
   * accidentally inherit someone else's `?thread_id=` etc.
   */
  url: string;
}

export function parseWebhookUrl(input: string): ParsedWebhookUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Strip any query/fragment the user may have pasted.
  const noQuery = trimmed.split(/[?#]/, 1)[0]!;
  const m = WEBHOOK_HOST_RE.exec(noQuery);
  if (!m) return null;
  return { id: m[1]!, url: noQuery.replace(/\/$/, "") };
}
