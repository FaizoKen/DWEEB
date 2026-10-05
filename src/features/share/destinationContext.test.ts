import { describe, expect, it } from "vitest";

import { destinationPlaceholderContext, scheduleDestLabel } from "./destinationContext";

const guilds = [{ id: "111111111111111111", name: "Faizo's Lab", icon: "abc" }];
const channelById = {
  "222222222222222222": { name: "general", parentId: "333333333333333333" },
  "333333333333333333": { name: "Text Channels", parentId: null },
};

describe("destinationPlaceholderContext", () => {
  it("resolves names, icon and category from the ids this post resolved", () => {
    expect(
      destinationPlaceholderContext(
        { guildId: "111111111111111111", channelId: "222222222222222222" },
        guilds,
        channelById,
      ),
    ).toEqual({
      serverId: "111111111111111111",
      serverName: "Faizo's Lab",
      serverIcon: "https://cdn.discordapp.com/icons/111111111111111111/abc.webp?size=256",
      channelId: "222222222222222222",
      channelName: "general",
      channelCategory: "Text Channels",
    });
  });

  it("prefers the names saved on the webhook's own entry", () => {
    const ctx = destinationPlaceholderContext(
      { guildId: "111111111111111111", guildName: "Saved name", channelName: "saved-channel" },
      guilds,
      channelById,
    );
    expect(ctx.serverName).toBe("Saved name");
    expect(ctx.channelName).toBe("saved-channel");
  });

  it("knows nothing it wasn't told — the send path refuses what stays unresolved", () => {
    expect(destinationPlaceholderContext({}, guilds, channelById)).toEqual({
      serverId: undefined,
      serverName: undefined,
      serverIcon: undefined,
      channelId: undefined,
      channelName: undefined,
      channelCategory: undefined,
    });
  });
});

describe("scheduleDestLabel", () => {
  it("names channel and server, or the server alone", () => {
    expect(scheduleDestLabel("Lab", "general")).toBe("#general · Lab");
    expect(scheduleDestLabel("Lab", undefined)).toBe("Lab");
    expect(scheduleDestLabel(undefined, "general")).toBeUndefined();
  });

  // Two 100-character names used to fail the whole schedule server-side.
  it("stays within the server's 200-character limit, counted as the server counts", () => {
    const label = scheduleDestLabel("🎮".repeat(100), "c".repeat(100))!;
    expect(Array.from(label).length).toBe(200);
    expect(label.endsWith("…")).toBe(true);
  });
});
