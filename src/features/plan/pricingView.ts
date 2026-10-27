/**
 * Which state the pricing modal is in — a pure read of the plan store, kept out
 * of the component so the mapping is testable (the modal imports Stripe's React
 * bindings, which a node test has no business loading).
 *
 * Every Upgrade, promo, and billing control hangs off the loaded plan, so a
 * missing plan has to say *why* it's missing rather than render the price list
 * with a blank where the buttons go — which is what the modal used to do.
 */

import type { PlanInfo, PlanLimits, PlanTier } from "@/core/guild/api";
import type { PlanStatus } from "@/core/plan/planStore";
import { promptLimit, type UpgradePrompt } from "@/core/plan/upgradePrompt";

export interface QuotaRow {
  /** The plan limit the row prints — what an upgrade prompt points at. */
  key: keyof PlanLimits;
  label: string;
  values: Record<PlanTier, string>;
  /** Optional per-tier scope suffix, shown muted after the label on the cards. */
  notes?: Partial<Record<PlanTier, string>>;
}

/** The metered quotas, in the shipped default numbers (`server/src/config.rs`). */
export const QUOTA_ROWS: QuotaRow[] = [
  {
    key: "schedules",
    label: "Scheduled posts",
    values: { free: "3", plus: "30", pro: "Unlimited" },
  },
  {
    key: "permanent",
    label: "Never-expire panels",
    values: { free: "5", plus: "25", pro: "Unlimited" },
  },
  {
    key: "library",
    label: "Saved messages",
    values: { free: "10", plus: "100", pro: "Unlimited" },
  },
  {
    key: "library_posted",
    label: "Posted history",
    values: { free: "Last 10", plus: "Last 100", pro: "Unlimited" },
  },
  { key: "custom_bots", label: "Custom bots", values: { free: "1", plus: "2", pro: "5" } },
  { key: "coeditors", label: "Live co-editors", values: { free: "2", plus: "6", pro: "25" } },
  // Free's allowance is per user; on paid tiers it's a pool the whole server
  // shares (with a per-member ceiling), hence the differing scope note.
  {
    key: "ai_requests",
    label: "AI requests / day",
    values: { free: "8", plus: "20", pro: "40" },
    notes: { free: "per person", plus: "server-wide", pro: "server-wide" },
  },
];

const RANK: Record<PlanTier, number> = { free: 0, plus: 1, pro: 2 };

/** The limit a prompt opened the modal on, as the line above the cards prints
 *  it: this server's allowance, then what each higher tier gives instead. */
export interface LimitFocus {
  key: keyof PlanLimits;
  label: string;
  current: { tier: PlanTier; value: string };
  upgrades: { tier: PlanTier; value: string }[];
}

/**
 * Which limit to open the modal on: the one the prompt was about, read against
 * the server's current tier. Null for the general entries (the plan pill, the
 * menu), before the plan is known, and on the top tier — nothing above it to
 * point at.
 */
export function limitFocus(
  prompt: UpgradePrompt | null,
  current: PlanTier | null,
  rows: QuotaRow[] = QUOTA_ROWS,
): LimitFocus | null {
  const key = promptLimit(prompt);
  if (!key || !current) return null;
  const row = rows.find((r) => r.key === key);
  if (!row) return null;
  const upgrades = (Object.keys(RANK) as PlanTier[])
    .filter((t) => RANK[t] > RANK[current])
    .map((tier) => ({ tier, value: row.values[tier] }));
  if (upgrades.length === 0) return null;
  return {
    key,
    label: row.label,
    current: { tier: current, value: row.values[current] },
    upgrades,
  };
}

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

/** A quota as the cards print it, split into the words before its number and
 *  the number itself ("Last 100" → "Last ", 100) — what the purchase ledger
 *  counts up. Null when it ends in no number ("Unlimited"). */
export function splitQuota(value: string): { prefix: string; n: number } | null {
  const m = /^(.*?)(\d+)$/.exec(value);
  return m ? { prefix: m[1] ?? "", n: Number(m[2]) } : null;
}
