import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_URL,
  DEFAULT_PROXY_URL,
  DEFAULT_TIMEOUT_MS,
  ConfigError,
  findWebhook,
  loadConfig,
} from "./config";

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnop-TOKEN";
const HOOK_TWO = "https://discord.com/api/webhooks/223456789012345678/qrstuvwxyz012345-TOKEN";

describe("loadConfig", () => {
  it("runs with nothing configured — build and share still work, posting does not", () => {
    const config = loadConfig({});
    expect(config.webhooks).toEqual([]);
    expect(config.appUrl).toBe(DEFAULT_APP_URL);
    expect(config.proxyUrl).toBe(DEFAULT_PROXY_URL);
    expect(config.readOnly).toBe(false);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("names the single-webhook shorthand `default` and keeps its id", () => {
    const config = loadConfig({ DWEEB_WEBHOOK_URL: HOOK });
    expect(config.webhooks).toEqual([{ alias: "default", url: HOOK, id: "123456789012345678" }]);
  });

  it("takes several destinations from DWEEB_WEBHOOKS, in declaration order", () => {
    const config = loadConfig({
      DWEEB_WEBHOOKS: JSON.stringify({ announcements: HOOK, staff: HOOK_TWO }),
    });
    expect(config.webhooks.map((w) => w.alias)).toEqual(["announcements", "staff"]);
  });

  // The proxy's config.rs learned this the hard way: an untrimmed value that
  // parses as its opposite silently disables a guard.
  it("trims every value, so a trailing space cannot flip a boolean", () => {
    expect(loadConfig({ DWEEB_MCP_READ_ONLY: "true " }).readOnly).toBe(true);
    expect(loadConfig({ DWEEB_APP_URL: " https://dweeb.example.com " }).appUrl).toBe(
      "https://dweeb.example.com",
    );
  });

  it("strips a trailing slash from both origins so paths append cleanly", () => {
    const config = loadConfig({
      DWEEB_APP_URL: "https://dweeb.example.com/",
      DWEEB_PROXY_URL: "https://api.example.com//",
    });
    expect(config.appUrl).toBe("https://dweeb.example.com");
    expect(config.proxyUrl).toBe("https://api.example.com");
  });

  it("treats a blank DWEEB_PROXY_URL as 'no short links', not 'use the default'", () => {
    expect(loadConfig({ DWEEB_PROXY_URL: "" }).proxyUrl).toBe("");
    expect(loadConfig({}).proxyUrl).toBe(DEFAULT_PROXY_URL);
  });

  describe("refuses to start on a value it cannot parse", () => {
    it.each([
      ["DWEEB_MCP_READ_ONLY", { DWEEB_MCP_READ_ONLY: "yep" }],
      ["DWEEB_MCP_TIMEOUT_MS", { DWEEB_MCP_TIMEOUT_MS: "soon" }],
      ["DWEEB_MCP_TIMEOUT_MS out of range", { DWEEB_MCP_TIMEOUT_MS: "10" }],
      ["DWEEB_APP_URL", { DWEEB_APP_URL: "dweeb.example.com" }],
      ["DWEEB_APP_URL scheme", { DWEEB_APP_URL: "ftp://dweeb.example.com" }],
      ["DWEEB_WEBHOOK_URL", { DWEEB_WEBHOOK_URL: "https://example.com/hook" }],
      ["DWEEB_WEBHOOKS shape", { DWEEB_WEBHOOKS: "[]" }],
      ["DWEEB_WEBHOOKS json", { DWEEB_WEBHOOKS: "{oops" }],
      ["DWEEB_WEBHOOKS value", { DWEEB_WEBHOOKS: '{"a": 5}' }],
      ["DWEEB_WEBHOOKS alias", { DWEEB_WEBHOOKS: `{"has space": "${HOOK}"}` }],
    ])("%s", (_name, env) => {
      expect(() => loadConfig(env)).toThrow(ConfigError);
    });

    it("never echoes the credential it rejected", () => {
      try {
        loadConfig({ DWEEB_WEBHOOK_URL: "https://discord.com/api/webhooks/1/nope/extra" });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect((e as Error).message).not.toContain("nope");
      }
    });

    it("refuses a duplicate name rather than silently picking one", () => {
      expect(() =>
        loadConfig({
          DWEEB_WEBHOOK_URL: HOOK,
          DWEEB_WEBHOOKS: `{"default": "${HOOK_TWO}"}`,
        }),
      ).toThrow(/duplicate/);
    });
  });
});

describe("findWebhook", () => {
  const two = loadConfig({ DWEEB_WEBHOOKS: JSON.stringify({ news: HOOK, staff: HOOK_TWO }) });

  it("uses the only destination when just one is configured", () => {
    const one = loadConfig({ DWEEB_WEBHOOKS: JSON.stringify({ news: HOOK }) });
    expect(findWebhook(one)?.alias).toBe("news");
  });

  // Guessing here would post to the wrong channel, which cannot be taken back.
  it("refuses to guess between several unnamed destinations", () => {
    expect(findWebhook(two)).toBeNull();
  });

  it("falls back to a destination actually named `default`", () => {
    const config = loadConfig({
      DWEEB_WEBHOOK_URL: HOOK,
      DWEEB_WEBHOOKS: `{"staff": "${HOOK_TWO}"}`,
    });
    expect(findWebhook(config)?.alias).toBe("default");
  });

  it("resolves by name, and answers null for an unknown one", () => {
    expect(findWebhook(two, "staff")?.id).toBe("223456789012345678");
    expect(findWebhook(two, "nope")).toBeNull();
  });
});
