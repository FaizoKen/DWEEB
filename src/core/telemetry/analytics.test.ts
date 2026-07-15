import { afterEach, describe, expect, it, vi } from "vitest";
import { trackAnalytics } from "./analytics";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackAnalytics", () => {
  it("queues only bounded, non-sensitive parameters", () => {
    const gtag = vi.fn();
    vi.stubGlobal("window", { gtag });
    trackAnalytics("template_applied", {
      template_id: "reaction-roles",
      url: "https://discord.com/api/webhooks/123/secret",
      content: "hello world",
      boot_ms: 123.7,
    });
    expect(gtag).toHaveBeenCalledWith("event", "template_applied", {
      template_id: "reaction-roles",
    });
  });

  it("rounds the one numeric field that is explicitly allowed", () => {
    const gtag = vi.fn();
    vi.stubGlobal("window", { gtag });
    trackAnalytics("builder_ready", { boot_ms: 123.7, content: "safe-looking-secret" });
    expect(gtag).toHaveBeenCalledWith("event", "builder_ready", { boot_ms: 124 });
  });

  it("records the bounded first interactive surface separately from builder activation", () => {
    const gtag = vi.fn();
    vi.stubGlobal("window", { gtag });
    trackAnalytics("app_surface_ready", {
      boot_ms: 456.2,
      surface: "directory",
      template_id: "private-looking-value",
    });
    expect(gtag).toHaveBeenCalledWith("event", "app_surface_ready", {
      boot_ms: 456,
      surface: "directory",
    });
  });

  it("is a no-op when privacy gating omitted gtag", () => {
    expect(() => trackAnalytics("builder_ready", { boot_ms: 10 })).not.toThrow();
  });
});
