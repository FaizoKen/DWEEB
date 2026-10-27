import { describe, expect, it } from "vitest";
import { isServerScheduleCap } from "./api";

describe("isServerScheduleCap", () => {
  it("recognises the server's plan cap, old wording and new", () => {
    expect(
      isServerScheduleCap(
        "This server already has the maximum of 3 scheduled posts — cancel one to add another.",
      ),
    ).toBe(true);
    expect(
      isServerScheduleCap(
        "This server already has the maximum of 3 scheduled posts — cancel one to add another, or upgrade the server's plan for more.",
      ),
    ).toBe(true);
  });

  it("never offers a plan for the per-webhook ceiling, which no plan raises", () => {
    expect(
      isServerScheduleCap("That webhook already has the maximum of 10 active schedules."),
    ).toBe(false);
    expect(isServerScheduleCap("Couldn't reach the scheduling service.")).toBe(false);
    expect(isServerScheduleCap(null)).toBe(false);
  });
});
