/**
 * Opt-in short-link client.
 *
 * The default share link keeps the whole message in the URL hash (`#s=…`), so
 * it never leaves the browser (see `url.ts`). A *short* link is the opt-in
 * exception: the compressed token is POSTed to the DWEEB proxy (`server/`),
 * stored server-side under a random id for 7 days (then auto-deleted), and
 * shared as `…/s/<id>`. Opening that URL resolves the token back and loads it
 * like any other share link.
 *
 * Resolution is latency-critical — it sits on the critical path of opening a
 * shared link — so `index.html` ships a tiny inline script that starts the
 * fetch as soon as the HTML arrives, racing it against the JS bundle download.
 * `resolveShortLink` consumes that early response when present instead of
 * starting a second request.
 *
 * The feature rides on the same `VITE_PROXY_BASE_URL` as the guild features;
 * builds without a proxy simply don't offer short links (the share dialog
 * hides the section, and stale `/s/<id>` URLs get a clear error).
 */

import { PROXY_BASE_URL } from "@/core/guild/config";

const SHORT_PATH = "/s/";
/** Matches the base62 ids the server mints (8 chars today, plus a margin). */
const ID_RE = /^[0-9A-Za-z]{4,16}$/;

/** True when a proxy is configured, i.e. short links can be created/resolved. */
export function isShortLinkConfigured(): boolean {
  return PROXY_BASE_URL.length > 0;
}

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
  if (!isShortLinkConfigured()) {
    return { ok: false, error: "Short links aren't configured on this deployment." };
  }
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/shortlink`, {
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
const RESOLVE_TIMEOUT_MS = 8_000;
const EARLY_WAIT_TIMEOUT_MS = 3_000;

/**
 * The in-flight response started by the inline early-resolve script in
 * `index.html`, if that script ran for this page load. Single-consumer: taking
 * it clears the slot so a failed early fetch can be retried fresh.
 */
function takeEarlyResolve(): Promise<Response | null> | null {
  const early = window.__dweebShortLink;
  if (!early) return null;
  window.__dweebShortLink = undefined;
  return early;
}

async function awaitEarlyResolve(early: Promise<Response | null>): Promise<Response | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      early,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), EARLY_WAIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Fetch the share token behind a short-link id. Never throws. */
export async function resolveShortLink(id: string): Promise<ResolveShortLinkResult> {
  if (!isShortLinkConfigured()) {
    return { ok: false, error: "Short links aren't configured on this deployment." };
  }
  let res: Response | null = null;
  // Prefer the early fetch (started before the app bundle even loaded); a
  // network failure there falls through to one fresh attempt.
  const early = takeEarlyResolve();
  if (early) res = await awaitEarlyResolve(early);
  if (!res) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    try {
      res = await fetch(`${PROXY_BASE_URL}/api/shortlink/${encodeURIComponent(id)}`, {
        signal: controller.signal,
      });
    } catch {
      return { ok: false, error: "Couldn't reach the short-link service." };
    } finally {
      clearTimeout(timeout);
    }
  }
  const data = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
  if (!res.ok || !data?.token) {
    return { ok: false, error: data?.error ?? `Server returned ${res.status}.` };
  }
  return { ok: true, token: data.token };
}
