/**
 * The quiet plan indicator — shared by the web action bar and the Activity bar.
 *
 * The builder deliberately keeps billing chrome out of the way so a first-time
 * user experiences it as free and frictionless. This is the one small
 * concession: a recessive pill in the bar showing which plan the *server* is
 * on. For a Free server it reads as a neutral status that quietly reinforces
 * "this is free" — not an upgrade nag — and the actual plan comparison stays
 * one click in, out of a newcomer's way.
 *
 * Clicking it opens a compact popover with the per-feature limits and a plans
 * hand-off. On the web that opens the pricing modal directly; in the Activity
 * it hands off to the web app — embedded checkout can't run inside Discord
 * (the sandbox blocks discord.com navigation), so upgrading happens on the
 * web, the same constraint the never-expire upsell lives under.
 */

import { Menu, MenuItem, MenuDivider } from "@/ui/Menu";
import { ChevronDownIcon, ExternalLinkIcon } from "@/ui/Icon";
import type { PlanInfo, PlanTier } from "@/core/guild/api";
import styles from "./PlanBadge.module.css";

const TIER_LABEL: Record<PlanTier, string> = { free: "Free", plus: "Plus", pro: "Pro" };

/** The tier's display name, shared with the Activity bar's phone menu row. */
export function tierLabel(tier: PlanTier): string {
  return TIER_LABEL[tier];
}

const LIMIT_ROWS: { key: keyof PlanInfo["limits"]; label: string }[] = [
  { key: "schedules", label: "Scheduled posts" },
  { key: "permanent", label: "Never-expire panels" },
  { key: "library", label: "Saved messages" },
  { key: "library_posted", label: "Posted history" },
  { key: "custom_bots", label: "Custom bots" },
  { key: "coeditors", label: "Live co-editors" },
];

/** A limit value for display: a number, or "Unlimited" for the null (0/∞) case. */
function limitText(v: number | null | undefined): string {
  return v == null ? "Unlimited" : String(v);
}

export function PlanBadge({
  plan,
  serverName,
  onSeePlans,
}: {
  plan: PlanInfo;
  serverName?: string;
  /** Open the plan comparison — the pricing modal on web, a web hand-off in
   *  the Activity. */
  onSeePlans: () => void;
}) {
  const paid = plan.tier !== "free";
  const name = TIER_LABEL[plan.tier];
  return (
    <Menu
      align="end"
      trigger={
        <button
          type="button"
          className={paid ? `${styles.pill} ${styles.pillPaid}` : styles.pill}
          title={`This server is on the ${name} plan`}
        >
          {name}
          <ChevronDownIcon size={13} />
        </button>
      }
    >
      {(close) => (
        <>
          <div className={styles.head}>
            <span className={styles.server}>{serverName ?? "This server"}</span>
            <span className={paid ? `${styles.tier} ${styles.tierPaid}` : styles.tier}>{name}</span>
          </div>
          <p className={styles.note}>
            {paid
              ? "Everything's unlocked — thanks for supporting DWEEB."
              : "Everything works on Free. Paid plans just raise a few limits."}
          </p>
          <ul className={styles.limits}>
            {LIMIT_ROWS.map((r) => (
              <li key={r.key} className={styles.limitRow}>
                <span className={styles.limitLabel}>{r.label}</span>
                <span className={styles.limitVal}>{limitText(plan.limits[r.key])}</span>
              </li>
            ))}
          </ul>
          {plan.billing ? (
            <>
              <MenuDivider />
              <MenuItem
                icon={<ExternalLinkIcon size={16} />}
                onSelect={() => {
                  close();
                  onSeePlans();
                }}
              >
                {/* Pro is the top tier — nothing to upgrade to, so it manages
                    billing instead; every lower tier gets the upsell. */}
                {plan.tier === "pro" ? "Manage plan" : "Upgrade"}
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </Menu>
  );
}
