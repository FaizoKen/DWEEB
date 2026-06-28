/**
 * Activity runtime flags + credentials.
 *
 * The embedded Discord Activity (see `src/activity/`) reaches the same proxy as
 * the web app, but authenticates differently: its sandboxed `…discordsays.com`
 * iframe never receives the proxy's session cookie, so it sends the Discord
 * access token (obtained through the Embedded App SDK) as a bearer instead.
 *
 * This tiny module is the seam: it remembers whether we booted as an Activity
 * and, once the SDK handshake completes, holds the access token so the shared
 * proxy client (`core/net/proxyFetch`) can attach it to every call. Keeping it
 * here — rather than threading the token through every API function — means the
 * existing `core/guild` client works unchanged on both surfaces.
 */

/** Discord launches an Activity with `frame_id` (and friends) in the URL query.
 *  Computed once at module load — the value never changes within a page. */
const ACTIVITY_MODE = (() => {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).has("frame_id");
  } catch {
    return false;
  }
})();

/** True when this page is running embedded as a Discord Activity. */
export function isActivityMode(): boolean {
  return ACTIVITY_MODE;
}

/** Path prefix the proxy is mapped under inside Discord's sandbox. Must match the
 *  PREFIX of the Developer Portal URL mapping that targets the proxy host. Lives
 *  here (not in `sdk.ts`) so non-SDK code — like the media URL rewriter below —
 *  can reference it without pulling the Embedded App SDK into the web bundle. */
export const PROXY_MAPPING_PREFIX = "/proxy";

/**
 * Rewrite an external image/video URL so a sandboxed Activity iframe can actually
 * load it.
 *
 * Inside Discord the Activity runs in a `…discordsays.com` iframe whose CSP only
 * allows media from Discord's own origins and the hosts we've URL-mapped. The
 * arbitrary URLs people paste into the builder (picsum, imgur, …) are blocked
 * when loaded as `<img>`/`<video>` — and, unlike `fetch`/WebSocket/XHR, those
 * element loads are *not* intercepted by the SDK's `patchUrlMappings`. So we
 * route them through the proxy's `/api/activity/image` endpoint, addressed by the
 * same-origin `/proxy/…` path Discord forwards to the proxy host (this is exactly
 * the path the SDK rewrites our fetches to, for our `{prefix:"/proxy"}` mapping).
 *
 * No-op outside a real, production Activity: the web app loads media directly, and
 * the dev URL-override runs on plain `localhost` (no CSP) where proxied calls 404
 * under its faux ticket — both must keep the original URL.
 */
export function proxiedMediaUrl(url: string): string {
  if (!isActivityMode() || !import.meta.env.PROD) return url;
  if (!/^https?:\/\//i.test(url)) return url; // blob:/data:/relative — already loadable
  // Discord's own CDNs are whitelisted by the iframe's CSP, so let them load
  // natively (and keep our proxy off Discord's bandwidth).
  if (isDiscordCdnUrl(url)) return url;
  return `${PROXY_MAPPING_PREFIX}/api/activity/image?url=${encodeURIComponent(url)}`;
}

/** Whether a URL points at one of Discord's own CDNs (already CSP-allowed). */
function isDiscordCdnUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h === "discord.com" ||
      h.endsWith(".discord.com") ||
      h.endsWith(".discordapp.com") ||
      h.endsWith(".discordapp.net")
    );
  } catch {
    return false;
  }
}

let accessToken: string | null = null;

/** Store (or clear) the Discord access token the proxy bearer-authenticates with.
 *  Set by the Activity handshake once `authenticate` succeeds. */
export function setActivityToken(token: string | null): void {
  accessToken = token;
}

/** The current Activity access token, or null (web app / pre-handshake). */
export function getActivityToken(): string | null {
  return accessToken;
}

/** Authorization header for proxy calls when an Activity token is held; empty
 *  otherwise, so the web app's cookie auth is untouched. */
export function activityAuthHeader(): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}
