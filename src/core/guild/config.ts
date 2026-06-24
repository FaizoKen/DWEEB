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
 *
 * OAuth round-trips (login, add-bot, webhook creation) run in popups via the
 * shared engine in `core/oauth` — this module only builds the URLs they navigate
 * to and the shared bot-permission constants.
 */

/** Proxy origin, trailing slashes stripped so we can append paths cleanly. */
export const PROXY_BASE_URL: string = (import.meta.env.VITE_PROXY_BASE_URL ?? "")
  .trim()
  .replace(/\/+$/, "");

/** Discord application (client) id — public; used only for the bot-invite link. */
export const DISCORD_CLIENT_ID: string = (import.meta.env.VITE_DISCORD_CLIENT_ID ?? "").trim();

/**
 * Days a message's interactive components stay clickable after sending before
 * the dispatcher stops answering them — unless the message holds a never-expire
 * slot. Mirrors the dispatcher's `COMPONENT_TTL_DAYS` (default 7; `0` = never
 * expires). Build-time so a signed-out user — who can't fetch the live slot
 * state, where the authoritative number comes from — can still be told the
 * concrete figure before posting. `null` when the deployment disables expiry
 * (`0`) or the value is unusable; callers then show no expiry copy. Keep
 * `VITE_COMPONENT_TTL_DAYS` aligned with the dispatcher's setting.
 */
export const COMPONENT_TTL_DAYS: number | null = (() => {
  const raw = (import.meta.env.VITE_COMPONENT_TTL_DAYS ?? "").trim();
  if (raw === "") return 7; // unset → the dispatcher's own default
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 7; // garbage → fall back to default
  return n === 0 ? null : n; // 0 = never expires on this deployment
})();

/** True when a proxy base URL is configured — guild features are usable. */
export function isProxyConfigured(): boolean {
  return PROXY_BASE_URL.length > 0;
}

/** Where the browser is sent to begin the Discord login flow. */
export function loginUrl(): string {
  return isProxyConfigured() ? `${PROXY_BASE_URL}/auth/login` : "";
}

/**
 * Where the browser is sent to create a webhook via Discord's `webhook.incoming`
 * flow. Discord shows its own channel picker, creates an app-owned webhook, and
 * the proxy redirects back with its URL in the fragment (read by the webhook
 * flow in `core/oauth`). The bot needs no permissions — the user authorizes the
 * webhook for a channel they manage.
 *
 * Pass `guildId` to pre-select that server in Discord's picker (the proxy
 * forwards it as `guild_id`). The user can still switch servers and must hold
 * Manage Server there; an id they can't use just falls back to the full picker.
 */
export function webhookCreateUrl(guildId?: string): string {
  const base = `${PROXY_BASE_URL}/auth/webhook`;
  const gid = guildId?.trim();
  return gid ? `${base}?guild_id=${encodeURIComponent(gid)}` : base;
}

/**
 * The Interactions Endpoint URL a server owner pastes into THEIR OWN app's
 * settings when registering it as a custom bot — the DWEEB dispatcher.
 * `VITE_INTERACTIONS_URL` names it explicitly (e.g. the dedicated
 * `https://interactions.<plugins-domain>` hostname); without it we fall back
 * to the proxy's `/interactions` alias, which the bundled Caddyfile rewrites
 * to the dispatcher. Empty when no proxy is configured (callers hide the UI).
 */
