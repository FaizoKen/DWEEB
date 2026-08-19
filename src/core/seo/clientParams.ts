/**
 * Read and write client-only app state without creating crawlable query URLs.
 *
 * Search engines send query strings to the server and can index each variant;
 * URL fragments stay in the browser. Discovery-page CTAs therefore put
 * `entry`, `template`, `setup`, and `intent` in the fragment. Readers keep
 * accepting the old query form so deployed links and bookmarks do not break.
 */

const PLACEHOLDER_ORIGIN = "https://dweeb.invalid";

export const SEO_CLIENT_PARAM_KEYS = ["entry", "template", "setup", "intent"] as const;
export type SeoClientParamKey = (typeof SEO_CLIENT_PARAM_KEYS)[number];

function hashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

/** Prefer a legacy query value, then fall back to fragment-based app state. */
export function readClientParam(key: SeoClientParamKey, search: string, hash = ""): string | null {
  return new URLSearchParams(search).get(key) ?? hashParams(hash).get(key);
}

/**
 * Move a path's query state into its fragment and add bounded app parameters.
 * Absolute inputs stay absolute; site-relative inputs stay site-relative.
 */
export function withClientParams(
  href: string,
  additions: Partial<Record<SeoClientParamKey, string>> = {},
): string {
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(href);
  const url = new URL(href, PLACEHOLDER_ORIGIN);
  const params = hashParams(url.hash);

  for (const [key, value] of url.searchParams) params.append(key, value);
  url.search = "";
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) params.set(key, value);
  }
  url.hash = params.toString();

  const relative = url.pathname + url.search + url.hash;
  return absolute ? `${url.origin}${relative}` : relative;
}

/** Return a history-safe relative URL with only the named app state removed. */
export function withoutClientParams(href: string, keys: readonly SeoClientParamKey[]): string {
  const url = new URL(href);
  for (const key of keys) url.searchParams.delete(key);

  const params = hashParams(url.hash);
  const hadFragmentParam = keys.some((key) => params.has(key));
  if (hadFragmentParam) {
    for (const key of keys) params.delete(key);
    url.hash = params.toString();
  }

  return url.pathname + url.search + url.hash;
}
