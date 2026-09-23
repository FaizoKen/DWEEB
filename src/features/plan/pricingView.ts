/**
 * Which state the pricing modal is in — a pure read of the plan store, kept out
 * of the component so the mapping is testable (the modal imports Stripe's React
 * bindings, which a node test has no business loading).
 *
 * Every Upgrade, promo, and billing control hangs off the loaded plan, so a
 * missing plan has to say *why* it's missing rather than render the price list
 * with a blank where the buttons go — which is what the modal used to do.
 */

import type { PlanInfo } from "@/core/guild/api";
import type { PlanStatus } from "@/core/plan/planStore";

export type PricingView =
  /** No server to scope the plans to — "connect a server first". */
  | "no-server"
  /** The server's plan is on its way. */
  | "loading"
  /** The read failed; the store holds the reason, and a retry may fix it. */
  | "error"
  /** The read answered 401: the session lapsed while this tab still thought it
   *  was signed in (a null plan with a settled status means nothing else). */
  | "signed-out"
  /** A plan to show and act on. */
  | "ready";

export function pricingView(
  guildId: string | null,
  status: PlanStatus,
  plan: PlanInfo | null,
): PricingView {
  if (!guildId) return "no-server";
  // A plan in hand wins over the status: a forced background refresh that
  // failed (or is still running) leaves the last good plan, which is still the
  // right one to act on.
  if (plan) return "ready";
  if (status === "error") return "error";
  if (status === "ready") return "signed-out";
  // "loading" — and "idle", which a server id never co-occurs with (a load sets
  // both at once), so treat it as a load about to start rather than a failure.
  return "loading";
}
