/**
 * Pricing modal — DWEEB's own plans with in-app (embedded) Stripe Checkout.
 *
 * DWEEB runs its own checkout: no redirect to a sibling app, no separate login.
 * Clicking Upgrade mints an embedded Checkout session (`stripeApi.createCheckout`)
 * and renders Stripe's payment form inline; on completion the plan refreshes.
 * Existing subscribers get a "Manage billing" button (Stripe billing portal).
 * Nothing is paywall-locked — paid tiers only raise the quotas shown below.
 *
 * The underlying SKUs are shared with the sibling RoleLogic app (one subscription
 * grants both), but that's invisible here: DWEEB shows its own Free/Plus/Pro.
 *
 * Self-contained: reads open/close from `planStore`; `App` mounts it lazily.
 */

import { useState } from "react";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { cn } from "@/lib/cn";
import { pushToast } from "@/ui/Toast";
import { usePlanStore } from "@/core/plan/planStore";
import {
  createCheckout,
  getStripe,
  isCheckoutConfigured,
  openBillingPortal,
  type BillingInterval,
  type PaidTier,
} from "@/core/plan/stripeApi";
import type { PlanTier } from "@/core/guild/api";
import styles from "./PricingModal.module.css";

interface TierDef {
  id: PlanTier;
  name: string;
  /** Display price per interval (annual = 2 months free). */
  monthly: string;
  yearly: string;
  tagline: string;
}

const TIERS: TierDef[] = [
  { id: "free", name: "Free", monthly: "$0", yearly: "$0", tagline: "Build & send" },
  { id: "plus", name: "Plus", monthly: "$5", yearly: "$50", tagline: "Automate & persist" },
  { id: "pro", name: "Pro", monthly: "$10", yearly: "$100", tagline: "Run a community" },
];

/** The metered quotas, in the shipped default numbers (`server/src/config.rs`). */
const ROWS: { label: string; free: string; plus: string; pro: string }[] = [
  { label: "Scheduled posts", free: "3", plus: "30", pro: "Unlimited" },
  { label: "Never-expire panels", free: "5", plus: "25", pro: "Unlimited" },
  { label: "Custom bots", free: "1", plus: "2", pro: "5" },
  { label: "Live co-editors", free: "2", plus: "6", pro: "25" },
];

const INCLUDED =
  "Every plan includes the full builder, all templates, unlimited webhooks, unlimited tickets, link plugins, and share links.";

const RANK: Record<PlanTier, number> = { free: 0, plus: 1, pro: 2 };

function tierName(t: PlanTier): string {
  return t === "pro" ? "Pro" : t === "plus" ? "Plus" : "Free";
}

export function PricingModal() {
  const plan = usePlanStore((s) => s.plan);
  const close = usePlanStore((s) => s.closePricing);
  const reloadPlan = usePlanStore((s) => s.load);

  const currentTier: PlanTier | null = plan?.tier ?? null;
  const billing = (plan?.billing ?? false) && isCheckoutConfigured();

  // Embedded-checkout state: the tier being purchased + its client secret.
  const [checkout, setCheckout] = useState<{ tier: PaidTier; clientSecret: string } | null>(null);
  const [starting, setStarting] = useState<PaidTier | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [done, setDone] = useState(false);
  // Billing interval the Upgrade buttons buy — set by the Monthly/Annual toggle.
  const [period, setPeriod] = useState<BillingInterval>("month");

  const startCheckout = async (tier: PaidTier) => {
    setStarting(tier);
    const res = await createCheckout(tier, period);
    setStarting(null);
    if (!res.ok) {
      pushToast(res.error, "error");
      return;
    }
    setCheckout({ tier, clientSecret: res.clientSecret });
  };

  const onComplete = () => {
    setDone(true);
    void reloadPlan(true); // pull the new tier
  };

  const manageBilling = async () => {
    setPortalBusy(true);
    const res = await openBillingPortal();
    setPortalBusy(false);
    if (res.ok) window.location.href = res.url;
    else pushToast(res.error, "error");
  };

  // Post-purchase success view.
  if (done) {
    return (
      <Modal
        open
        onClose={close}
        size="sm"
        title="You’re upgraded 🎉"
        footer={
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        }
      >
        <p className={styles.lead}>
          Thanks for subscribing! Your new limits are active now — it can take a moment to reflect
          everywhere.
        </p>
      </Modal>
    );
  }

  // Embedded checkout view.
  if (checkout) {
    return (
      <Modal
        open
        onClose={() => setCheckout(null)}
        title={`Upgrade to ${checkout.tier === "pro" ? "Pro" : "Plus"}`}
        footer={
          <Button variant="secondary" onClick={() => setCheckout(null)}>
            Back
          </Button>
        }
      >
        <div className={styles.checkout}>
          <EmbeddedCheckoutProvider
            stripe={getStripe()}
            options={{ clientSecret: checkout.clientSecret, onComplete }}
          >
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        </div>
      </Modal>
    );
  }

  const canManage = billing && currentTier != null && currentTier !== "free";

  return (
    <Modal
      open
      onClose={close}
      title="Plans"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
          {canManage ? (
            <Button variant="secondary" onClick={() => void manageBilling()} disabled={portalBusy}>
              {portalBusy ? "Opening…" : "Manage billing"}
            </Button>
          ) : null}
        </>
      }
    >
      <p className={styles.lead}>
        Nothing is locked — paid tiers just raise these limits.
        {currentTier ? (
          <>
            {" "}
            You’re currently on <strong>{tierName(currentTier)}</strong>.
          </>
        ) : null}
      </p>

      <div className={styles.periodToggle} role="group" aria-label="Billing interval">
        <button
          type="button"
          className={cn(styles.periodBtn, period === "month" && styles.periodActive)}
          aria-pressed={period === "month"}
          onClick={() => setPeriod("month")}
        >
          Monthly
        </button>
        <button
          type="button"
          className={cn(styles.periodBtn, period === "year" && styles.periodActive)}
          aria-pressed={period === "year"}
          onClick={() => setPeriod("year")}
        >
          Annual
          <span className={styles.periodSave}>2 months free</span>
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.rowHead} aria-hidden="true" />
              {TIERS.map((t) => {
                const canBuy =
                  billing && t.id !== "free" && RANK[currentTier ?? "free"] < RANK[t.id];
                return (
                  <th
                    key={t.id}
                    scope="col"
                    className={cn(styles.tierHead, currentTier === t.id && styles.tierCurrent)}
                  >
                    <span className={styles.tierName}>{t.name}</span>
                    <span className={styles.tierPrice}>
                      {period === "year" ? t.yearly : t.monthly}
                      <span className={styles.per}>{period === "year" ? "/yr" : "/mo"}</span>
                    </span>
                    <span className={styles.tierTagline}>{t.tagline}</span>
                    {currentTier === t.id ? (
                      <span className={styles.youBadge}>Your plan</span>
                    ) : canBuy ? (
                      <button
                        type="button"
                        className={styles.tierCta}
                        disabled={starting !== null}
                        onClick={() => void startCheckout(t.id as PaidTier)}
                      >
                        {starting === t.id ? "Starting…" : "Upgrade"}
                      </button>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.label}>
                <th scope="row" className={styles.rowHead}>
                  {r.label}
                </th>
                <td className={cn(currentTier === "free" && styles.colCurrent)}>{r.free}</td>
                <td className={cn(currentTier === "plus" && styles.colCurrent)}>{r.plus}</td>
                <td className={cn(currentTier === "pro" && styles.colCurrent)}>{r.pro}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className={styles.included}>{INCLUDED}</p>
    </Modal>
  );
}
