import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const records = new Map<string, string>();
const getItem = vi.fn((key: string) => records.get(key) ?? null);
const setItem = vi.fn((key: string, value: string) => {
  records.set(key, value);
});

beforeEach(() => {
  vi.resetModules();
  records.clear();
  getItem.mockClear();
  setItem.mockClear();
  vi.stubGlobal("localStorage", {
    getItem,
    setItem,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plugin summary memory cache", () => {
  it("reads and parses persistent storage only once across repeated lookups", async () => {
    records.set(
      "dweeb.plugins.summaries.v1",
      JSON.stringify({
        "picker:one": { pluginId: "picker", summary: { label: "Choose a role" } },
      }),
    );
    const { getPluginSummary } = await import("./pluginSummaryCache");

    expect(getPluginSummary("picker:one")?.summary.label).toBe("Choose a role");
    expect(getPluginSummary("picker:one")?.summary.label).toBe("Choose a role");
    expect(getPluginSummary("missing")).toBeNull();
    expect(getItem).toHaveBeenCalledOnce();
  });

  it("updates the in-memory map on writes without rereading storage", async () => {
    const { clearPluginSummary, getPluginSummary, setPluginSummary } =
      await import("./pluginSummaryCache");

    setPluginSummary("picker:one", "picker", { label: "Choose a role" }, "123");
    expect(getPluginSummary("picker:one")).toMatchObject({
      pluginId: "picker",
      guildId: "123",
      summary: { label: "Choose a role" },
    });
    clearPluginSummary("picker:one");
    expect(getPluginSummary("picker:one")).toBeNull();
    expect(getItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledTimes(2);
  });
});
