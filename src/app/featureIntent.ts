/** Safe, non-mutating UI intents carried by static feature-page CTAs. */
export type FeatureIntent = "ai" | "json" | "manage-webhooks" | "restore" | "schedule";

const INTENTS = new Set<FeatureIntent>(["ai", "json", "manage-webhooks", "restore", "schedule"]);

export function readFeatureIntent(search: string): FeatureIntent | null {
  const value = new URLSearchParams(search).get("intent") as FeatureIntent | null;
  return value && INTENTS.has(value) ? value : null;
}

export function stripFeatureIntent(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("intent");
  return url.pathname + url.search + url.hash;
}
