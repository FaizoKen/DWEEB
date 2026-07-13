/**
 * Editor resources a plugin configuration iframe may request.
 *
 * Access is default-deny: a plugin must declare every resource in its bundled
 * manifest, and the host still applies the resource-specific checks in
 * `features/plugins/pluginData.ts`. `savedWebhook` is intentionally singular —
 * it releases one selected credential only after the host confirms with the
 * user; `savedWebhooks` contains labels and ids, never execute URLs.
 */
export const PLUGIN_RESOURCES = [
  "savedMessages",
  "savedWebhooks",
  "savedWebhook",
  "message",
  "component",
  "guild",
] as const;

export type PluginResource = (typeof PLUGIN_RESOURCES)[number];

/** Plain-language disclosure shown by the host around an untrusted iframe. */
export const PLUGIN_RESOURCE_LABELS: Record<PluginResource, string> = {
  savedMessages: "browser-saved message contents",
  savedWebhooks: "saved webhook names and destinations (without credentials)",
  savedWebhook: "one selected webhook credential, only after your confirmation",
  message: "the message currently being edited",
  component: "the attached component's details",
  guild: "the connected server's name and ID",
};

export function isPluginResource(value: unknown): value is PluginResource {
  return PLUGIN_RESOURCES.includes(value as PluginResource);
}

/** Parse, filter, and deduplicate a manifest resource declaration. */
export function parsePluginResources(value: unknown): PluginResource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const resources = [...new Set(value.filter(isPluginResource))];
  return resources.length ? resources : undefined;
}
