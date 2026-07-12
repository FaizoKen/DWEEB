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

import { useEffect, useRef, useState } from "react";
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
  syncCheckout,
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
const ROWS: { label: string; values: Record<PlanTier, string> }[] = [
  { label: "Scheduled posts", values: { free: "3", plus: "30", pro: "Unlimited" } },
  { label: "Never-expire panels", values: { free: "5", plus: "25", pro: "Unlimited" } },
  { label: "Saved messages", values: { free: "10", plus: "100", pro: "Unlimited" } },
  { label: "Posted history", values: { free: "Last 10", plus: "Last 100", pro: "Unlimited" } },
  { label: "Custom bots", values: { free: "1", plus: "2", pro: "5" } },
  { label: "Live co-editors", values: { free: "2", plus: "6", pro: "25" } },
];

const INCLUDED =
  "Every plan includes the full builder, all templates, unlimited webhooks, unlimited tickets, link plugins, and share links. Premium applies to one server — buy it again (or move it) for another.";

// Reassurance for the downgrade/cancel path — nothing is destroyed, over-limit
// items are just paused and auto-restored (see server/src/reconcile.rs).
const DOWNGRADE_NOTE =
  "Change or cancel anytime — nothing is deleted. If a server ends up over a lower plan’s limit, the extra items are paused (not removed) and come back automatically, oldest first, when you upgrade again.";

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
  // What the completed purchase upgraded: the tier bought, its billing interval,
  // and the tier the server was on beforehand — captured at checkout start (before
  // the plan reloads to the new tier) so the success pass can show the concrete
  // before→after jump and the right plan cadence.
  const purchaseRef = useRef<{ tier: PaidTier; from: PlanTier; interval: BillingInterval } | null>(
    null,
  );
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
    // Snapshot the tier being left behind now — by the time checkout completes the
    // plan has reloaded to the new tier, and the success screen wants the "before".
    purchaseRef.current = { tier, from: currentTier ?? "free", interval: period };
    setCheckout({ tier, clientSecret: res.clientSecret });
  };

  const onComplete = () => {
    setDone(true);
    // Payment succeeded. Force the server to pick up the new subscription now
    // (the webhook can lag or be blocked, and the backfill is throttled) *before*
    // reloading the plan, so the new tier actually shows instead of the old one.
    void (async () => {
      if (guildId) {
        await syncCheckout(guildId);
        await reloadPlan(guildId, true);
      }
      loadSubs();
    })();
  };

  const manageBilling = async () => {
    setPortalBusy(true);
    const res = await openBillingPortal();
    setPortalBusy(false);
    if (res.ok) window.location.href = res.url;
    else pushToast(res.error, "error");
  };

  // Post-purchase success view — a "premium membership pass" for the server plus
  // a receipt-style ledger of the exact before→after jumps, so the upgrade lands
  // as something tangible rather than a vague confirmation.
  if (done) {
    const bought = purchaseRef.current;
    const newTier: PlanTier = bought?.tier ?? plan?.tier ?? "plus";
    const fromTier: PlanTier = bought?.from ?? "free";
    const interval: BillingInterval = bought?.interval ?? "month";
    const isPro = newTier === "pro";
    const animate = !prefersReducedMotion();
    const serverName = server?.name ?? "Your server";
    return (
      <Modal
        open
        onClose={close}
        title="Purchase complete"
        footer={
          <Button variant="primary" onClick={close}>
            Start using {tierName(newTier)}
          </Button>
        }
      >
        <div className={styles.success}>
          <div className={styles.passWrap}>
            <div className={cn(styles.pass, isPro && styles.passPro)}>
              <span className={styles.passSheen} aria-hidden="true" />
              <div className={styles.passTop}>
                <span className={styles.passEyebrow}>DWEEB Premium</span>
                <span className={styles.passGlyph} aria-hidden="true">
                  {isPro ? "👑" : "⚡"}
                </span>
              </div>
              <div className={styles.passMember}>
                {server ? (
                  <GuildGlyph guild={server} />
                ) : (
                  <span
                    className={cn(styles.serverIcon, styles.serverIconFallback)}
                    aria-hidden="true"
                  >
                    ★
                  </span>
                )}
                <span className={styles.passMemberName}>{serverName}</span>
              </div>
              <div className={styles.passBottom}>
                <span className={styles.passTier}>{tierName(newTier)}</span>
                <span className={styles.passInterval}>
                  {interval === "year" ? "Annual plan" : "Monthly plan"}
                </span>
              </div>
            </div>
          </div>

          <p className={styles.successLine}>
            <span className={styles.successBang} aria-hidden="true">
              🎉
            </span>
            You’re all set — here’s everything <strong>{serverName}</strong> just unlocked.
          </p>

          <ul className={styles.perks}>
            {ROWS.map((r, i) => (
              <PerkRow
                key={r.label}
                label={r.label}
                from={r.values[fromTier]}
                to={r.values[newTier]}
                animate={animate}
                delay={280 + i * 90}
              />
            ))}
          </ul>

          <p className={styles.successFoot}>
            Premium is bound to this server and <strong>moves with you</strong> — manage or cancel
            anytime under Plans. New limits are live now; give it a moment to show everywhere.
          </p>
        </div>
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
  // Whether one of *my* subscriptions covers this server. If the server is
  // already on a paid tier but none of my subs is bound to it, another member is
  // paying — surfaced below so a second mod doesn't stack a redundant sub.
  const iCoverThisServer = (subs ?? []).some((s) => s.guildId === guildId);
  const coveredByOther =
    subs != null && !!guildId && currentTier != null && currentTier !== "free" && !iCoverThisServer;

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
        <div className={styles.contextBar}>
          <GuildGlyph guild={server} />
          <span className={styles.contextText}>
            <span className={styles.contextName}>{server.name}</span>
            <span className={styles.contextSub}>
              {currentTier ? (
                <>
                  On <strong>{tierName(currentTier)}</strong> — nothing is locked, paid tiers only
                  raise the limits below.
                </>
              ) : (
                "Nothing is locked — paid tiers only raise the limits below."
              )}
            </span>
          </span>
          {currentTier ? (
            <span
              className={cn(styles.contextTier, currentTier !== "free" && styles.contextTierPaid)}
            >
              {tierName(currentTier)}
            </span>
          ) : null}
        </div>
      ) : (
        <p className={styles.lead}>
          Connect a server to upgrade it. Premium applies to one server; nothing is locked — paid
          tiers only raise the limits below.
        </p>
      )}

      {coveredByOther ? (
        <p className={styles.coveredNote}>
          This server is already on <strong>{tierName(currentTier!)}</strong>, covered by another
          member — you don’t need to buy it again (a second subscription would stack on top).
        </p>
      ) : null}

      <div className={styles.toggleRow}>
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
      </div>

      <div className={styles.plans}>
        {TIERS.map((t) => {
          const canBuy =
            canUpgradeHere && t.id !== "free" && RANK[currentTier ?? "free"] < RANK[t.id];
          return (
            <PlanCard
              key={t.id}
              tier={t}
              period={period}
              isCurrent={currentTier === t.id}
              // Highlight the natural upgrade (Plus) only while it's actually an
              // upgrade — i.e. the server is still on Free. Once it's on any paid
              // tier (Plus or Pro), the "Most popular" nudge is just noise.
              featured={t.id === "plus" && RANK[currentTier ?? "free"] < RANK.plus}
              canBuy={canBuy}
              starting={starting === t.id}
              disabled={starting !== null}
              onBuy={() => void startCheckout(t.id as PaidTier)}
            />
          );
        })}
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
      <p className={styles.downgradeNote}>{DOWNGRADE_NOTE}</p>
      <p className={styles.creatorNote}>
        One subscription gives this server premium benefits across every Discord app built by{" "}
        <a href="https://discord.gg/2wB7rHRDg2" target="_blank" rel="noopener noreferrer">
          Faizo
        </a>
        .
      </p>
    </Modal>
  );
}

