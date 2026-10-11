import { describe, expect, it } from "vitest";
import { threadIdFromInput } from "./threadInput";

const GUILD = "1185234567890123456";
const THREAD = "1558142497497022585";
const MESSAGE = "1558142497497099999";

describe("threadIdFromInput", () => {
  it("keeps a bare id", () => {
    expect(threadIdFromInput(THREAD)).toBe(THREAD);
  });

  it("drops everything that isn't a digit from typed text", () => {
    expect(threadIdFromInput(` ${THREAD}\n`)).toBe(THREAD);
  });

  it("reads the thread from a post's Copy Link", () => {
    expect(threadIdFromInput(`https://discord.com/channels/${GUILD}/${THREAD}`)).toBe(THREAD);
  });

  it("reads the thread from a message link inside it", () => {
    expect(
      threadIdFromInput(`https://canary.discord.com/channels/${GUILD}/${THREAD}/${MESSAGE}`),
    ).toBe(THREAD);
    expect(threadIdFromInput(`https://discordapp.com/channels/${GUILD}/${THREAD}/${MESSAGE}`)).toBe(
      THREAD,
    );
  });

  it("never glues a link's ids together", () => {
    expect(threadIdFromInput(`https://discord.com/channels/${GUILD}/${THREAD}`)).not.toContain(
      GUILD,
    );
  });
});
