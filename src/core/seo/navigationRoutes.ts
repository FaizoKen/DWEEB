/**
 * The only navigation families that belong to the client-side app shell.
 * Everything else is network-first so current and future pre-rendered search
 * pages can never be replaced with cached homepage HTML by the service worker.
 *
 * Workbox evaluates navigation allowlists against pathname + search. Root query
 * strings carry template/setup/OAuth hand-offs; short-link ids are base62 and
 * constrained to the same shape as the early resolver in `index.html`.
 */
export const SPA_NAVIGATION_ALLOWLIST = [
  /^\/(?:\?.*)?$/,
  /^\/s\/[0-9A-Za-z]{4,16}\/*(?:\?.*)?$/,
] as const;

export function isSpaNavigationPath(pathAndSearch: string): boolean {
  return SPA_NAVIGATION_ALLOWLIST.some((pattern) => pattern.test(pathAndSearch));
}
