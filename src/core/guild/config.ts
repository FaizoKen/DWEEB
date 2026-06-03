/**
 * Proxy connection config, read once from Vite build-time env.
 *
 * The proxy base URL is injected at build time via `VITE_PROXY_BASE_URL` (see
 * `.env.example`). When it's unset the guild features stay dormant:
 * `isProxyConfigured()` is false, the Server-data panel doesn't render, and the
 * preview falls back to placeholder mentions — so a build without a proxy
 * behaves exactly as before.
 *
 * Access is gated by Discord login: the browser talks to the proxy with cookies
 * (`credentials: "include"`), and the proxy only returns a server's data to a
 * signed-in user who belongs to it. `VITE_DISCORD_CLIENT_ID` is the public
 * application id, used to build the "add the bot to your server" invite link.
 */

/** Proxy origin, trailing slashes stripped so we can append paths cleanly. */
export const PROXY_BASE_URL: string = (import.meta.env.VITE_PROXY_BASE_URL ?? "")
  .trim()
  .replace(/\/+$/, "");

/** Discord application (client) id — public; used only for the bot-invite link. */
export const DISCORD_CLIENT_ID: string = (import.meta.env.VITE_DISCORD_CLIENT_ID ?? "").trim();

/** True when a proxy base URL is configured — guild features are usable. */
export function isProxyConfigured(): boolean {
  return PROXY_BASE_URL.length > 0;
}

/** Where the browser is sent to begin the Discord login flow. */
export function loginUrl(): string {
  return `${PROXY_BASE_URL}/auth/login`;
}

/**
 * Where the browser is sent to create a webhook via Discord's `webhook.incoming`
 * flow. Discord shows its own channel picker, creates an app-owned webhook, and
 * the proxy redirects back with its URL in the fragment (see
 * `consumeIncomingWebhook`). The bot needs no permissions — the user authorizes
 * the webhook for a channel they manage.
 */
export function webhookCreateUrl(): string {
  return `${PROXY_BASE_URL}/auth/webhook`;
}

/** Fragment key the proxy uses to hand a freshly-created webhook URL back. */
const WEBHOOK_HASH_KEY = "dweeb_webhook";

/** A webhook handed back by the redirect: its URL plus best-effort destination
 *  names (the proxy resolves these via the bot, so they're present even when the
 *  user isn't signed in — as long as the bot is in that server). */
export interface IncomingWebhook {
  url: string;
  channelName?: string;
  guildName?: string;
}

/** Result of reading the webhook redirect: a webhook, a failure, or "not a return". */
export type IncomingWebhookResult = IncomingWebhook | { error: true };

/**
 * Read — and immediately clear — the webhook handed back in the URL fragment
 * after the `webhook.incoming` redirect. Returns the execute URL (+ any resolved
 * channel/server names), an `error` marker (user backed out, or Discord returned
 * nothing), or null when this load isn't a webhook return. The fragment is wiped
 * right away so the credential doesn't linger in the address bar or browser
 * history; anything else in the fragment is preserved.
 */
export function consumeIncomingWebhook(): IncomingWebhookResult | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash || !hash.includes(WEBHOOK_HASH_KEY)) return null;

  const params = new URLSearchParams(hash.slice(1));
  const raw = params.get(WEBHOOK_HASH_KEY);
  if (raw === null) return null;
  const channelName = params.get("channel") || undefined;
  const guildName = params.get("guild") || undefined;

  for (const key of [WEBHOOK_HASH_KEY, "channel", "guild"]) params.delete(key);
  const rest = params.toString();
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}${rest ? `#${rest}` : ""}`);

  if (raw === "error" || raw === "") return { error: true };
  return { url: raw, channelName, guildName };
}

/**
 * OAuth URL to add the DWEEB bot to a server. `permissions=0` because reading
 * roles/channels/emojis needs no privileged permissions — and webhook creation
 * goes through Discord's `webhook.incoming` flow (see `webhookCreateUrl`), not
 * the bot, so the bot never needs Manage Webhooks. Empty when no client id is
 * configured (the caller hides the CTA in that case).
 *
 * When run in the browser we send the user back to the site after they add the
 * bot (`response_type=code` + `redirect_uri`), so a full reload picks up the
 * freshly added server. The redirect target is the current origin, which must
 * be registered as an OAuth2 redirect URI in the Discord Developer Portal — an
 * unregistered URI makes Discord reject the invite, so we only attach it when an
 * origin is available.
 */
export function botInviteUrl(): string {
  if (!DISCORD_CLIENT_ID) return "";
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    scope: "bot",
    permissions: "0",
  });
  const origin = typeof window !== "undefined" ? window.location?.origin : "";
  if (origin) {
    params.set("response_type", "code");
    params.set("redirect_uri", origin);
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
