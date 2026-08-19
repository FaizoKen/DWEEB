/** Safe, non-mutating UI intents carried by static feature-page CTAs. */
import { readClientParam, withoutClientParams } from "@/core/seo/clientParams";
export type FeatureIntent = "ai" | "json" | "manage-webhooks" | "mcp" | "restore" | "schedule";

const INTENTS = new Set<FeatureIntent>([
  "ai",
  "json",
  "manage-webhooks",
  "mcp",
  "restore",
  "schedule",
]);

export function readFeatureIntent(search: string, hash = ""): FeatureIntent | null {
  const value = readClientParam("intent", search, hash) as FeatureIntent | null;
  return value && INTENTS.has(value) ? value : null;
}

export function stripFeatureIntent(href: string): string {
  return withoutClientParams(href, ["intent"]);
}
