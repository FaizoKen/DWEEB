/**
 * Optional short-link client.
 *
 * The default share link keeps the whole message in the URL hash (`#s=…`), so
 * it never leaves the browser (see `url.ts`). A *short* link is the opt-in
 * exception: the compressed token is POSTed to a same-origin Pages Function,
 * stored in Cloudflare KV under a random id for 7 days, and shared as
 * `…/s/<id>`. Opening that URL resolves the token back and loads it like any
 * other share link.
 *
 * All requests are same-origin (`/api/…`), so they satisfy the page's
 * `connect-src 'self'` CSP without any extra allowance.
 */

const SHORT_PATH = "/s/";
/** Matches the base62 ids minted by `functions/api/shorten.ts` (and a margin). */
const ID_RE = /^[0-9A-Za-z]{4,16}$/;

/** Extract a short-link id from a pathname (`/s/<id>`), or null if it isn't one. */
export function readShortLinkId(pathname: string): string | null {
  if (!pathname.startsWith(SHORT_PATH)) return null;
  const id = pathname.slice(SHORT_PATH.length).replace(/\/+$/, "");
  return ID_RE.test(id) ? id : null;
}

/** Build the public short URL for an id against the current origin. */
export function buildShortUrl(id: string, location: Location = window.location): string {
  return `${location.origin}${SHORT_PATH}${id}`;
}

export type CreateShortLinkResult =
  | { ok: true; id: string; url: string }
  | { ok: false; error: string };

/** Upload a share token and get back a short link. Never throws. */
export async function createShortLink(token: string): Promise<CreateShortLinkResult> {
  let res: Response;
  try {
    res = await fetch("/api/shorten", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the short-link service." };
  }
  const data = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (!res.ok || !data?.id) {
    return { ok: false, error: data?.error ?? `Server returned ${res.status}.` };
  }
  return { ok: true, id: data.id, url: buildShortUrl(data.id) };
}

export type ResolveShortLinkResult = { ok: true; token: string } | { ok: false; error: string };

/** Fetch the share token behind a short-link id. Never throws. */
export async function resolveShortLink(id: string): Promise<ResolveShortLinkResult> {
  let res: Response;
  try {
    res = await fetch(`/api/s/${encodeURIComponent(id)}`);
  } catch {
    return { ok: false, error: "Couldn't reach the short-link service." };
  }
  const data = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
  if (!res.ok || !data?.token) {
    return { ok: false, error: data?.error ?? `Server returned ${res.status}.` };
  }
  return { ok: true, token: data.token };
}
