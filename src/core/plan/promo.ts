/**
 * The promotional campaign the pricing modal advertises, as pure functions.
 *
 * A campaign here is **presentation only**: the discount itself lives in Stripe
 * as a coupon behind the promotion code named below. The modal shows the
 * discounted price and hands that code to the proxy when the buyer upgrades an
 * eligible tier (`PricingModal` → `createCheckout`), which is also the only way
 * the discount can land — the session is minted without `allow_promotion_codes`,
 * so a code must be applied as it is created (`server/src/stripe.rs`).
 *
 * **Keep this in sync with Stripe.** If the coupon is edited, expires, or is
 * archived, edit `ACTIVE_PROMO` (or set it to `null`) in the same change —
 * otherwise the modal advertises a price checkout will refuse, and the refusal
 * arrives as a toast *after* the buyer has clicked Upgrade. Nothing here creates
 * or verifies anything in Stripe: the coupon and its promotion code are made by
 * hand in the shared (RoleLogic) live Stripe account.
 *
 * Why a campaign can be trusted to apply at all: DWEEB's tiers buy the sibling
 * RoleLogic prices (Plus = Medium $5/$50, Pro = Expanded $10/$100 — see
 * `STRIPE_CHECKOUT_PRICE_*`), and a coupon may be restricted to specific
 * products via its `applies_to`. A campaign must therefore only name tiers whose
 * price the coupon actually accepts. `MEDIUMPROMO`'s coupon is scoped to the
 * **Medium product** (`prod_UeGAzNYBoaQ00G`), which owns both of the prices Plus
 * buys — so Plus is safe on either interval, and **Pro must never be added**:
 * Stripe refuses the session, and the buyer gets "That promo code can't be used
 * on this plan" from a card that promised a discount.
 *
 * Checking that in Stripe has a trap worth knowing (it is what a first reading of
 * this account got wrong, 2026-08-01): `applies_to` is an **expandable** field,
 * so a plain `GET /v1/coupons/{id}` omits it entirely and an unrestricted coupon
 * is indistinguishable from a restricted one. Ask for it —
 * `?expand[]=applies_to` — and never read its absence as "unrestricted". Same
 * shape of hazard as `promotion.coupon` in `server/src/stripe.rs`.
 */

import type { BillingInterval, PaidTier } from "./stripeApi";

/** How long the coupon keeps discounting a subscription — drives the fine print. */
export type PromoDuration = "forever" | "first-payment";

export interface PromoCampaign {
  /** The Stripe promotion code buyers see (and that we auto-apply). */
  code: string;
  /** Percentage taken off the list price. Must match the Stripe coupon. */
  percentOff: number;
  /** The tiers it may be redeemed against. */
  tiers: PaidTier[];
  /** Billing intervals it applies to. Omit for both. */
  intervals?: BillingInterval[];
  /** Whether the discount repeats forever or only covers the first invoice. */
  duration: PromoDuration;
  /** ISO date after which the offer stops being advertised. Omit for open-ended. */
  endsAt?: string;
}

/**
 * The live campaign, or `null` when nothing is running.
 *
 * `MEDIUMPROMO`: 50% off the first payment on Plus (monthly and annual). Plus is
 * the tier worth pushing — it is the jump that turns the metered quotas from
 * "try it out" into "run a server with it" — and the code is the same one the
 * sibling RoleLogic app advertises on Medium, which is the very same Stripe
 * price DWEEB's Plus buys.
 *
 * `duration` is what keeps the modal honest: a first-payment discount must
 * advertise the renewal price beside the discounted one, or the headline is a
 * bait price.
 */
export const ACTIVE_PROMO: PromoCampaign | null = {
  code: "MEDIUMPROMO",
  percentOff: 50,
  tiers: ["plus"],
  duration: "first-payment",
};

/** Whether the campaign is still inside its advertising window. */
export function promoIsLive(
  campaign: PromoCampaign | null,
  now: number = Date.now(),
): campaign is PromoCampaign {
  if (!campaign) return false;
  if (!campaign.code.trim()) return false;
  if (campaign.percentOff <= 0 || campaign.percentOff > 100) return false;
  if (campaign.tiers.length === 0) return false;
  if (!campaign.endsAt) return true;
  const ends = Date.parse(campaign.endsAt);
  // An unparseable end date must not silently extend the offer forever.
  if (Number.isNaN(ends)) return false;
  return now < ends;
}

/**
 * The campaign covering a given tier + interval, or `null`. This is the single
 * decision behind both halves of the offer — the discounted price the card shows
 * and the code checkout receives — so the two can never disagree.
 */
export function promoFor(
  tier: PaidTier,
  interval: BillingInterval,
  campaign: PromoCampaign | null = ACTIVE_PROMO,
  now: number = Date.now(),
): PromoCampaign | null {
  if (!promoIsLive(campaign, now)) return null;
  if (!campaign.tiers.includes(tier)) return null;
  if (campaign.intervals && !campaign.intervals.includes(interval)) return null;
  return campaign;
}

/** List price minus the campaign's percentage, rounded to whole cents. */
export function applyPercentOff(amount: number, percentOff: number): number {
  return Math.round(amount * (1 - percentOff / 100) * 100) / 100;
}

/**
 * A USD amount as the modal prints it: whole dollars stay bare (`$5`, matching
 * every price the cards showed before any campaign existed) and anything with
 * cents gets both decimals (`$2.50`) — never the ragged `$2.5`.
 */
export function formatUsd(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}
