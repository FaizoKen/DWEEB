/**
 * Stripe checkout availability — split from `stripeApi.ts` so surfaces that only
 * need to KNOW whether in-app checkout exists (e.g. the Send panel's upgrade
 * hint) don't pull `@stripe/stripe-js` into their chunk. That import matters:
 * the default loader injects the js.stripe.com script (cookies, fraud beacons)
 * as a side effect wherever it's evaluated, so Stripe code must stay confined
 * to the pricing modal's lazy graph (which imports it via `@stripe/stripe-js/pure`
 * and loads the script only when the checkout form renders).
 */

import { PROXY_BASE_URL } from "@/core/guild/config";

/** Stripe publishable key (build-time env; empty = checkout disabled). */
export const STRIPE_PUBLISHABLE_KEY =
  (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined) ?? "";

/** True when in-app checkout can run: a publishable key AND a configured proxy. */
export function isCheckoutConfigured(): boolean {
  return STRIPE_PUBLISHABLE_KEY.length > 0 && PROXY_BASE_URL.length > 0;
}
