/**
 * Legacy short-link path detection.
 *
 * The old Cloudflare deployment offered opt-in short links: the share token
 * was stored server-side (Cloudflare KV, 7-day TTL) and served back from
 * `/s/<id>`. GitHub Pages is a pure static host, so the feature was removed
 * with the migration — the default hash link (`#s=…`) is the only share link
 * now, and it never needed a server.
 *
 * This reader survives so a stale `/s/<id>` URL still loads the app (via the
 * 404.html SPA fallback) and gets a clear "no longer supported" message
 * instead of a cryptic failure.
 */

const SHORT_PATH = "/s/";
/** Matches the base62 ids the old deployment minted (and a margin). */
const ID_RE = /^[0-9A-Za-z]{4,16}$/;

/** Extract a short-link id from a pathname (`/s/<id>`), or null if it isn't one. */
export function readShortLinkId(pathname: string): string | null {
  if (!pathname.startsWith(SHORT_PATH)) return null;
  const id = pathname.slice(SHORT_PATH.length).replace(/\/+$/, "");
  return ID_RE.test(id) ? id : null;
}
