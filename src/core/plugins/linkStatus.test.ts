import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearLinkStatusCache, fetchLinkPluginStatus, linkPluginStatusUrl } from "./linkStatus";
import { parseLinkManifest, type LinkPluginManifest } from "./linkManifest";

function manifest(statusUrl?: string): LinkPluginManifest {
  const parsed = parseLinkManifest({
    schemaVersion: 1,
    kind: "link",
    id: "probe-test",
    name: "Probe Test",
    description: "",
    version: "1.0.0",
    url: "https://service.example/verify?guild={server_id}",
    ...(statusUrl ? { statusUrl } : {}),
  });
  if (!parsed) throw new Error("fixture manifest should parse");
  return parsed;
}

const PROBED = manifest("https://service.example/status?guild={server_id}");

function mockFetchOnce(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({}),
    ...response,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => clearLinkStatusCache());
afterEach(() => vi.unstubAllGlobals());

describe("linkPluginStatusUrl", () => {
  it("substitutes the guild into the template", () => {
    expect(linkPluginStatusUrl(PROBED, "123456789012345678")).toBe(
      "https://service.example/status?guild=123456789012345678",
    );
  });

  it("is null without a statusUrl or with a leftover token", () => {
    expect(linkPluginStatusUrl(manifest(), "1")).toBeNull();
    expect(linkPluginStatusUrl(manifest("https://service.example/status/{other}"), "1")).toBeNull();
  });
});

describe("fetchLinkPluginStatus", () => {
  it("maps a boolean `configured` to ready / needs-setup", async () => {
    mockFetchOnce({ json: () => Promise.resolve({ configured: true }) });
    expect(await fetchLinkPluginStatus(PROBED, "111111111111111111")).toEqual({ status: "ready" });

    clearLinkStatusCache();
    mockFetchOnce({ json: () => Promise.resolve({ configured: false }) });
    expect(await fetchLinkPluginStatus(PROBED, "111111111111111111")).toEqual({
      status: "needs-setup",
    });
  });

  it("keeps a sane role_count and drops a bogus one", async () => {
    mockFetchOnce({ json: () => Promise.resolve({ configured: true, role_count: 2 }) });
    expect(await fetchLinkPluginStatus(PROBED, "111111111111111111")).toEqual({
      status: "ready",
      roleCount: 2,
    });

    clearLinkStatusCache();
    mockFetchOnce({ json: () => Promise.resolve({ configured: true, role_count: -3 }) });
    expect(await fetchLinkPluginStatus(PROBED, "111111111111111111")).toEqual({ status: "ready" });

    clearLinkStatusCache();
    mockFetchOnce({ json: () => Promise.resolve({ configured: true, role_count: "2" }) });
    expect(await fetchLinkPluginStatus(PROBED, "111111111111111111")).toEqual({ status: "ready" });
  });

  it("degrades every failure mode to unknown", async () => {
    mockFetchOnce({ ok: false });
    expect((await fetchLinkPluginStatus(PROBED, "222222222222222222")).status).toBe("unknown");

    clearLinkStatusCache();
    // A truthy-but-not-boolean `configured` must not count as ready.
    mockFetchOnce({ json: () => Promise.resolve({ configured: "yes" }) });
    expect((await fetchLinkPluginStatus(PROBED, "222222222222222222")).status).toBe("unknown");

    clearLinkStatusCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    expect((await fetchLinkPluginStatus(PROBED, "222222222222222222")).status).toBe("unknown");
  });

  it("caches per probe URL and dedupes concurrent callers", async () => {
    const fetchMock = mockFetchOnce({ json: () => Promise.resolve({ configured: true }) });
    const [a, b] = await Promise.all([
      fetchLinkPluginStatus(PROBED, "333333333333333333"),
      fetchLinkPluginStatus(PROBED, "333333333333333333"),
    ]);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    // Second sequential call hits the TTL cache; still one network fetch.
    expect((await fetchLinkPluginStatus(PROBED, "333333333333333333")).status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A different guild is a different probe URL — new fetch.
    await fetchLinkPluginStatus(PROBED, "444444444444444444");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a fresh probe bypasses the TTL cache and the browser HTTP cache", async () => {
    const fetchMock = mockFetchOnce({ json: () => Promise.resolve({ configured: false }) });
    expect((await fetchLinkPluginStatus(PROBED, "777777777777777777")).status).toBe("needs-setup");

    // Same guild, still inside the TTL — a normal call would be served from
    // cache, but the fresh probe refetches with cache: "no-store".
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ configured: true, role_count: 1 }),
    });
    expect(await fetchLinkPluginStatus(PROBED, "777777777777777777", { fresh: true })).toEqual({
      status: "ready",
      roleCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ cache: "no-store" });

    // And the fresh answer replaces the cached one for subsequent callers.
    expect((await fetchLinkPluginStatus(PROBED, "777777777777777777")).status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never sends credentials", async () => {
    const fetchMock = mockFetchOnce({ json: () => Promise.resolve({ configured: true }) });
    await fetchLinkPluginStatus(PROBED, "555555555555555555");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
  });

  it("resolves unknown without fetching when no probe is declared", async () => {
    const fetchMock = mockFetchOnce({});
    expect((await fetchLinkPluginStatus(manifest(), "666666666666666666")).status).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
