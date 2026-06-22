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
/**
 * Non-destructive check for a pending webhook redirect — true when this load is
 * a `webhook.incoming` return, without clearing the fragment. Lets first-load
 * UX (e.g. the Template Gallery) stand down so it doesn't pop over the Send
 * panel that {@link consumeIncomingWebhook} is about to open.
 */
export function hasIncomingWebhook(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hash.includes(WEBHOOK_HASH_KEY);
}

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

/* ── `webhook.incoming` in a popup (so the builder isn't lost) ─────────────── */

// The OAuth webhook-create flow (`webhookCreateUrl` / a custom bot's authorize
// URL) historically replaced the whole page, throwing away the message the user
// was building until a reload pulled the result out of the fragment. Running it
// in a popup keeps the builder on screen.
//
// The hard part is that Discord's `oauth2/authorize` page swaps the popup into a
// new browsing-context group: that SEVERS the main window's `popup` handle (so
// polling it is useless — `popup.closed` reads true) AND nulls the popup's
// `window.opener`, and Discord also rewrites `window.name`. So neither the opener
// reference nor the handle nor the name can be relied on to recognise or reach
// the popup once it returns.
//
// What *does* survive a context-group swap is per-origin web storage. So we use a
// localStorage HANDSHAKE: the main window marks "a webhook popup is pending"
// before opening it; the returning popup recognises itself purely from that flag,
// and hands the result back over BOTH a BroadcastChannel and a localStorage
// `storage` event (each origin-global, swap-proof). The opener/name/poll paths
// are kept as fast best-effort extras. Browsers that block the popup fall back to
// a full-page redirect, so the flow always completes.

/** Both the BroadcastChannel name and the popup's `window.name`. */
const WEBHOOK_POPUP_NAME = "dweeb_webhook";

/** sessionStorage flag a tab sets on itself right before a *full-page* fallback
 *  redirect into the OAuth flow (popup blocked). It survives the same-tab
 *  navigation and tells the return "you redirected yourself — handle it in place,
 *  don't mistake yourself for a popup". Scoped to the tab, so a real popup never
 *  sees it. */
const WEBHOOK_SELF_REDIRECT_KEY = "dweeb_webhook_self_redirect";

/** localStorage handshake: timestamp the main window writes before opening the
 *  popup. The returning popup recognises itself by this (it survives the
 *  context-group swap that nulls opener/name). Origin-global, so it's only ever
 *  set while a popup flow is genuinely in flight, and is cleared promptly. */
const WEBHOOK_PENDING_KEY = "dweeb_webhook_pending";

/** localStorage delivery channel: the popup writes the result here; the main
 *  window's `storage` listener fires (storage events only fire in OTHER same-
 *  origin contexts) and applies it. A swap-proof companion to BroadcastChannel. */
const WEBHOOK_RESULT_KEY = "dweeb_webhook_result";

/** How long a pending-popup mark stays valid — long enough for a slow OAuth, short
 *  enough that an abandoned attempt can't haunt a later page load. */
const WEBHOOK_PENDING_TTL_MS = 10 * 60 * 1000;

/** Parse a webhook result out of a URL fragment string WITHOUT mutating the
 *  current location — used to read a *popup's* fragment from the main window, and
 *  by the popup to read its own without clearing it. */
function parseWebhookHash(hash: string): IncomingWebhookResult | null {
  if (!hash || !hash.includes(WEBHOOK_HASH_KEY)) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const raw = params.get(WEBHOOK_HASH_KEY);
  if (raw === null) return null;
  if (raw === "error" || raw === "") return { error: true };
  return {
    url: raw,
    channelName: params.get("channel") || undefined,
    guildName: params.get("guild") || undefined,
  };
}

/** Mark / unmark / test "a webhook popup is in flight" (the localStorage handshake). */
function markWebhookPopupPending(): void {
  try {
    localStorage.setItem(WEBHOOK_PENDING_KEY, String(Date.now()));
  } catch {
    /* storage blocked — opener/name detection still covers the common case */
  }
}
/** Clear the pending mark only — NOT the result. The result must outlive this so
 *  the main window's poll / storage listener can still pick it up; the consumer
 *  ({@link onWebhookPopupResult}) drops the result key once it has applied it. */
export function clearWebhookPopupPending(): void {
  try {
    localStorage.removeItem(WEBHOOK_PENDING_KEY);
  } catch {
    /* ignore */
  }
}
function webhookPopupPending(): boolean {
  try {
    const v = localStorage.getItem(WEBHOOK_PENDING_KEY);
    return v != null && Date.now() - Number(v) < WEBHOOK_PENDING_TTL_MS;
  } catch {
    return false;
  }
}

