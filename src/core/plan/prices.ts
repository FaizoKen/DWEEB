/**
 * List prices and shared plan names, in one place for every surface that prints
 * one (the pricing cards, the send receipt's offer).
 *
 * Presentation only, like `promo.ts`: Stripe holds the real prices, so change
 * these in the same change as Stripe's. They are **before tax**: checkout adds
 * the deployment's tax rate on top (8% SST on ours), so anything that prints
 * one of them has to say so.
 */

import type { PaidTier } from "./stripeApi";

/** USD, before tax (annual = 2 months free). Numbers, not strings, because a
 *  campaign discounts them. */
export const LIST_PRICES: Record<PaidTier, { month: number; year: number }> = {
  plus: { month: 5, year: 50 },
  pro: { month: 10, year: 100 },
};

/** The same Stripe products' names in the sibling RoleLogic app, and so the
 *  name Stripe's payment form prints for a DWEEB plan. */
export const ROLELOGIC_PLAN: Record<PaidTier, string> = { plus: "Medium", pro: "Expanded" };

/** RoleLogic honours a subscription for the Discord account that bought it,
 *  whether they signed in there before or after paying (its first quota read
 *  backfills from Stripe), so every mention of the bundle links here and names
 *  that one condition: the same Discord account. */
export const ROLELOGIC_URL = "https://rolelogic.faizo.net/";
