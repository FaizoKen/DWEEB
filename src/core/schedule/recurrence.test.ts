import { describe, expect, it } from "vitest";

import { localDateTimeValue } from "./recurrence";

describe("localDateTimeValue", () => {
  it("writes the local wall clock in the datetime-local input's format", () => {
    const ms = new Date(2026, 0, 5, 9, 7, 42).getTime();
    expect(localDateTimeValue(ms)).toBe("2026-01-05T09:07");
  });

  it("round-trips through Date.parse, which reads that format as local time", () => {
    const ms = new Date(2026, 8, 23, 15, 30).getTime();
    expect(Date.parse(localDateTimeValue(ms))).toBe(ms);
  });

  it("orders like the instants it came from, so it works as an input's min", () => {
    const earlier = localDateTimeValue(new Date(2026, 8, 23, 9, 59).getTime());
    const later = localDateTimeValue(new Date(2026, 8, 23, 10, 0).getTime());
    expect(earlier < later).toBe(true);
  });
});
