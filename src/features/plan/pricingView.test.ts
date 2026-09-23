import { describe, expect, it } from "vitest";
import type { PlanInfo } from "@/core/guild/api";
import { pricingView } from "./pricingView";

/**
 * The pricing modal's state, read off the plan store. Every Upgrade, promo, and
 * billing control hangs off a loaded plan, so each way of *not* having one must
 * land on a state that says so — the modal used to render the cards with a
 * blank where the buttons go for all of them.
 */

const G = "111111111111111111";
const PLAN: PlanInfo = {
  tier: "free",
  limits: { schedules: 3, permanent: 5, custom_bots: 1, coeditors: 2, library: 10 },
  billing: true,
};

describe("pricingView", () => {
  it("asks for a server only when there is no server id", () => {
    expect(pricingView(null, "idle", null)).toBe("no-server");
    // Even a stale plan can't stand in for a missing server.
    expect(pricingView(null, "ready", PLAN)).toBe("no-server");
  });

  it("shows a server whose plan is on its way as loading, not as 'no server'", () => {
    expect(pricingView(G, "loading", null)).toBe("loading");
    // A load sets the id and "loading" together; "idle" beside an id is a load
    // about to start, never a dead end.
    expect(pricingView(G, "idle", null)).toBe("loading");
  });

  it("reports a failed read as an error (the store holds the reason)", () => {
    expect(pricingView(G, "error", null)).toBe("error");
  });

  it("reads a settled read with no plan as a lapsed sign-in (the store's 401 shape)", () => {
    expect(pricingView(G, "ready", null)).toBe("signed-out");
  });

  it("keeps a plan in hand usable through a background refresh or its failure", () => {
    expect(pricingView(G, "ready", PLAN)).toBe("ready");
    expect(pricingView(G, "loading", PLAN)).toBe("ready");
    expect(pricingView(G, "error", PLAN)).toBe("ready");
  });
});
