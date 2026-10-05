import { describe, expect, it } from "vitest";
import { parseSnowflakeList } from "./SnowflakeListInput";

describe("parseSnowflakeList", () => {
  it("splits on spaces and commas, ignoring a trailing separator", () => {
    // The trailing separator is what the user just typed; the field keeps it
    // on screen while the list it parses to stays the same.
    expect(parseSnowflakeList("1185234567890123456 ")).toEqual(["1185234567890123456"]);
    expect(parseSnowflakeList("1, 2,3  4")).toEqual(["1", "2", "3", "4"]);
  });

  it("is undefined when nothing is left", () => {
    expect(parseSnowflakeList("")).toBeUndefined();
    expect(parseSnowflakeList(" , ")).toBeUndefined();
  });
});