/** Hand a result back to the main window over every swap-proof channel we have. */
function deliverWebhookResult(result: IncomingWebhookResult): void {
  // BroadcastChannel (fast).
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(WEBHOOK_POPUP_NAME);
      channel.postMessage(result);
      setTimeout(() => channel.close(), 1000);
    } catch {
      /* fall through to storage */
    }
  }
  // Durable handoff: the main window reads this back by POLLING localStorage (and
  // via the `storage` event where it crosses the swap). Left in place for the
  // consumer to drop — see {@link onWebhookPopupResult}.
  try {
    localStorage.setItem(WEBHOOK_RESULT_KEY, JSON.stringify({ at: Date.now(), result }));
  } catch {
    /* ignore */
  }
}

/**
 * Open a blank, centered popup for the webhook OAuth flow — synchronously, so it
 * isn't caught by the popup blocker (the OAuth URL often isn't known until after
 * an `await`, which would break the user-gesture if we opened then). Navigate it
 * with {@link navigateWebhookPopup} once the URL is ready, then hand it to
 * {@link watchWebhookPopup}. Returns `null` when unsupported or blocked, so the
 * caller falls back to a full-page redirect.
 */
export function openWebhookPopup(): Window | null {
  if (typeof window === "undefined") return null;
  const w = 520;
  const h = 720;
  const baseLeft = window.screenLeft ?? window.screenX ?? 0;
  const baseTop = window.screenTop ?? window.screenY ?? 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || w;
  const vh = window.innerHeight || document.documentElement.clientHeight || h;
  const left = baseLeft + Math.max(0, (vw - w) / 2);
  const top = baseTop + Math.max(0, (vh - h) / 2);
  const popup = window.open(
    "about:blank",
    WEBHOOK_POPUP_NAME,
    `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
  );
  if (!popup) return null;
  // The handshake the returning popup will recognise itself by.
  markWebhookPopupPending();
  return popup;
}

/** Point an already-open popup (from {@link openWebhookPopup}) at the OAuth URL. */
export function navigateWebhookPopup(popup: Window, url: string): void {
  popup.location.href = url;
  popup.focus?.();
}

/**
 * Best-effort fast path: poll the popup handle and, if it survives the OAuth hop,
 * read the fragment off `popup.location` the moment it returns to our origin and
 * close it. Often the handle is severed by Discord's context-group swap (then
 * `popup.closed` reads true and this just stops) — in which case the popup's own
 * relay delivers via the storage handshake instead. Harmless either way.
 */
export function watchWebhookPopup(popup: Window): void {
  if (typeof window === "undefined") return;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearTimeout(cap);
  };
  const timer = window.setInterval(() => {
    if (done) return;
    if (popup.closed) {
      stop();
      return;
    }
    let hash = "";
    try {
      hash = popup.location.hash; // throws while cross-origin, or if handle severed
    } catch {
      return;
    }
    const result = parseWebhookHash(hash);
    if (!result) return;
    deliverWebhookResult(result);
    clearWebhookPopupPending();
    try {
      popup.close();
    } catch {
      /* user can close it; result already delivered */
    }
    stop();
  }, 120);
  const cap = window.setTimeout(stop, 5 * 60 * 1000);
}

/**
 * Full-page fallback for when the popup couldn't open (blocked / unsupported):
 * mark this tab so its OAuth return is handled in place, then navigate it into
 * the flow. The result comes back via the fragment on reload (see App's
 * fragment-consume effect).
 */
export function redirectToWebhookOAuth(url: string): void {
  // No popup is in flight — this tab handles its own return; drop any stale state.
  clearWebhookPopupPending();
  try {
    localStorage.removeItem(WEBHOOK_RESULT_KEY);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.setItem(WEBHOOK_SELF_REDIRECT_KEY, "1");
  } catch {
    // No sessionStorage — the return still boots and consumes the fragment; it
    // just can't prove it redirected itself. Harmless for an ordinary main tab.
  }
  window.location.assign(url);
}

/**
 * When this page load is our OAuth popup returning with a webhook in the fragment,
 * deliver the result to the main window (storage handshake + BroadcastChannel) and
 * keep from booting the whole app. Returns true when handled (the entry point then
 * skips boot). Recognised by the localStorage pending-mark — which, unlike
 * `window.opener`/`window.name`/the popup handle, survives Discord's context-group
 * swap. A self-redirected main tab is positively excluded so it's never mistaken
 * for a popup. Call once, before React mounts.
 */
export function relayWebhookPopupIfApplicable(): boolean {
  if (typeof window === "undefined") return false;
  if (!hasIncomingWebhook()) return false;

  // A tab that redirected itself owns its return — even if it has an opener.
  let selfRedirected = false;
  try {
    selfRedirected = sessionStorage.getItem(WEBHOOK_SELF_REDIRECT_KEY) != null;
    if (selfRedirected) sessionStorage.removeItem(WEBHOOK_SELF_REDIRECT_KEY);
  } catch {
    /* sessionStorage blocked — the signals below still gate us */
  }
  if (selfRedirected) return false;

  // The pending-mark is the reliable signal; opener/name are fast extras for the
  // (lucky) case the swap didn't sever them.
  const isPopup =
    webhookPopupPending() ||
    (!!window.opener && window.opener !== window) ||
    window.name === WEBHOOK_POPUP_NAME;
  if (!isPopup) return false;

  const result = parseWebhookHash(window.location.hash);
  if (result) deliverWebhookResult(result);
  clearWebhookPopupPending();
  window.name = "";
  if (document.body) {
    document.body.textContent = "Webhook created — you can close this window.";
  }
  // Close ourselves shortly after delivering (the opener may also close us first).
  window.setTimeout(() => {
    try {
      window.close();
    } catch {
      /* ignore */
    }
  }, 1200);
  return true;
}

/**
 * Subscribe to webhook results posted back from the OAuth popup. Listens on THREE
 * channels because Discord's context-group swap breaks the obvious ones:
 *
 *  - BroadcastChannel — fast, usually works.
 *  - `storage` event — fast where it crosses the swap.
 *  - a localStorage POLL — the bulletproof path: localStorage *values* are shared
 *    across all same-origin contexts regardless of browsing-context group (even
 *    when the events/opener/handle aren't), so reading the key always sees what
 *    the popup wrote.
 *
 * All three funnel through one `deliver` that dedupes, drops the stored keys, and
 * ignores anything staler than the pending TTL. Returns an unsubscribe function.
 */
export function onWebhookPopupResult(handler: (result: IncomingWebhookResult) => void): () => void {
  const cleanups: Array<() => void> = [];
  let lastUrl = "";

  const deliver = (result: IncomingWebhookResult | null) => {
    if (!result) return;
    // Drop the handoff FIRST — even for a duplicate — so a redundant write (e.g.
    // the handle poll re-broadcasting after the channel already delivered) can't
    // linger in localStorage and re-fire on a later load.
    try {
      localStorage.removeItem(WEBHOOK_RESULT_KEY);
      localStorage.removeItem(WEBHOOK_PENDING_KEY);
    } catch {
      /* ignore */
    }
    if (!("error" in result)) {
      if (result.url === lastUrl) return; // already delivered via another channel
      lastUrl = result.url;
    }
    handler(result);
  };

  // Read a result sitting in localStorage (poll + storage-event path).
  const consumeStored = () => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(WEBHOOK_RESULT_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { at?: number; result?: IncomingWebhookResult };
      const fresh = !parsed.at || Date.now() - parsed.at < WEBHOOK_PENDING_TTL_MS;
      if (parsed.result && fresh) {
        deliver(parsed.result);
        return;
      }
    } catch {
      /* malformed — drop it below */
    }
    try {
      localStorage.removeItem(WEBHOOK_RESULT_KEY);
    } catch {
      /* ignore */
    }
  };

  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(WEBHOOK_POPUP_NAME);
      channel.onmessage = (e: MessageEvent) => deliver(e.data as IncomingWebhookResult);
      cleanups.push(() => channel.close());
    } catch {
      /* the storage channels still deliver */
    }
  }

  if (typeof window !== "undefined") {
    const onStorage = (e: StorageEvent) => {
      if (e.key === WEBHOOK_RESULT_KEY && e.newValue) consumeStored();
    };
    window.addEventListener("storage", onStorage);
    cleanups.push(() => window.removeEventListener("storage", onStorage));

    const pollId = window.setInterval(consumeStored, 400);
    cleanups.push(() => clearInterval(pollId));

    consumeStored(); // apply a result that landed before this mount
  }

  return () => cleanups.forEach((c) => c());
}

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
 * bot (`response_type=code` + `redirect_uri`), so a full reload picks up the
 * freshly added server. The redirect target is the current origin, which must
 * be registered as an OAuth2 redirect URI in the Discord Developer Portal — an
 * unregistered URI makes Discord reject the invite, so we only attach it when an
 * origin is available.
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
