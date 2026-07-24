import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PickerGuild } from "./api";

/** Fresh module per test: the cache memoizes its storage read on first use. */
async function load() {
  vi.resetModules();
  return import("./identityCache");
}

function guild(over: Partial<PickerGuild> = {}): PickerGuild {
  return { id: "111", name: "Faizo's Lab", icon: "abc", bot_present: true, ...over };
}

describe("connected-guild identity cache", () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("survives a reload, so the icon is known before the guild list loads", async () => {
    const first = await load();
    first.rememberGuildIdentity(guild());

    // A new page load: nothing in memory, an empty guild list still in flight.
    const next = await load();
    expect(next.resolveGuildIdentity("111", [])).toEqual({
      id: "111",
      name: "Faizo's Lab",
      icon: "abc",
    });
  });

  it("only answers for the guild it cached", async () => {
    const m = await load();
    m.rememberGuildIdentity(guild());
    expect(m.cachedGuildIdentity("222")).toBeNull();
    expect(m.cachedGuildIdentity("")).toBeNull();
    expect(m.cachedGuildIdentity(null)).toBeNull();
  });

  it("prefers the live list over the cache", async () => {
    const m = await load();
    m.rememberGuildIdentity(guild());
    const renamed = [guild({ name: "Renamed", icon: "zzz" })];
    expect(m.resolveGuildIdentity("111", renamed)).toEqual({
      id: "111",
      name: "Renamed",
      icon: "zzz",
    });
  });

  it("refreshes from a loaded list, and drops a guild that list no longer has", async () => {
    const m = await load();
    m.rememberGuildIdentity(guild());

    m.syncGuildIdentity("111", [guild({ name: "Renamed", icon: null })]);
    expect(m.cachedGuildIdentity("111")).toEqual({ id: "111", name: "Renamed", icon: null });

    // Left the server / lost access: better no chip than a stale one.
    m.syncGuildIdentity("111", [guild({ id: "999" })]);
    expect(m.cachedGuildIdentity("111")).toBeNull();
    expect(values.size).toBe(0);
  });

  it("keeps the cache when no guild is connected", async () => {
    const m = await load();
    m.rememberGuildIdentity(guild());
    m.syncGuildIdentity("", []);
    expect(m.cachedGuildIdentity("111")).not.toBeNull();
  });

  it("discards a corrupt or partial entry instead of trusting it", async () => {
    values.set("dweeb.guild.identity.v1", JSON.stringify({ id: "111" }));
    expect((await load()).cachedGuildIdentity("111")).toBeNull();

    values.set("dweeb.guild.identity.v1", "{not json");
    expect((await load()).cachedGuildIdentity("111")).toBeNull();
  });

  it("never throws when storage is unavailable", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    const m = await load();
    expect(() => m.rememberGuildIdentity(guild())).not.toThrow();
    expect(() => m.clearCachedGuildIdentity()).not.toThrow();
    expect(m.resolveGuildIdentity("111", [guild()])?.name).toBe("Faizo's Lab");
  });
});
