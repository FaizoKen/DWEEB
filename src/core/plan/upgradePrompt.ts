/**
 * Where someone opened the plans from, and which limit (if any) sent them.
 *
 * Every control that opens the pricing modal names itself with one of these, so
 * two things can follow from it: the funnel events (`pricing_opened` →
 * `checkout_started` → `checkout_completed`, all carrying `opened_from`) say which
 * prompt actually sells, and the modal can open on the limit that brought them —
 * "You've used all 10 saved messages on Free" beside the row that raises it —
 * instead of a generic price list they have to map back to their problem.
 *
 * A prompt is only ever shown where a limit is in reach, never as a banner: the
 * builder stays free-feeling for anyone who isn't bumping into a quota (see
 * `PlanBadge`'s rationale).
 */

import type { PlanLimits } from "@/core/guild/api";

export type UpgradePrompt =
  /** The plan pill's popover in the action bar. */
  | "plan_badge"
  /** The account menu's plans entry. */
  | "account_menu"
  /** The never-expire choice in the send confirm, with every slot taken. */
  | "send_slots"
  /** The Posted tab's never-expire slot strip. */
  | "posted_slots"
  /** The Posted tab's history meter, once the rolling window is full. */
  | "posted_history"
  /** The Scheduled tab's usage strip. */
  | "scheduled"
  /** Saving a server draft, or the Server drafts tab's meter. */
  | "saved_messages"
  /** The custom bot dialog. */
  | "custom_bots"
  /** The AI panel's usage bar. */
  | "ai"
  /** The Activity's collaboration room turning someone away. */
  | "room_full"
  /** The Activity's "see plans on web" hand-off, from its plan pill. */
  | "activity";

/** The plan limit a prompt is about — the row the pricing modal points at. The
 *  general entries (the pill, the menu, the Activity hand-off) name none. */
const PROMPT_LIMIT: Partial<Record<UpgradePrompt, keyof PlanLimits>> = {
  send_slots: "permanent",
  posted_slots: "permanent",
  posted_history: "library_posted",
  scheduled: "schedules",
  saved_messages: "library",
  custom_bots: "custom_bots",
  ai: "ai_requests",
  room_full: "coeditors",
};

export function promptLimit(prompt: UpgradePrompt | null): keyof PlanLimits | null {
  return (prompt && PROMPT_LIMIT[prompt]) ?? null;
}

/**
 * Whether usage is close enough to a finite cap to mention the next plan: at the
 * cap, or within its last fifth (4 of 5, 8 of 10). An unlimited cap (null) never
 * is. A soft hint, never a block — the limit itself still decides what works.
 */
export function nearCap(used: number, cap: number | null | undefined): boolean {
  if (cap == null || cap <= 0) return false;
  return used >= Math.ceil(cap * 0.8);
}
