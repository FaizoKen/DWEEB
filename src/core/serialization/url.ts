/**
 * URL-hash share state.
 *
 * Share state lives in the URL hash (`#s=<token>`) so:
 *  - The server never sees it (privacy, plus avoids CDN cache poisoning).
 *  - Page reloads keep the message intact.
 *  - Cloudflare's `_redirects` SPA fallback never gets in the way.
 *
 * The reader returns the token only if the prefix matches — anything else
 * (e.g. `#dialog=share`) is ignored, leaving room for other hash-based UI.
 */

const HASH_KEY = "s";

export function readShareTokenFromHash(hash: string): string | null {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!trimmed) return null;
  const params = new URLSearchParams(trimmed);
  const value = params.get(HASH_KEY);
  return value && value.length > 0 ? value : null;
}

/**
 * Build a full sharable URL for the current document. Replaces any existing
 * `s=` value but preserves other hash fragments so deep-linkable UI keeps
 * working alongside share links.
 */
export function buildShareUrl(token: string, location: Location = window.location): string {
  const url = new URL(location.href);
  const hashBody = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(hashBody);
  params.set(HASH_KEY, token);
  url.hash = params.toString();
  return url.toString();
}

/** Writes the token into `location.hash` without scrolling the page. */
export function writeShareTokenToHash(token: string): void {
  const url = buildShareUrl(token);
  window.history.replaceState(null, "", url);
}

/** Strips the share token from the URL hash without affecting other params. */
export function clearShareTokenFromHash(): void {
  const url = new URL(window.location.href);
  const hashBody = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(hashBody);
  params.delete(HASH_KEY);
  const next = params.toString();
  url.hash = next.length > 0 ? next : "";
  window.history.replaceState(null, "", url.toString());
}