export function interactionsEndpointUrl(): string {
  const explicit = (import.meta.env.VITE_INTERACTIONS_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  return PROXY_BASE_URL ? `${PROXY_BASE_URL}/interactions` : "";
}

/**
 * The OAuth2 redirect URI a server owner must add under their own app's
 * Redirects before "Create webhook with your bot" can work — the proxy's
 * callback, shared with every other OAuth flow here.
 */
export function oauthCallbackUrl(): string {
  return PROXY_BASE_URL ? `${PROXY_BASE_URL}/auth/callback` : "";
}

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
 * Permission bits the shared DWEEB bot must request on EVERY invite URL — both
 * here and in each plugin that adds the same bot (e.g. self-role).
 *
 * Discord's bot invite is destructive on re-authorization: adding the bot to a
 * guild sets its integration-managed role to *exactly* the `permissions` value
 * in the URL — it replaces, it never merges. Because the bot is shared and a
 * single message can mix plugins with different needs, an invite that asked for
 * less than the full set would strip the permissions the other plugins rely on
 * (e.g. re-inviting through a `permissions=0` link wipes self-role's Manage
 * Roles). So every invite URL requests the SAME union and re-inviting is
 * idempotent.
 *
 * The base is 0 — the bot's own read features (roles/channels/emojis) and the
 * builder's default `webhook.incoming` creation flow need no privileged
 * permission. Each bit below is here because a bundled feature requires it; add
 * a line as new ones land.
 *
 * Keep this aligned with any plugin that builds its own invite — self-role and
 * the other plugins mirror this value (`SHARED_BOT_PERMISSIONS` in their
 * `src/config.rs`). Bump all of them together.
 */
const SHARED_BOT_PERMISSION_BITS = {
  /** tickets — creates/deletes the per-ticket channel (`POST/DELETE …/channels`). */
  MANAGE_CHANNELS: 1n << 4n,
  /**
   * self-role — assigns/removes roles (`PUT …/members/{user}/roles/{role}`).
   * Also what tickets needs to set a ticket channel's permission overwrites.
   */
  MANAGE_ROLES: 1n << 28n,
  /**
   * Webhook auto-detect — the proxy enumerates a server's webhooks (with each
   * incoming webhook's recover URL) and creates new ones through this shared
   * bot. Listing a guild's webhooks (`GET /guilds/{id}/webhooks`) is the one
   * Discord call that hard-requires it; create needs it too. This powers the
   * Send/Restore webhook picker, where a manager chooses or creates a webhook in
   * a click instead of pasting a URL. The no-permission `webhook.incoming` OAuth
   * flow stays available for minting app-owned webhooks (so plugin components
   * route their clicks back to DWEEB).
   */
  MANAGE_WEBHOOKS: 1n << 29n,
} as const;

/**
 * The union of {@link SHARED_BOT_PERMISSION_BITS}, as the decimal string
 * Discord's `permissions=` query parameter expects. Computed with BigInt
 * because Discord permission bits run past 2^31, where JS `|` would overflow.
 */
export const SHARED_BOT_PERMISSIONS: string = Object.values(SHARED_BOT_PERMISSION_BITS)
  .reduce((acc, bit) => acc | bit, 0n)
  .toString();

/**
 * OAuth URL to add the DWEEB bot to a server, requesting
 * {@link SHARED_BOT_PERMISSIONS} (the full union every invite must carry — see
 * there for why). The builder's per-message webhook creation still offers
 * Discord's no-permission `webhook.incoming` flow (see `webhookCreateUrl`); the
 * Manage Webhooks bit in the union powers the Send/Restore webhook picker
 * (auto-detect existing webhooks + one-click create). Empty when no client id is
 * configured (the caller hides the CTA in that case).
 *
 * When run in the browser we send the user back to the site after they add the
 * bot (`response_type=code` + `redirect_uri`), so the freshly added server can
 * be picked up. The redirect target is the current origin, which must be
 * registered as an OAuth2 redirect URI in the Discord Developer Portal — an
 * unregistered URI makes Discord reject the invite, so we only attach it when an
 * origin is available. (The add-bot popup flow reads the returned `guild_id`
 * from that redirect's query; see `core/oauth/flows`.)
 *
 * Pass `guildId` to pre-select that server in Discord's "Add to Server" picker —
 * used by the re-invite prompts that target the *connected* guild (e.g. granting
 * the bot Manage Webhooks there). It's a pre-selection, not a lock; the generic
 * "Add to another server" CTA omits it so the user chooses freely.
 */
export function botInviteUrl(guildId?: string): string {
  if (!DISCORD_CLIENT_ID) return "";
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    scope: "bot",
    permissions: SHARED_BOT_PERMISSIONS,
  });
  const origin = typeof window !== "undefined" ? window.location?.origin : "";
  if (origin) {
    params.set("response_type", "code");
    params.set("redirect_uri", origin);
  }
  const gid = guildId?.trim();
  if (gid) params.set("guild_id", gid);
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/**
 * OAuth URL to add a server's OWN registered custom bot to that server —
 * optional, since DWEEB drives the app through its webhook and interaction
 * responses (not its bot token), so it works without ever joining. Adding it
 * just lists the bot in the member roster and surfaces its own commands.
 *
 * Hence **no privileged permissions** (`permissions=0`): the custom app holds
 * none of the plugin work — self-role/tickets act under the shared DWEEB bot's
 * token — so requesting Manage Roles/Channels here would be cosmetic and
 * misleading. `applications.commands` lets its installed command set appear.
 * No `redirect_uri` is attached: the site origin isn't a registered redirect on
 * the custom app, so Discord would reject the invite — the user just gets
 * Discord's own "added" confirmation instead of a bounce back here.
 *
 * Pass `guildId` to pre-select that server in Discord's "Add to Server" picker
 * (the dialog is always opened for a specific server). It's a pre-selection,
 * not a lock — the user can still switch, and one they can't manage falls back
 * to the full picker.
 */
export function customBotInviteUrl(applicationId: string, guildId?: string): string {
  const id = applicationId.trim();
  if (!id) return "";
  const params = new URLSearchParams({
    client_id: id,
    scope: "bot applications.commands",
    permissions: "0",
  });
  const gid = guildId?.trim();
  if (gid) params.set("guild_id", gid);
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
