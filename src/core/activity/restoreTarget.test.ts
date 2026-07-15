/**
 * `planRestore` — how the Activity's Restore reads an input against its fixed
 * server + current channel. The Activity posts (and reads) through one channel of
 * the launching server, so a pasted link can mean four different things; these
 * tests pin each, and in particular that a link into a *sibling* channel is
 * recognised as a switch — not mistaken for a thread and handed to Discord as a
 * `thread_id` (which answers "Unknown Channel", the bug this closes).
 */

import { describe, expect, it } from "vitest";
import { planRestore } from "./restoreTarget";

const GUILD = "111111111111111111";
const OTHER_GUILD = "222222222222222222";
const CURRENT_CHANNEL = "900000000000000001";
const OTHER_CHANNEL = "900000000000000002";
const THREAD = "955555555555555555";
const MSG = "700000000000000001";

/** The current server knows its two real channels; a thread id is not in the
 *  channel list, exactly as the guild store models it. */
const ctx = {
  guildId: GUILD,
  channelId: CURRENT_CHANNEL,
  isKnownChannel: (id: string) => id === CURRENT_CHANNEL || id === OTHER_CHANNEL,
};

const link = (guild: string, channel: string, message = MSG) =>
  `https://discord.com/channels/${guild}/${channel}/${message}`;

describe("planRestore", () => {
  it("treats a bare message id as a direct restore from the current channel", () => {
    expect(planRestore(MSG, ctx)).toEqual({ kind: "direct", messageId: MSG });
  });

  it("rejects input with no usable message id", () => {
    expect(planRestore("", ctx)).toEqual({ kind: "invalid" });
    expect(planRestore("not a message", ctx)).toEqual({ kind: "invalid" });
  });

  it("restores directly when the link already points at the current channel", () => {
    expect(planRestore(link(GUILD, CURRENT_CHANNEL), ctx)).toEqual({
      kind: "direct",
      messageId: MSG,
    });
  });

  it("offers a switch when the link points at a different channel in this server", () => {
    expect(planRestore(link(GUILD, OTHER_CHANNEL), ctx)).toEqual({
      kind: "switch",
      messageId: MSG,
      channelId: OTHER_CHANNEL,
    });
  });

  it("reads a thread in place when the link segment isn't a known channel", () => {
    // A forum/media post (or a thread under a channel) — the segment is the
    // thread id, which the channel list never contains.
    expect(planRestore(link(GUILD, THREAD), ctx)).toEqual({
      kind: "thread",
      messageId: MSG,
      threadId: THREAD,
    });
  });

  it("refuses a link into a different server — the room can't follow it", () => {
    expect(planRestore(link(OTHER_GUILD, OTHER_CHANNEL), ctx)).toEqual({ kind: "foreign" });
  });

  it("treats a DM/group-DM link (@me) as foreign — DMs host no DWEEB posts", () => {
    expect(planRestore(`https://discord.com/channels/@me/${OTHER_CHANNEL}/${MSG}`, ctx)).toEqual({
      kind: "foreign",
    });
  });

  it("prefers the same-channel direct read even for a channel that is 'known'", () => {
    // The current channel is itself in the known set; the same-channel check must
    // win so it never proposes switching to the channel you're already on.
    expect(planRestore(link(GUILD, CURRENT_CHANNEL), ctx)).toEqual({
      kind: "direct",
      messageId: MSG,
    });
  });
});
