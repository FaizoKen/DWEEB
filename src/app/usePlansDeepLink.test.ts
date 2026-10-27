import { describe, expect, it } from "vitest";
import { parsePendingIntent, readPlansIntent, readPlansParam } from "./usePlansDeepLink";

const G = "123456789012345678";

describe("plans deep link", () => {
  it("reads the server and the prompt that sent them", () => {
    expect(readPlansIntent(`?plans=${G}&plans_from=room_full`)).toEqual({
      guild: G,
      from: "room_full",
    });
  });

  it("reads a link without a prompt — or with an unknown one — as the plain hand-off", () => {
    expect(readPlansIntent(`?plans=${G}`)).toEqual({ guild: G, from: "activity" });
    expect(readPlansIntent(`?plans=${G}&plans_from=<script>`)).toEqual({
      guild: G,
      from: "activity",
    });
  });

  it("needs a real server id", () => {
    expect(readPlansParam("?plans=abc")).toBeNull();
    expect(readPlansIntent("?plans_from=room_full")).toBeNull();
  });

  it("reads back a stored intent, including one a tab predating the prompt stored", () => {
    expect(parsePendingIntent(`${G}:room_full`)).toEqual({ guild: G, from: "room_full" });
    // Only the Activity's prompts travel this way; anything else is its hand-off.
    expect(parsePendingIntent(`${G}:saved_messages`)).toEqual({ guild: G, from: "activity" });
    expect(parsePendingIntent(G)).toEqual({ guild: G, from: "activity" });
    expect(parsePendingIntent("nope:room_full")).toBeNull();
    expect(parsePendingIntent(null)).toBeNull();
  });
});