/** One tier's pricing card: name, price for the chosen interval, tagline, a CTA
 *  (Upgrade / a "Current plan" marker / an empty slot for a lower tier), and the
 *  quota list so the tiers compare row-for-row down the columns. */
function PlanCard({
  tier,
  period,
  isCurrent,
  featured,
  canBuy,
  starting,
  disabled,
  onBuy,
}: {
  tier: TierDef;
  period: BillingInterval;
  isCurrent: boolean;
  featured: boolean;
  canBuy: boolean;
  starting: boolean;
  disabled: boolean;
  onBuy: () => void;
}) {
  return (
    <div
      className={cn(styles.card, isCurrent && styles.cardCurrent, featured && styles.cardFeatured)}
    >
      {featured ? <span className={styles.featTag}>Most popular</span> : null}
      <div className={styles.cardHead}>
        <span className={styles.cardName}>{tier.name}</span>
        {isCurrent ? <span className={styles.currentPill}>Current</span> : null}
      </div>
      <div className={styles.cardPrice}>
        <span className={styles.cardAmount}>{period === "year" ? tier.yearly : tier.monthly}</span>
        <span className={styles.cardPer}>{period === "year" ? "/yr" : "/mo"}</span>
      </div>
      <span className={styles.cardTagline}>{tier.tagline}</span>

      <div className={styles.cardCta}>
        {isCurrent ? (
          <span className={styles.ctaCurrent}>Your plan</span>
        ) : canBuy ? (
          <button type="button" className={styles.ctaBuy} disabled={disabled} onClick={onBuy}>
            {starting ? "Starting…" : "Upgrade"}
          </button>
        ) : (
          <span className={styles.ctaSpacer} aria-hidden="true" />
        )}
      </div>

      <ul className={styles.quotas}>
        {ROWS.map((r) => {
          const v = r.values[tier.id];
          return (
            <li key={r.label} className={styles.quota}>
              <span className={cn(styles.quotaVal, v === "Unlimited" && styles.quotaUnlimited)}>
                {v}
              </span>
              <span className={styles.quotaLabel}>{r.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
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
        // A recently-moved sub is on cooldown (the server owns the window; we just
        // mirror it as a disabled button so a click can't fail server-side).
        const cooldownUntil =
          s.movableAt != null && s.movableAt * 1000 > Date.now() ? s.movableAt : null;
        const moveTitle = cooldownUntil
          ? `You can move this again on ${new Date(cooldownUntil * 1000).toLocaleDateString()}`
          : targets.length === 0
            ? "Add the bot to another server first"
            : undefined;
        return (
          <div key={s.id} className={styles.serverItem}>
            {g ? <GuildGlyph guild={g} /> : null}
            <span className={styles.serverItemMain}>
              <span className={styles.serverItemName}>{g?.name ?? s.guildId ?? "Unassigned"}</span>
              <span className={styles.serverItemMeta}>
                {subMeta(s)}
                {cooldownUntil ? (
                  <span className={styles.moveLock}>
                    {" · "}Movable {new Date(cooldownUntil * 1000).toLocaleDateString()}
                  </span>
                ) : null}
              </span>
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
                disabled={busy || targets.length === 0 || cooldownUntil != null}
                title={moveTitle}
                onClick={() => setMovingId(s.id)}
              >
                Move
              </button>
            )}
          </div>
        );
      })}
      <p className={styles.serversHint}>
        Premium follows you — move it to another server anytime (once a week per subscription).
      </p>
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

/** Whether the viewer asked for reduced motion — so the success-screen flourishes
 *  (card flip, sheen, count-up) fall back to a static reveal. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Count from `start` up to `target` once on mount (easeOutCubic), after `delayMs`
 *  — so a limit visibly grows from the old value to the new one. Returns `target`
 *  immediately when `animate` is false. */
function useCountUp(
  start: number,
  target: number,
  animate: boolean,
  delayMs = 0,
  durationMs = 850,
): number {
  const [val, setVal] = useState(animate ? start : target);
  useEffect(() => {
    if (!animate) {
      setVal(target);
      return;
    }
    let raf = 0;
    const startAt = performance.now() + delayMs;
    const step = (now: number) => {
      if (now < startAt) {
        raf = requestAnimationFrame(step);
        return;
      }
      const t = Math.min(1, (now - startAt) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(start + (target - start) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [start, target, animate, delayMs, durationMs]);
  return val;
}

/** One line of the "what you unlocked" ledger: `label ···· old → new`, where the
 *  finite new value counts up and "Unlimited" shows as ∞. Slides in on a stagger
 *  (`delay`) that also gates the count-up so number and row appear together. */
function PerkRow({
  label,
  from,
  to,
  animate,
  delay,
}: {
  label: string;
  from: string;
  to: string;
  animate: boolean;
  delay: number;
}) {
  const isUnlimited = to === "Unlimited";
  const fromNum = Number.isFinite(Number(from)) ? Number(from) : 0;
  const counted = useCountUp(fromNum, isUnlimited ? 0 : Number(to), animate && !isUnlimited, delay);
  const display = isUnlimited ? "∞" : String(counted);
  const changed = from !== to;
  return (
    <li
      className={styles.perk}
      style={{ animationDelay: `${delay}ms` }}
      aria-label={`${label}: ${isUnlimited ? "unlimited" : to}${changed ? `, up from ${from}` : ""}`}
    >
      <span className={styles.perkLabel}>{label}</span>
      <span className={styles.perkLeader} aria-hidden="true" />
      <span className={styles.perkVals} aria-hidden="true">
        {changed ? (
          <>
            <span className={styles.perkFrom}>{from}</span>
            <span className={styles.perkArrow}>→</span>
          </>
        ) : null}
        <span className={cn(styles.perkTo, isUnlimited && styles.perkInfinite)}>{display}</span>
      </span>
    </li>
  );
}
