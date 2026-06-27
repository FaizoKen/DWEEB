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
