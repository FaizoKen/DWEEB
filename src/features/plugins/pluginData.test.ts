import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePluginResource, savedWebhookMetadata } from "./pluginData";

const STORAGE_KEY = "dweeb.webhook_history.v1";
const SECRET_URL = "https://discord.com/api/webhooks/123456789012345678/secret-token";

describe("plugin webhook resources", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: "123456789012345678",
          url: SECRET_URL,
          name: "Reports",
          channelName: "staff",
          guildName: "Example",
          lastUsedAt: 1,
        },
      ]),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lists safe webhook metadata without execute URLs", () => {
    const result = resolvePluginResource("savedWebhooks", { target: "button" });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET_URL);
    expect(result).toMatchObject({
      data: [{ id: "123456789012345678", name: "Reports", channelName: "staff" }],
    });
    expect(savedWebhookMetadata("123456789012345678")).not.toHaveProperty("url");
  });

  it("releases one credential only with explicit approval and an exact id", () => {
    expect(
      resolvePluginResource("savedWebhook", {
        target: "button",
        resourceId: "123456789012345678",
      }),
    ).toMatchObject({ ok: false });

    expect(
      resolvePluginResource("savedWebhook", {
        target: "button",
        resourceId: "123456789012345678",
        allowCredential: true,
      }),
    ).toEqual({
      ok: true,
      data: { id: "123456789012345678", url: SECRET_URL },
    });
  });
});
