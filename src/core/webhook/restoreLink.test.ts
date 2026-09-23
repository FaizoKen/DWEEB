import { describe, expect, it } from "vitest";

import { linkThread, linkThreadId } from "./restoreLink";

const GUILD = "111111111111111111";
const WEBHOOK_CHANNEL = "222222222222222222";
const THREAD = "333333333333333333";
const SIBLING = "444444444444444444";
const MESSAGE = "555555555555555555";
const link = (channel: string) => `https://discord.com/channels/${GUILD}/${channel}/${MESSAGE}`;
const known = (id: string) => id === WEBHOOK_CHANNEL || id === SIBLING;

describe("linkThread", () => {
  it("infers nothing from a bare id", () => {
    expect(linkThread(MESSAGE, { webhookChannelId: WEBHOOK_CHANNEL })).toEqual({ kind: "none" });
  });

  it("never sends the webhook's own channel as a thread id", () => {
    const thread = linkThread(link(WEBHOOK_CHANNEL), { webhookChannelId: WEBHOOK_CHANNEL });
    expect(thread).toEqual({ kind: "channel", channelId: WEBHOOK_CHANNEL });
    expect(linkThreadId(thread)).toBeNull();
  });

  it("reads a different channel segment as the thread the message lives in", () => {
    const thread = linkThread(link(THREAD), {
      webhookChannelId: WEBHOOK_CHANNEL,
      isKnownChannel: known,
    });
    expect(thread).toEqual({ kind: "thread", threadId: THREAD });
    expect(linkThreadId(thread)).toBe(THREAD);
  });

  it("never treats a regular channel of the server as a thread", () => {
    expect(
      linkThread(link(SIBLING), { webhookChannelId: WEBHOOK_CHANNEL, isKnownChannel: known }),
    ).toEqual({ kind: "channel", channelId: SIBLING });
    // …even before the webhook's own channel is known.
    expect(linkThread(link(WEBHOOK_CHANNEL), { isKnownChannel: known })).toEqual({
      kind: "channel",
      channelId: WEBHOOK_CHANNEL,
    });
  });

  it("only suspects a thread while the webhook's channel is unknown", () => {
    const thread = linkThread(link(THREAD), {});
    expect(thread).toEqual({ kind: "unknown", threadId: THREAD });
    expect(linkThreadId(thread)).toBe(THREAD);
  });
});
