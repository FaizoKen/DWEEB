import { describe, expect, it } from "vitest";
import type { PlanTier } from "@/core/guild/api";
import { holdsPlanFor, ownPlanState, paidSubsHere } from "./ownSubscription";
import type { PremiumSubscription } from "./stripeApi";

const HERE = "111111111111111111";
const ELSEWHERE = "222222222222222222";

function sub(over: Partial<PremiumSubscription> = {}): PremiumSubscription {
  return {
    id: "sub_1",
    guildId: HERE,
    tier: "plus",
    status: "active",
    currentPeriodEnd: 1_900_000_000,
    cancelAtPeriodEnd: false,
    movableAt: null,
    ...over,
  };
}

const state = (subs: PremiumSubscription[], current: PlanTier | null) =>
  ownPlanState(subs, HERE, current);

describe("ownPlanState", () => {
  it("changes an active plan of theirs instead of selling another", () => {
    expect(state([sub()], "plus")).toBe("change");
    expect(state([sub({ status: "trialing" })], "plus")).toBe("change");
  });

  it("asks for a renewal when theirs is ending", () => {
    expect(state([sub({ cancelAtPeriodEnd: true })], "plus")).toBe("renew");
  });

  it("won't sell over an overdue plan that would cover this server", () => {
    for (const status of ["past_due", "unpaid", "paused"]) {
      expect(state([sub({ status })], "free")).toBe("overdue");
      expect(state([sub({ status, guildId: null })], "free")).toBe("overdue");
    }
    expect(state([sub({ status: "past_due", guildId: ELSEWHERE })], "free")).toBeNull();
  });

  it("prefers changing a good plan over an overdue one stacked beside it", () => {
    expect(state([sub({ status: "past_due" }), sub({ id: "sub_2" })], "plus")).toBe("change");
  });

  it("leaves everyone else's purchase alone", () => {
    expect(state([], "free")).toBeNull();
    expect(state([], "plus")).toBeNull();
    expect(state([sub({ guildId: ELSEWHERE })], "free")).toBeNull();
    expect(state([sub({ tier: "free" })], "free")).toBeNull();
    expect(state([sub({ tier: "pro" })], "pro")).toBeNull();
    expect(state([sub()], null)).toBeNull();
  });
});

describe("paidSubsHere", () => {
  it("doesn't count RoleLogic's Small as paying for the server", () => {
    expect(paidSubsHere([sub({ tier: "free" })], HERE)).toEqual([]);
    expect(paidSubsHere([sub()], HERE)).toHaveLength(1);
    expect(paidSubsHere([sub({ guildId: null })], null)).toEqual([]);
  });
});

describe("holdsPlanFor", () => {
  it("counts a plan here or unassigned, paid or overdue", () => {
    expect(holdsPlanFor([sub()], HERE)).toBe(true);
    expect(holdsPlanFor([sub({ guildId: null, status: "past_due" })], HERE)).toBe(true);
    expect(holdsPlanFor([sub({ guildId: ELSEWHERE })], HERE)).toBe(false);
    expect(holdsPlanFor([sub({ tier: "free", guildId: null })], HERE)).toBe(false);
  });
});
