import { describe, expect, it } from "vitest";

import { parseManifest, type PluginManifest } from "./manifest";
import { matchPlugin } from "./targets";

const manifest = (id: string, customIdPrefix: string): PluginManifest =>
  parseManifest({
    schemaVersion: 1,
    id,
    name: id,
    description: id,
    version: "1.0.0",
    targets: ["button"],
    configUrl: `https://plugin.example/${id}`,
    customIdPrefix,
  })!;

describe("matchPlugin", () => {
  const plugins = [manifest("tickets", "tickets:"), manifest("tickets-open", "tickets:open:")];

  it("picks the longest matching prefix", () => {
    expect(matchPlugin(plugins, "tickets:open:abc")?.id).toBe("tickets-open");
    expect(matchPlugin(plugins, "tickets:close:abc")?.id).toBe("tickets");
    expect(matchPlugin(plugins, "btn_action")).toBeNull();
  });

  // prod 2026-10-23: the Action panel handed it a numeric custom_id and the
  // `startsWith` TypeError took the editor to the error screen.
  it("reads a custom_id that isn't a string as unbound instead of throwing", () => {
    for (const customId of [undefined, null, "", 123, { id: "tickets:" }, ["tickets:"]]) {
      expect(() => matchPlugin(plugins, customId)).not.toThrow();
      expect(matchPlugin(plugins, customId)).toBeNull();
    }
  });
});
