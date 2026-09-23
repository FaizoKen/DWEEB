/**
 * The plugin library's setup tag for a link service follows the live probe
 * where it answered, and otherwise claims nothing about the server: "unknown"
 * (no server connected, the probe failed, the Activity's CSP) must never read
 * as "Ready" — nor as a verified "Needs setup".
 */

import { describe, expect, it } from "vitest";
import { linkSetupTag } from "./PluginLibraryModal";

const SERVICE = { setupUrl: "https://service.example/dashboard" };

describe("linkSetupTag", () => {
  it("shows the probe's answer", () => {
    expect(linkSetupTag(SERVICE, "ready")).toMatchObject({ label: "Ready", tone: "ready" });
    expect(linkSetupTag(SERVICE, "needs-setup")).toMatchObject({
      label: "Needs setup",
      tone: "warning",
    });
  });

  it("keeps a neutral hint while the answer is unknown", () => {
    expect(linkSetupTag(SERVICE, "unknown")).toMatchObject({
      label: "One-time setup",
      tone: "neutral",
    });
  });

  it("shows nothing unknown for a service with no setup step", () => {
    expect(linkSetupTag({}, "unknown")).toBeNull();
    // …but a probe that answered is still worth showing.
    expect(linkSetupTag({}, "needs-setup")?.label).toBe("Needs setup");
  });
});
