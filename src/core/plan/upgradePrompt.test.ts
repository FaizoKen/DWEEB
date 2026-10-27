import { describe, expect, it } from "vitest";
import { nearCap, promptLimit } from "./upgradePrompt";

describe("upgrade prompts", () => {
  it("points each limit prompt at its plan limit, and the general entries at none", () => {
    expect(promptLimit("saved_messages")).toBe("library");
    expect(promptLimit("posted_history")).toBe("library_posted");
    expect(promptLimit("send_slots")).toBe("permanent");
    expect(promptLimit("posted_slots")).toBe("permanent");
    expect(promptLimit("scheduled")).toBe("schedules");
    expect(promptLimit("custom_bots")).toBe("custom_bots");
    expect(promptLimit("ai")).toBe("ai_requests");
    expect(promptLimit("room_full")).toBe("coeditors");
    expect(promptLimit("plan_badge")).toBeNull();
    expect(promptLimit("account_menu")).toBeNull();
    expect(promptLimit("activity")).toBeNull();
    expect(promptLimit(null)).toBeNull();
  });

  it("calls a limit near once its last fifth is in use", () => {
    expect(nearCap(3, 5)).toBe(false);
    expect(nearCap(4, 5)).toBe(true);
    expect(nearCap(5, 5)).toBe(true);
    expect(nearCap(7, 10)).toBe(false);
    expect(nearCap(8, 10)).toBe(true);
    // A cap of 3 rounds up: only the cap itself counts.
    expect(nearCap(2, 3)).toBe(false);
    expect(nearCap(3, 3)).toBe(true);
    // Over the cap (after a downgrade) is near too.
    expect(nearCap(12, 10)).toBe(true);
  });

  it("never calls an unlimited or unknown cap near", () => {
    expect(nearCap(1000, null)).toBe(false);
    expect(nearCap(1000, undefined)).toBe(false);
    expect(nearCap(0, 0)).toBe(false);
  });
});
