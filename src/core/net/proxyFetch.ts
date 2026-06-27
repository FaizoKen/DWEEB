/**
 * One place every call to the DWEEB proxy goes through.
 *
 * It does two small things on top of `fetch`:
 *  - resolves the absolute proxy URL from {@link PROXY_BASE_URL}, and
 *  - attaches the embedded Activity's bearer token when one is held
 *    ({@link activityAuthHeader}), while still sending cookies for the web app.
 *
 * Cookies and a bearer are mutually exclusive in practice — the web app has a
 * session cookie and no token; the Activity has a token and no usable
 * cookie — so sending both is harmless and keeps a single code path for both
 * surfaces. Inside Discord's iframe the absolute URL is transparently rewritten
 * to a same-origin `/.proxy/…` path by the SDK's `patchUrlMappings`, so callers
 * never need to know which surface they're on.
 */

import { PROXY_BASE_URL } from "@/core/guild/config";
import { activityAuthHeader } from "@/core/activity/runtime";

/** Absolute URL for a proxy path (which already starts with `/api`, `/auth`, …). */
export function proxyUrl(path: string): string {
  return `${PROXY_BASE_URL}${path}`;
}

/** Credentialed fetch to the proxy, with the Activity bearer attached when set. */
export function proxyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(activityAuthHeader())) headers.set(k, v);
  return fetch(proxyUrl(path), { credentials: "include", ...init, headers });
}
