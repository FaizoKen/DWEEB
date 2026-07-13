import { describe, expect, it } from "vitest";

import { parseManifest, PLUGIN_API_VERSION } from "./manifest";

const baseManifest = {
  schemaVersion: 1,
  id: "example",
  name: "Example",
  description: "Example plugin",
  version: "1.0.0",
  targets: ["button"],
  configUrl: "https://plugin.example/config",
  customIdPrefix: "example:",
};

describe("plugin manifest resources", () => {
  it("keeps only known, deduplicated resource declarations", () => {
    const manifest = parseManifest({
      ...baseManifest,
      resources: ["guild", "savedWebhooks", "guild", "oauthSession", 42],
    });

    expect(manifest?.resources).toEqual(["guild", "savedWebhooks"]);
  });

  it("defaults to no editor-data access when resources are absent", () => {
    expect(parseManifest(baseManifest)?.resources).toBeUndefined();
  });

  it("parses a declared protocol version and the host currently speaks v2", () => {
    expect(PLUGIN_API_VERSION).toBe(2);
    expect(parseManifest({ ...baseManifest, apiVersion: 2 })?.apiVersion).toBe(2);
    expect(parseManifest({ ...baseManifest, apiVersion: 1.5 })?.apiVersion).toBeUndefined();
  });
});
