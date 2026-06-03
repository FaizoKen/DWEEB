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
 * OAuth URL to add the DWEEB bot to a server. `permissions=0` because reading
 * roles/channels/emojis needs no privileged permissions. Empty when no client
 * id is configured (the caller hides the CTA in that case).
 */
export function botInviteUrl(): string {
  if (!DISCORD_CLIENT_ID) return "";
  return `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&scope=bot&permissions=0`;
}
