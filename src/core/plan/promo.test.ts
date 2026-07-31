import { describe, expect, it } from "vitest";
import {
  ACTIVE_PROMO,
  applyPercentOff,
  formatUsd,
  promoFor,
  promoIsLive,
  type PromoCampaign,
} from "./promo";

/** A campaign with the shape of the live one, for the rule tests. */
function campaign(over: Partial<PromoCampaign> = {}): PromoCampaign {
  return {
    code: "TESTCODE",
    percentOff: 50,
    tiers: ["plus"],
    duration: "first-payment",
    ...over,
  };
}

describe("ACTIVE_PROMO", () => {
  // A change-detector on purpose. Every field here is a claim the modal prints
  // as a price, and the only thing that makes the claim true is the coupon in
  // the shared live Stripe account. Editing this test is the reminder that
  // Stripe has to be edited with it (or the campaign set to null) — the failure
  // mode otherwise is a buyer clicking Upgrade on an advertised $2.50 and
  // getting a refusal.
  it("matches the coupon behind MEDIUMPROMO in Stripe", () => {
    expect(ACTIVE_PROMO).toEqual({
      code: "MEDIUMPROMO",
      percentOff: 50,
      // Stripe coupon `duration: "once"` — the discount covers the first invoice
      // only, which is why the card must also print the renewal price.
      duration: "first-payment",
      // Plus alone, and not by convention: the coupon is scoped to the Medium
      // product, which owns both prices Plus buys. Adding "pro" here would
      // advertise a discount Stripe refuses at session creation — the card would
      // promise $5/mo and the click would answer "That promo code can't be used
      // on this plan".
      tiers: ["plus"],
    });
  });

  it("is live as shipped", () => {
    expect(promoIsLive(ACTIVE_PROMO)).toBe(true);
  });
});

describe("promoIsLive", () => {
  it("treats no campaign as nothing running", () => {
    expect(promoIsLive(null)).toBe(false);
  });

  it("refuses a campaign that discounts nothing or more than everything", () => {
    expect(promoIsLive(campaign({ percentOff: 0 }))).toBe(false);
    expect(promoIsLive(campaign({ percentOff: -10 }))).toBe(false);
    expect(promoIsLive(campaign({ percentOff: 101 }))).toBe(false);
    expect(promoIsLive(campaign({ percentOff: 100 }))).toBe(true);
  });

  it("refuses a campaign with no code or no eligible tier", () => {
    expect(promoIsLive(campaign({ code: "   " }))).toBe(false);
    expect(promoIsLive(campaign({ tiers: [] }))).toBe(false);
  });

  it("stops advertising once the window has passed", () => {
    const c = campaign({ endsAt: "2026-09-01" });
    expect(promoIsLive(c, Date.parse("2026-08-31T00:00:00Z"))).toBe(true);
    expect(promoIsLive(c, Date.parse("2026-09-02T00:00:00Z"))).toBe(false);
  });

  it("fails closed on an end date it cannot read", () => {
    // The alternative — ignoring the field — would advertise the offer forever,
    // which is exactly the case the date was added to prevent.
    expect(promoIsLive(campaign({ endsAt: "next tuesday" }))).toBe(false);
  });
});

describe("promoFor", () => {
  it("covers the named tier and no other", () => {
    expect(promoFor("plus", "month", campaign())).not.toBeNull();
    expect(promoFor("pro", "month", campaign())).toBeNull();
  });

  it("covers both intervals unless the campaign narrows them", () => {
    expect(promoFor("plus", "year", campaign())).not.toBeNull();
    const monthlyOnly = campaign({ intervals: ["month"] });
    expect(promoFor("plus", "month", monthlyOnly)).not.toBeNull();
    expect(promoFor("plus", "year", monthlyOnly)).toBeNull();
  });

  it("covers nothing while no campaign is live", () => {
    expect(promoFor("plus", "month", null)).toBeNull();
    expect(promoFor("plus", "month", campaign({ endsAt: "2020-01-01" }))).toBeNull();
  });
});

describe("price arithmetic", () => {
  it("halves the shipped Plus prices to the advertised figures", () => {
    expect(applyPercentOff(5, 50)).toBe(2.5);
    expect(applyPercentOff(50, 50)).toBe(25);
  });

  it("rounds to whole cents rather than trailing float noise", () => {
    expect(applyPercentOff(9.99, 50)).toBe(5);
    expect(applyPercentOff(10, 33)).toBe(6.7);
  });

  it("prints whole dollars bare and cents in full", () => {
    expect(formatUsd(5)).toBe("$5");
    expect(formatUsd(50)).toBe("$50");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(2.5)).toBe("$2.50");
    expect(formatUsd(4.995)).toBe("$5");
  });
});
