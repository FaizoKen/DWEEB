/**
 * What the signed-in user's own subscriptions mean for a purchase on a server.
 *
 * Presentation only: the proxy decides every Upgrade click from Stripe's fresh
 * data (`server/src/stripe/purchase.rs`). This is that rule's visible half, so
 * the cards don't promise a new purchase where there can't be one.
 */

import type { PlanTier } from "@/core/guild/api";
import type { PremiumSubscription } from "./stripeApi";

const OVERDUE = new Set(["past_due", "unpaid", "paused"]);

/** The user's paid subscriptions bound to this server. RoleLogic's Small reads
 *  as Free here, so it doesn't count as paying for the server. */
export function paidSubsHere(
  subs: readonly PremiumSubscription[],
  guildId: string | null,
): PremiumSubscription[] {
  return subs.filter((s) => s.tier !== "free" && !!guildId && s.guildId === guildId);
}

/**
 * - `change`: Upgrade changes their subscription instead of adding one.
 * - `overdue`: their unpaid plan would cover this server, so don't sell another.
 * - `renew`: their plan here is ending, and renewing it keeps its paid time.
 */
export function ownPlanState(
  subs: readonly PremiumSubscription[],
  guildId: string | null,
  current: PlanTier | null,
): "change" | "overdue" | "renew" | null {
  if (!guildId || !current || current === "pro") return null;
  const here = paidSubsHere(subs, guildId);
  const live = current === "free" ? [] : here.filter((s) => !OVERDUE.has(s.status));
  if (live.some((s) => !s.cancelAtPeriodEnd)) return "change";
  const unassigned = subs.filter((s) => s.tier !== "free" && s.guildId === null);
  const blocking = current === "free" ? [...here, ...unassigned] : here;
  if (blocking.some((s) => OVERDUE.has(s.status))) return "overdue";
  return live.length ? "renew" : null;
}

/** Whether they already pay, or owe, for a plan that could cover this server. */
export function holdsPlanFor(subs: readonly PremiumSubscription[], guildId: string): boolean {
  return subs.some((s) => s.tier !== "free" && (s.guildId === null || s.guildId === guildId));
}
