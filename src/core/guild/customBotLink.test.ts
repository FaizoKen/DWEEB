import { describe, expect, it } from "vitest";
import {
  CUSTOM_BOT_QUERY_KEY,
  customBotConfigUrl,
  readCustomBotParam,
  withoutCustomBotParam,
} from "./customBotLink";

const GUILD_ID = "123456789012345678";

describe("custom-bot web links", () => {
  it("reads a valid guild snowflake without depending on query order", () => {
    expect(readCustomBotParam(`?theme=dark&${CUSTOM_BOT_QUERY_KEY}=${GUILD_ID}&x=1`)).toBe(
      GUILD_ID,
    );
  });

  it("rejects missing, malformed, and out-of-range ids", () => {
    expect(readCustomBotParam("")).toBeNull();
    expect(readCustomBotParam(`?${CUSTOM_BOT_QUERY_KEY}=not-a-guild`)).toBeNull();
    expect(readCustomBotParam(`?${CUSTOM_BOT_QUERY_KEY}=1234567890123456`)).toBeNull();
    expect(readCustomBotParam(`?${CUSTOM_BOT_QUERY_KEY}=123456789012345678901`)).toBeNull();
  });

  it("builds a root web-app URL and normalizes trailing slashes", () => {
    expect(customBotConfigUrl("https://dweeb.example///", GUILD_ID)).toBe(
      `https://dweeb.example/?${CUSTOM_BOT_QUERY_KEY}=${GUILD_ID}`,
    );
  });

  it("strips only its own parameter and preserves unrelated query and hash state", () => {
    expect(
      withoutCustomBotParam(
        `https://dweeb.example/editor?theme=dark&${CUSTOM_BOT_QUERY_KEY}=${GUILD_ID}#draft`,
      ),
    ).toBe("/editor?theme=dark#draft");
  });
});
