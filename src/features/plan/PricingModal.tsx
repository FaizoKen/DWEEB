/**
 * Pricing modal — DWEEB's per-server plans with in-app (embedded) Stripe Checkout.
 *
 * Premium is sold per Discord server (MEE6/Dyno-style): the modal is always
 * scoped to one server (the connected one, or whichever a per-server dialog is
 * upgrading). Clicking Upgrade mints an embedded Checkout session bound to that
 * server (`stripeApi.createCheckout`) and renders Stripe's payment form inline;
 * on completion the plan refreshes. A "your premium servers" block below lets the
 * owner move an existing subscription to a different server, and open the Stripe
 * billing portal to manage/cancel. Nothing is paywall-locked — paid tiers only
 * raise the quotas shown below.
 *
 * Self-contained: reads open/close + the target server from `planStore`; `App`
 * mounts it lazily.
 */

import { useEffect, useState } from "react";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { cn } from "@/lib/cn";
import { pushToast } from "@/ui/Toast";
import { usePlanStore } from "@/core/plan/planStore";
import { useAuthStore } from "@/core/auth/authStore";
import {
  createCheckout,
  fetchMySubscriptions,
  getStripe,
  isCheckoutConfigured,
  openBillingPortal,
  reassignSubscription,
  type BillingInterval,
  type PaidTier,
  type PremiumSubscription,
} from "@/core/plan/stripeApi";
import { guildIconUrl, type PickerGuild, type PlanTier } from "@/core/guild/api";
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
  "Every plan includes the full builder, all templates, unlimited webhooks, unlimited tickets, link plugins, and share links. Premium applies to one server — buy it again (or move it) for another.";

const RANK: Record<PlanTier, number> = { free: 0, plus: 1, pro: 2 };

function tierName(t: PlanTier): string {
  return t === "pro" ? "Pro" : t === "plus" ? "Plus" : "Free";
}

