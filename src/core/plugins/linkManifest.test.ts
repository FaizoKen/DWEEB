import { describe, expect, it } from "vitest";

import {
  isValidLinkSaveUrl,
  linkUrlPrefix,
  matchLinkPlugin,
  parseLinkManifest,
  unfilledLinkTokens,
  type LinkPluginManifest,
} from "./linkManifest";

const baseLink = {
  schemaVersion: 1,
  kind: "link",
  id: "example-link",
  name: "Example Link",
  description: "An external link service",
  version: "1.0.0",
  url: "https://service.example/verify?guild={server_id}",
};

function parsed(overrides: Record<string, unknown> = {}): LinkPluginManifest {
  const manifest = parseLinkManifest({ ...baseLink, ...overrides });
  if (!manifest) throw new Error("fixture manifest should parse");
  return manifest;
}

describe("link manifest parsing", () => {
  it("parses the optional statusUrl template, holding it to the url bar", () => {
    expect(
      parsed({ statusUrl: "https://service.example/status?guild={server_id}" }).statusUrl,
    ).toBe("https://service.example/status?guild={server_id}");
    // A tokenized host would let the probe be pointed anywhere — dropped.
    expect(parsed({ statusUrl: "https://{host}/status" }).statusUrl).toBeUndefined();
    expect(parsed({ statusUrl: "ftp://service.example/x" }).statusUrl).toBeUndefined();
  });

  it("parses the optional configUrl and restricts resources to the link allow-list", () => {
    const manifest = parsed({
      configUrl: "https://service.example/picker",
      resources: ["guild", "savedWebhook", "message", "guild", 42],
    });
    expect(manifest.configUrl).toBe("https://service.example/picker");
    // Only content-free context survives — never credentials or message data.
    expect(manifest.resources).toEqual(["guild"]);
  });

  it("drops a non-https configUrl", () => {
    expect(parsed({ configUrl: "javascript:alert(1)" }).configUrl).toBeUndefined();
  });

  it("still parses a plain manifest without the optional fields", () => {
    const manifest = parsed();
    expect(manifest.statusUrl).toBeUndefined();
    expect(manifest.configUrl).toBeUndefined();
    expect(manifest.resources).toBeUndefined();
  });
});

describe("link binding matching", () => {
  it("re-derives the owning plugin by longest literal prefix", () => {
    const broad = parsed({ id: "broad", url: "https://service.example/{page}" });
    const narrow = parsed({
      id: "narrow",
      url: "https://service.example/verify?guild={server_id}",
    });
    expect(matchLinkPlugin([broad, narrow], "https://service.example/verify?guild=1")?.id).toBe(
      "narrow",
    );
    expect(matchLinkPlugin([broad, narrow], "https://service.example/other")?.id).toBe("broad");
    expect(matchLinkPlugin([broad, narrow], "https://elsewhere.example/x")).toBeNull();
  });

  it("reports unfilled non-core tokens, ignoring core ones", () => {
    expect(unfilledLinkTokens("https://s.example/f/{form_id}?guild={server_id}")).toEqual([
      "form_id",
    ]);
    expect(unfilledLinkTokens("https://s.example/f/abc?guild={server_id}")).toEqual([]);
  });
});

describe("isValidLinkSaveUrl", () => {
  const manifest = parsed({ url: "https://service.example/f/{form_id}" });

  it("accepts a finished URL under the manifest's own prefix", () => {
    expect(isValidLinkSaveUrl(manifest, "https://service.example/f/abc123")).toBe(true);
  });

  it("rejects a URL outside the manifest prefix — a save can never repoint the button", () => {
    expect(isValidLinkSaveUrl(manifest, "https://evil.example/f/abc123")).toBe(false);
    expect(isValidLinkSaveUrl(manifest, "https://service.example/other/abc")).toBe(false);
  });

  it("rejects a save that is still a template", () => {
    expect(isValidLinkSaveUrl(manifest, "https://service.example/f/{form_id}")).toBe(false);
  });

  it("allows core tokens to remain (they resolve at send)", () => {
    const withCore = parsed({ url: "https://service.example/verify?guild={server_id}" });
    expect(isValidLinkSaveUrl(withCore, "https://service.example/verify?guild={server_id}")).toBe(
      true,
    );
  });

  it("bounds the URL and rejects non-strings", () => {
    expect(isValidLinkSaveUrl(manifest, `https://service.example/f/${"a".repeat(600)}`)).toBe(
      false,
    );
    expect(isValidLinkSaveUrl(manifest, undefined)).toBe(false);
    expect(isValidLinkSaveUrl(manifest, "")).toBe(false);
  });

  it("prefix sanity: linkUrlPrefix stops at the first token", () => {
    expect(linkUrlPrefix("https://service.example/f/{form_id}")).toBe("https://service.example/f/");
    expect(linkUrlPrefix("https://service.example/plain")).toBe("https://service.example/plain");
  });
});
