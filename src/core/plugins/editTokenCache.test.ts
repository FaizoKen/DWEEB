import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearPluginEditToken, getPluginEditToken, setPluginEditToken } from "./editTokenCache";
import { sanitizeManagementToken } from "./protocol";

const TOKEN = "a".repeat(64);

describe("plugin edit-token cache", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts only canonical 256-bit hex tokens", () => {
    expect(sanitizeManagementToken(TOKEN)).toBe(TOKEN);
    expect(sanitizeManagementToken("A".repeat(64))).toBeUndefined();
    expect(sanitizeManagementToken("a".repeat(63))).toBeUndefined();
    expect(sanitizeManagementToken({ token: TOKEN })).toBeUndefined();
  });

  it("scopes a token to both plugin and custom id", () => {
    expect(setPluginEditToken("modalform:one", "modal-form", TOKEN)).toBe(true);
    expect(getPluginEditToken("modalform:one", "modal-form")).toBe(TOKEN);
    expect(getPluginEditToken("modalform:one", "self-role")).toBeNull();
    clearPluginEditToken("modalform:one", "modal-form");
    expect(getPluginEditToken("modalform:one", "modal-form")).toBeNull();
  });

  it("never stores malformed credentials", () => {
    expect(setPluginEditToken("modalform:one", "modal-form", "not-a-token")).toBe(false);
    expect(getPluginEditToken("modalform:one", "modal-form")).toBeNull();
  });
});
