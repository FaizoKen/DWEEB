import { describe, expect, it } from "vitest";

import { compareSnowflakes } from "./snowflakeOrder";

describe("compareSnowflakes", () => {
  it("orders an 18-digit (older) id before a 19-digit (newer) one", () => {
    const older = "999999999999999999";
    const newer = "1000000000000000000";
    expect(older.localeCompare(newer)).toBeGreaterThan(0); // the old, wrong order
    expect([newer, older].sort(compareSnowflakes)).toEqual([older, newer]);
  });

  it("orders same-length ids numerically", () => {
    expect(["123456789012345679", "123456789012345678"].sort(compareSnowflakes)).toEqual([
      "123456789012345678",
      "123456789012345679",
    ]);
  });
});
