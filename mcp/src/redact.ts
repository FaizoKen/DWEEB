/**
 * Credential scrubbing for everything the server says out loud.
 *
 * A Discord webhook URL *is* the credential — anyone holding
 * `…/webhooks/<id>/<token>` can post to that channel, rename the webhook, or
 * delete it, with no permission check and no way to revoke it short of
 * deleting the webhook. So the token must never reach a place it can be read
 * back later, and an MCP server's replies land in exactly such a place: the
 * conversation transcript, which is stored, replayed to the model, and often
 * synced to a vendor.
 *
 * Two leak paths exist and both are covered here:
 *  - the model passes a full webhook URL as a tool argument, and our own error
 *    text quotes it back ("no such webhook: https://…/<token>");
 *  - an upstream error body echoes the request URL.
 *
 * `redact` therefore runs over the *rendered* text of every tool result rather
 * than at each call site — a scrubber you have to remember to call is one you
 * will forget. The webhook id survives (it identifies the destination and is
 * public), only the token half is replaced.
 */

/**
 * Matches the token segment of any Discord webhook URL, in the same shapes
 * `parseWebhookUrl` accepts (`discord.com`, `discordapp.com`, `canary.`/`ptb.`
 * subdomains, optional `/v10` version segment).
 */
const WEBHOOK_TOKEN_RE =
  /(https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/)([\w-]+)/gi;

/** What a scrubbed token is replaced with. */
export const REDACTED = "[redacted]";

/**
 * Replace the token half of every webhook URL in `text`. Safe to run over
 * arbitrary output — text containing no webhook URL comes back unchanged.
 */
export function redact(text: string): string {
  return text.replace(WEBHOOK_TOKEN_RE, (_full, prefix: string) => `${prefix}${REDACTED}`);
}

/** True when `text` still carries a live webhook token. Used by the tests to
 *  assert the scrubber actually covers a given output path. */
export function hasWebhookToken(text: string): boolean {
  WEBHOOK_TOKEN_RE.lastIndex = 0;
  const found = WEBHOOK_TOKEN_RE.test(text);
  WEBHOOK_TOKEN_RE.lastIndex = 0;
  return found;
}