export function PricingModal() {
  const plan = usePlanStore((s) => s.plan);
  const guildId = usePlanStore((s) => s.guildId);
  const close = usePlanStore((s) => s.closePricing);
  const reloadPlan = usePlanStore((s) => s.load);
  const guilds = useAuthStore((s) => s.guilds);

  const server = guildId ? (guilds.find((g) => g.id === guildId) ?? null) : null;

  const currentTier: PlanTier | null = plan?.tier ?? null;
  const billing = (plan?.billing ?? false) && isCheckoutConfigured();

  // Embedded-checkout state: the tier being purchased + its client secret.
  const [checkout, setCheckout] = useState<{ tier: PaidTier; clientSecret: string } | null>(null);
  const [starting, setStarting] = useState<PaidTier | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [done, setDone] = useState(false);
  // Billing interval the Upgrade buttons buy — set by the Monthly/Annual toggle.
  const [period, setPeriod] = useState<BillingInterval>("month");

  // The signed-in user's premium subscriptions (the "your premium servers" block
  // + move picker). Null until first load; [] when they own none.
  const [subs, setSubs] = useState<PremiumSubscription[] | null>(null);

  const loadSubs = () => {
    if (!billing) return;
    void fetchMySubscriptions().then(setSubs);
  };

  useEffect(() => {
    loadSubs();
    // Re-run only when billing availability flips (it's stable per session).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billing]);

  const startCheckout = async (tier: PaidTier) => {
    if (!guildId) {
      pushToast("Connect a server first, then upgrade it.", "error");
      return;
    }
    setStarting(tier);
    const res = await createCheckout(tier, period, guildId);
    setStarting(null);
    if (!res.ok) {
      pushToast(res.error, "error");
      return;
    }
    setCheckout({ tier, clientSecret: res.clientSecret });
  };

  const onComplete = () => {
    setDone(true);
    if (guildId) void reloadPlan(guildId, true); // pull the new tier
    loadSubs();
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
          Thanks for subscribing! {server ? <strong>{server.name}</strong> : "This server"}’s new
          limits are active now — it can take a moment to reflect everywhere.
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
        title={`Upgrade ${server ? server.name : "server"} to ${checkout.tier === "pro" ? "Pro" : "Plus"}`}
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

  const canManage = billing && subs != null && subs.length > 0;
  const canUpgradeHere = billing && !!guildId;

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
      {server ? (
        <div className={styles.serverContext}>
          <GuildGlyph guild={server} />
          <span>{server.name}</span>
        </div>
      ) : null}

      <p className={styles.lead}>
        Premium applies to one server, and nothing is locked — paid tiers just raise these limits.
        {server && currentTier ? (
          <>
            {" "}
            <strong>{server.name}</strong> is on <strong>{tierName(currentTier)}</strong>.
          </>
        ) : !guildId ? (
          <> Connect a server to upgrade it.</>
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
                  canUpgradeHere && t.id !== "free" && RANK[currentTier ?? "free"] < RANK[t.id];
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
                      <span className={styles.youBadge}>This server</span>
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

      {canManage ? (
        <PremiumServers
          subs={subs!}
          guilds={guilds}
          onChanged={() => {
            loadSubs();
            if (guildId) void reloadPlan(guildId, true);
          }}
        />
      ) : null}

      <p className={styles.included}>{INCLUDED}</p>
    </Modal>
  );
}

/** The "your premium servers" list: each owned subscription with its server, tier,
 *  and a "Move" action that re-points it at another server the user manages. */
function PremiumServers({
  subs,
  guilds,
  onChanged,
}: {
  subs: PremiumSubscription[];
  guilds: PickerGuild[];
  onChanged: () => void;
}) {
  const [movingId, setMovingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const move = async (subId: string, targetGuild: string) => {
    setBusy(true);
    const res = await reassignSubscription(subId, targetGuild);
    setBusy(false);
    setMovingId(null);
    if (!res.ok) {
      pushToast(res.error, "error");
      return;
    }
    const to = guilds.find((g) => g.id === targetGuild)?.name ?? "that server";
    pushToast(`Premium moved to ${to}.`, "success");
    onChanged();
  };

  return (
    <div className={styles.serversSection}>
      <p className={styles.serversTitle}>Your premium servers</p>
      {subs.map((s) => {
        const g = s.guildId ? (guilds.find((x) => x.id === s.guildId) ?? null) : null;
        // Servers the user manages with the bot present, minus this sub's current
        // one — the valid move targets.
        const targets = guilds.filter((x) => x.bot_present && x.id !== s.guildId);
        return (
          <div key={s.id} className={styles.serverItem}>
            {g ? <GuildGlyph guild={g} /> : null}
            <span className={styles.serverItemMain}>
              <span className={styles.serverItemName}>{g?.name ?? s.guildId ?? "Unassigned"}</span>
              <span className={styles.serverItemMeta}>{subMeta(s)}</span>
            </span>
            <span className={styles.serverTierBadge}>{tierName(s.tier)}</span>
            {movingId === s.id ? (
              <select
                className={styles.moveSelect}
                autoFocus
                disabled={busy}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) void move(s.id, e.target.value);
                }}
              >
                <option value="" disabled>
                  {targets.length ? "Move to…" : "No other servers"}
                </option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : (
              <button
                type="button"
                className={styles.moveBtn}
                disabled={busy || targets.length === 0}
                title={targets.length === 0 ? "Add the bot to another server first" : undefined}
                onClick={() => setMovingId(s.id)}
              >
                Move
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A one-line status note for a subscription (payment / cancellation state). */
function subMeta(s: PremiumSubscription): string {
  if (s.status === "past_due") return "Payment overdue";
  const when = s.currentPeriodEnd ? new Date(s.currentPeriodEnd * 1000).toLocaleDateString() : null;
  if (s.cancelAtPeriodEnd) return when ? `Cancels ${when}` : "Cancels at period end";
  if (s.status === "trialing") return when ? `Trial until ${when}` : "Trialing";
  return when ? `Renews ${when}` : "Active";
}

/** A small round server glyph — the guild icon, or its initial as a fallback. */
function GuildGlyph({ guild }: { guild: PickerGuild }) {
  const url = guildIconUrl(guild.id, guild.icon, 32);
  if (url) return <img className={styles.serverIcon} src={url} alt="" loading="lazy" />;
  return (
    <span className={cn(styles.serverIcon, styles.serverIconFallback)} aria-hidden="true">
      {guild.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
