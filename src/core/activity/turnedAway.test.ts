import { beforeEach, describe, expect, it } from "vitest";
import {
  resetTurnedAwayNotice,
  shouldNoteTurnedAway,
  TURNED_AWAY_NOTICE_GAP_MS,
  turnedAwayNotice,
} from "./turnedAway";

describe("turned-away notice", () => {
  beforeEach(() => resetTurnedAwayNotice());

  it("names who was refused and the plan's limit", () => {
    expect(turnedAwayNotice("Sam", 2)).toBe(
      "Sam couldn't join — this server's plan allows 2 live editors.",
    );
    expect(turnedAwayNotice("  ", 2)).toBe(
      "Someone couldn't join — this server's plan allows 2 live editors.",
    );
    expect(turnedAwayNotice("Sam", 0)).toBe("Sam couldn't join — this room is full.");
  });

  it("shows one notice per ten minutes, however many are refused", () => {
    const t = 1_000_000;
    expect(shouldNoteTurnedAway(t)).toBe(true);
    expect(shouldNoteTurnedAway(t + 60_000)).toBe(false);
    expect(shouldNoteTurnedAway(t + TURNED_AWAY_NOTICE_GAP_MS - 1)).toBe(false);
    expect(shouldNoteTurnedAway(t + TURNED_AWAY_NOTICE_GAP_MS)).toBe(true);
  });
});
