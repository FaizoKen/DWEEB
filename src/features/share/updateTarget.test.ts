import { describe, expect, it } from "vitest";

import {
  describeUpdateTarget,
  postedContentFor,
  rememberPostedContent,
  snowflakeTime,
  type UpdateTargetSources,
} from "./updateTarget";
import { ComponentType, type TopLevelComponent, type WebhookMessage } from "@/core/schema";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const THREAD = "333333333333333333";
const MESSAGE = "175928847299117063";

function text(content: string): WebhookMessage {
  return {
    components: [{ _id: "t", type: ComponentType.TextDisplay, content } as TopLevelComponent],
  };
}

function sources(partial: Partial<UpdateTargetSources> = {}): UpdateTargetSources {
  return {
    messageId: MESSAGE,
    input: MESSAGE,
    threadId: "",
    origin: null,
    webhook: {},
    ...partial,
  };
}

describe("snowflakeTime", () => {
  it("reads the creation time out of a Discord id (the docs' own example)", () => {
    expect(snowflakeTime(MESSAGE)).toBe(1_462_015_105_796);
  });

  it("refuses anything that isn't an id", () => {
    expect(snowflakeTime("hello")).toBeNull();
    expect(snowflakeTime("123")).toBeNull();
  });
});

describe("rememberPostedContent", () => {
  it("keeps the latest content per message and forgets the oldest past its cap", () => {
    rememberPostedContent("m-first", text("one"));
    rememberPostedContent("m-first", text("two"));
    expect(postedContentFor("m-first")?.components[0]).toMatchObject({ content: "two" });
    for (let i = 0; i < 25; i++) rememberPostedContent(`m-${i}`, text(String(i)));
    expect(postedContentFor("m-first")).toBeUndefined();
    expect(postedContentFor("m-24")).toBeDefined();
  });
});

describe("describeUpdateTarget", () => {
  it("knows at least when a bare id was posted, and nothing it can't know", () => {
    expect(describeUpdateTarget(sources())).toEqual({
      headline: null,
      postedAt: 1_462_015_105_796,
      where: null,
      guildName: null,
      discordUrl: null,
      fromEditorOrigin: false,
    });
  });

  it("links a pasted message link straight back to the message", () => {
    const link = `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`;
    expect(describeUpdateTarget(sources({ input: link })).discordUrl).toBe(link);
  });

  it("names the webhook's channel and server, and headlines the posted content", () => {
    const summary = describeUpdateTarget(
      sources({
        webhook: { guildId: GUILD, guildName: "Test server", channelId: CHANNEL },
        channelName: (id) => (id === CHANNEL ? "announcements" : undefined),
        content: text("# Patch notes\nEverything new this week"),
      }),
    );
    expect(summary).toMatchObject({
      headline: "Patch notes",
      where: "#announcements",
      guildName: "Test server",
      discordUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
    });
  });

  it("points into the thread when the message lives in one", () => {
    const summary = describeUpdateTarget(
      sources({
        threadId: THREAD,
        webhook: { guildId: GUILD, channelId: CHANNEL, channelName: "forum" },
      }),
    );
    expect(summary.where).toBe("a thread in #forum");
    expect(summary.discordUrl).toBe(`https://discord.com/channels/${GUILD}/${THREAD}/${MESSAGE}`);
  });

  it("prefers the posted-history row's own record of where it went", () => {
    const summary = describeUpdateTarget(
      sources({
        library: { guild_id: GUILD, channel_id: CHANNEL, dest_label: "#general" },
      }),
    );
    expect(summary.where).toBe("#general");
    expect(summary.discordUrl).toBe(`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`);
  });

  it("knows whether the editor's content came from this very message", () => {
    const origin = { messageId: MESSAGE, guildId: GUILD, guildName: "Test server" };
    expect(describeUpdateTarget(sources({ origin })).fromEditorOrigin).toBe(true);
    expect(describeUpdateTarget(sources({ origin })).guildName).toBe("Test server");
    expect(
      describeUpdateTarget(sources({ origin: { ...origin, messageId: "999999999999999999" } }))
        .fromEditorOrigin,
    ).toBe(false);
  });
});
