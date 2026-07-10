/** Query key used to hand a guild-scoped custom-bot intent to the web app. */
export const CUSTOM_BOT_QUERY_KEY = "custom-bot";

export function isValidCustomBotGuildId(id: string | null): id is string {
  return id !== null && /^\d{17,20}$/.test(id);
}

/** Read and validate the guild targeted by a custom-bot configuration link. */
export function readCustomBotParam(search: string): string | null {
  const id = new URLSearchParams(search).get(CUSTOM_BOT_QUERY_KEY);
  return isValidCustomBotGuildId(id) ? id : null;
}

/** Build the canonical web-app handoff used by the embedded Activity. */
export function customBotConfigUrl(webAppBaseUrl: string, guildId: string): string {
  const base = webAppBaseUrl.replace(/\/+$/, "");
  return `${base}/?${CUSTOM_BOT_QUERY_KEY}=${encodeURIComponent(guildId)}`;
}

/** Remove only the handoff parameter, preserving every unrelated URL part. */
export function withoutCustomBotParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(CUSTOM_BOT_QUERY_KEY);
  return url.pathname + url.search + url.hash;
}
