import { describe, expect, it } from "vitest";
import type { PlanInfo } from "@/core/guild/api";
import { limitFocus, pricingView, QUOTA_ROWS, splitQuota } from "./pricingView";
import { promptLimit } from "@/core/plan/upgradePrompt";

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

describe("splitQuota", () => {
  it("counts the number in a worded quota and keeps the words", () => {
    // The purchase ledger used to count `Number("Last 100")` up to "NaN".
    expect(splitQuota("Last 100")).toEqual({ prefix: "Last ", n: 100 });
    expect(splitQuota("30")).toEqual({ prefix: "", n: 30 });
  });

  it("has nothing to count in a value that ends in no number", () => {
    expect(splitQuota("Unlimited")).toBeNull();
    expect(splitQuota("")).toBeNull();
  });
});

describe("limitFocus", () => {
  it("opens on the limit a prompt was about, with every higher plan's allowance", () => {
    expect(limitFocus("saved_messages", "free")).toEqual({
      key: "library",
      label: "Saved messages",
      current: { tier: "free", value: "10" },
      upgrades: [
        { tier: "plus", value: "100" },
        { tier: "pro", value: "Unlimited" },
      ],
    });
    // On Plus, only Pro is above.
    expect(limitFocus("room_full", "plus")).toMatchObject({
      label: "Live co-editors",
      current: { tier: "plus", value: "6" },
      upgrades: [{ tier: "pro", value: "25" }],
    });
  });

  it("has nothing to point at for a general entry, an unknown plan, or the top tier", () => {
    expect(limitFocus("plan_badge", "free")).toBeNull();
    expect(limitFocus(null, "free")).toBeNull();
    expect(limitFocus("saved_messages", null)).toBeNull();
    expect(limitFocus("saved_messages", "pro")).toBeNull();
  });

  it("names a row for every limit a prompt can point at", () => {
    const keys = new Set(QUOTA_ROWS.map((r) => r.key));
    for (const prompt of [
      "send_slots",
      "posted_slots",
      "posted_history",
      "scheduled",
      "saved_messages",
      "custom_bots",
      "ai",
      "room_full",
    ] as const) {
      const key = promptLimit(prompt);
      expect(key && keys.has(key), prompt).toBe(true);
    }
  });
});
