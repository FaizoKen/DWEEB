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
 * mounts it lazily. Every Upgrade/promo/billing control hangs off the loaded
 * plan, so the states without one (`pricingView`) each say what's happening —
 * loading, failed with a Retry, or a lapsed sign-in — instead of rendering the
 * cards with a blank where the buttons go.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  openBillingPortal,
  reassignSubscription,
  syncCheckout,
  type BillingInterval,
  type PaidTier,
  type PremiumSubscription,
} from "@/core/plan/stripeApi";
import { isCheckoutConfigured } from "@/core/plan/stripeConfig";
import { applyPercentOff, formatUsd, promoFor, type PromoCampaign } from "@/core/plan/promo";
import { guildIconUrl, type PickerGuild, type PlanTier } from "@/core/guild/api";
import { resolveGuildIdentity, type GuildIdentityInfo } from "@/core/guild/identityCache";
import { pricingView } from "./pricingView";
import styles from "./PricingModal.module.css";

interface TierDef {
  id: PlanTier;
  name: string;
  /** Price per interval in USD (annual = 2 months free). Numbers, not strings,
   *  because a campaign discounts them — the figure the card prints and the one
   *  the code is worth have to come from the same source. */
  monthly: number;
  yearly: number;
  tagline: string;
}

const TIERS: TierDef[] = [
  { id: "free", name: "Free", monthly: 0, yearly: 0, tagline: "Build & send" },
  { id: "plus", name: "Plus", monthly: 5, yearly: 50, tagline: "Automate & persist" },
  { id: "pro", name: "Pro", monthly: 10, yearly: 100, tagline: "Run a community" },
];

/** Everything a card needs to advertise the running campaign. Computed once per
 *  card, so the discounted price the buyer reads and the code checkout receives
 *  can never disagree. */
interface PromoPricing {
  campaign: PromoCampaign;
  /** Discounted headline price ("$2.50"). */
  price: string;
  /** Undiscounted headline price, shown struck through ("$5"). */
  listPrice: string;
  /** What happens after a one-time discount ("then $5/mo after the first
   *  month") — `null` for a campaign that discounts every invoice. A
   *  first-payment price shown alone is a bait price. */
  thenNote: string | null;
}

function promoPricing(
  tier: TierDef,
  period: BillingInterval,
  campaign: PromoCampaign,
): PromoPricing {
  const list = period === "year" ? tier.yearly : tier.monthly;
  const unit = period === "year" ? "/yr" : "/mo";
  return {
    campaign,
    price: formatUsd(applyPercentOff(list, campaign.percentOff)),
    listPrice: formatUsd(list),
    thenNote:
      campaign.duration === "first-payment"
        ? `then ${formatUsd(list)}${unit} after the first ${period === "year" ? "year" : "month"}`
        : null,
  };
}

/** The metered quotas, in the shipped default numbers (`server/src/config.rs`). */
const ROWS: {
  label: string;
  values: Record<PlanTier, string>;
  /** Optional per-tier scope suffix, shown muted after the label on the cards. */
  notes?: Partial<Record<PlanTier, string>>;
}[] = [
  { label: "Scheduled posts", values: { free: "3", plus: "30", pro: "Unlimited" } },
  { label: "Never-expire panels", values: { free: "5", plus: "25", pro: "Unlimited" } },
  { label: "Saved messages", values: { free: "10", plus: "100", pro: "Unlimited" } },
  { label: "Posted history", values: { free: "Last 10", plus: "Last 100", pro: "Unlimited" } },
  { label: "Custom bots", values: { free: "1", plus: "2", pro: "5" } },
  { label: "Live co-editors", values: { free: "2", plus: "6", pro: "25" } },
  // Free's allowance is per user; on paid tiers it's a pool the whole server
  // shares (with a per-member ceiling), hence the differing scope note.
  {
    label: "AI requests / day",
    values: { free: "8", plus: "20", pro: "40" },
    notes: { free: "per person", plus: "server-wide", pro: "server-wide" },
  },
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
  const planStatus = usePlanStore((s) => s.status);
  const planError = usePlanStore((s) => s.error);
  const close = usePlanStore((s) => s.closePricing);
  const reloadPlan = usePlanStore((s) => s.load);
  const guilds = useAuthStore((s) => s.guilds);
  const authStatus = useAuthStore((s) => s.status);
  const login = useAuthStore((s) => s.login);

  // Which server this is: the live guild list first, then the connected
  // server's last known identity — the list costs two round-trips, and the
  // `?plans=` deep link can open this before it lands. Unknown still means a
  // server (the id is set), never "connect a server".
  const server = useMemo(() => resolveGuildIdentity(guildId, guilds), [guildId, guilds]);
  const view = pricingView(guildId, planStatus, plan);

  // A plan read that answered 401 means the session lapsed server-side while
  // this tab still thinks it's signed in. The notice below offers a fresh
  // sign-in; once it lands (the session re-hydrates to "authed"), read again.
  useEffect(() => {
    if (view === "signed-out" && authStatus === "authed" && guildId) {
      void reloadPlan(guildId, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on an auth transition only: re-reading on every view change would loop on a 401 that persists
  }, [authStatus]);

  const currentTier: PlanTier | null = plan?.tier ?? null;
  const billing = (plan?.billing ?? false) && isCheckoutConfigured();
  const canUpgradeHere = billing && !!guildId;

  // Embedded-checkout state: the tier being purchased, its client secret, and
  // whether the applied promo code makes it free (so Checkout shows no card
  // fields — worth saying before the form appears rather than leaving it a
  // surprise).
  const [checkout, setCheckout] = useState<{
    tier: PaidTier;
    clientSecret: string;
    noCardNeeded: boolean;
  } | null>(null);
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
  // Promo code. This is the *only* place a code can be entered — Checkout is
  // created without `allow_promotion_codes`, because the server has to apply a code
  // while minting the session for a fully-covering one to skip card entry at all
  // (see `createCheckout`). So the field is always visible rather than hidden
  // behind a disclosure: it isn't a shortcut for Stripe's box, it replaces it.
  const [promo, setPromo] = useState("");
  const [promoError, setPromoError] = useState<string | null>(null);

  // The signed-in user's premium subscriptions (the "your premium servers" block
  // + move picker, and the gate on Manage billing). Null until a load succeeds;
  // [] when they own none. A failed load clears the list and keeps the reason
  // instead: this list gates the only in-app cancel path, so "couldn't load" has
  // to say so rather than read as "you have none".
  const [subs, setSubs] = useState<PremiumSubscription[] | null>(null);
  const [subsError, setSubsError] = useState<string | null>(null);
  const [subsBusy, setSubsBusy] = useState(false);
  // Only the newest request may land — a Retry can race a slower earlier load.
  const subsRequest = useRef(0);

  const loadSubs = () => {
    if (!billing) return;
    const request = ++subsRequest.current;
    setSubsBusy(true);
    void fetchMySubscriptions().then((res) => {
      if (request !== subsRequest.current) return;
      setSubsBusy(false);
      setSubs(res.ok ? res.subscriptions : null);
      setSubsError(res.ok ? null : res.error);
    });
  };

  useEffect(() => {
    loadSubs();
    // Re-run only when billing availability flips (it's stable per session).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billing]);

  /** Whether this tier is an upgrade the buyer can purchase from here — the same
   *  test behind a card's Upgrade button and behind its campaign pricing, so the
   *  two can't drift apart. */
  const buyable = (id: PlanTier): boolean =>
    canUpgradeHere && id !== "free" && RANK[currentTier ?? "free"] < RANK[id];

  // The running campaign priced per card, for the tiers it covers that this
  // buyer can actually act on. A "50% off" flash over a tier they already hold
  // (or can't buy here) advertises nothing they can take. The card itself is the
  // whole announcement — discounted price, struck list price, and what the next
  // invoice costs — so the code is never named in the UI: it is applied for the
  // buyer, and printing a code they don't have to type only invites typing it.
  const promoByTier = new Map<PlanTier, PromoPricing>();
  for (const t of TIERS) {
    if (!buyable(t.id)) continue;
    const campaign = promoFor(t.id as PaidTier, period);
    if (campaign) promoByTier.set(t.id, promoPricing(t, period, campaign));
  }

  const startCheckout = async (tier: PaidTier) => {
    if (!guildId) {
      pushToast("Connect a server first, then upgrade it.", "error");
      return;
    }
    const typed = promo.trim();
    // The campaign's code is applied for the buyer on the tiers it covers: the
    // price on the card is already the discounted one, so making them type the
    // code to reach it would just be a trap. A code they typed always wins —
    // they chose it, and Stripe takes only one per session.
    const code = typed || (promoByTier.get(tier)?.campaign.code ?? "");
    setStarting(tier);
    setPromoError(null);
    const res = await createCheckout(tier, period, guildId, code);
    if (!res.ok) {
      setStarting(null);
      // With a *typed* code in play the failure is almost always about that
      // code, and it belongs beside the field that caused it — a toast over a
      // modal reads as unrelated. A campaign code the buyer never typed has no
      // field to point at, so it stays a toast; and it deliberately fails loudly
      // rather than silently retrying at list price, which would charge more
      // than the card advertised.
      if (typed) {
        setPromoError(res.error);
      } else {
        pushToast(res.error, "error");
      }
      return;
    }
    // Load Stripe.js before switching to the payment view, still under
    // "Starting…". It resolves null when the script can't load (offline, or a
    // content blocker on js.stripe.com) — say so here rather than open an empty
    // payment form whose only control is Back.
    const stripe = await getStripe();
    setStarting(null);
    if (!stripe) {
      pushToast(
        "Couldn’t load Stripe’s payment form. Check your connection or any content blocker, then try again.",
        "error",
      );
      return;
    }
    // Snapshot the tier being left behind now — by the time checkout completes the
    // plan has reloaded to the new tier, and the success screen wants the "before".
    purchaseRef.current = { tier, from: currentTier ?? "free", interval: period };
    setCheckout({ tier, clientSecret: res.clientSecret, noCardNeeded: res.noCardNeeded });
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
        // Same anchor in all three views: they're one dialog changing content,
        // so a different anchor would make it jump between them.
        anchor="top"
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
        anchor="top"
        footer={
          <Button variant="secondary" onClick={() => setCheckout(null)}>
            Back
          </Button>
        }
      >
        {checkout.noCardNeeded ? (
          <p className={styles.noCardNote}>
            Your code covers this plan in full — <strong>no card details needed</strong>. Confirm
            below to activate it.
          </p>
        ) : null}
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
  // Exclusive with `canManage` (a failed load clears `subs`): the reason and a
  // Retry take Manage billing's place, so the cancel path is never just absent.
  const subsFailed = billing && subsError != null;
  // Whether one of *my* subscriptions covers this server. If the server is
  // already on a paid tier but none of my subs is bound to it, another member is
  // paying — surfaced below so a second mod doesn't stack a redundant sub.
  const iCoverThisServer = (subs ?? []).some((s) => s.guildId === guildId);
  const coveredByOther =
    subs != null && !!guildId && currentTier != null && currentTier !== "free" && !iCoverThisServer;
  const loading = view === "loading";
  // Hold the promo row's place while loading, where it will certainly appear
  // (checkout is configured in this build), so the cards don't jump down under
  // the cursor when the plan lands.
  const reservePromoRow = loading && isCheckoutConfigured();

  return (
    <Modal
      open
      onClose={close}
      title="Plans"
      // The content grows as the plan and subscriptions arrive — anchored, the
      // cards don't slide around while someone is reading them.
      anchor="top"
      footer={
        <>
          {subsFailed ? (
            <p className={styles.footerNote} role="alert">
              {subsError}
            </p>
          ) : null}
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
          {canManage ? (
            <Button variant="secondary" onClick={() => void manageBilling()} disabled={portalBusy}>
              {portalBusy ? "Opening…" : "Manage billing"}
            </Button>
          ) : subsFailed ? (
            <Button variant="secondary" onClick={loadSubs} disabled={subsBusy}>
              {subsBusy ? "Retrying…" : "Retry"}
            </Button>
          ) : null}
        </>
      }
    >
      {view === "no-server" ? (
        <p className={styles.lead}>
          Connect a server to upgrade it. Premium applies to one server; nothing is locked — paid
          tiers only raise the limits below.
        </p>
      ) : (
        <div className={styles.contextBar}>
          {server ? (
            <GuildGlyph guild={server} />
          ) : (
            <span className={cn(styles.serverIcon, styles.serverIconFallback)} aria-hidden="true">
              ★
            </span>
          )}
          <span className={styles.contextText}>
            <span className={styles.contextName}>{server?.name ?? "This server"}</span>
            <span className={styles.contextSub}>
              {currentTier ? (
                <>
                  On <strong>{tierName(currentTier)}</strong> — nothing is locked, paid tiers only
                  raise the limits below.
                </>
              ) : loading ? (
                "Loading this server’s plan…"
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
          ) : loading ? (
            <span className={cn(styles.skeleton, styles.tierSkeleton)} aria-hidden="true" />
          ) : null}
        </div>
      )}

      {view === "error" ? (
        <PlanNotice
          title="Couldn’t load this server’s plan."
          detail={planError ?? "Try again in a moment."}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (guildId) void reloadPlan(guildId, true);
              }}
            >
              Retry
            </Button>
          }
        />
      ) : view === "signed-out" ? (
        <PlanNotice
          title="Your Discord sign-in has expired."
          detail="Sign in again to see this server’s plan and upgrade it."
          action={
            <Button size="sm" variant="secondary" onClick={login}>
              Sign in
            </Button>
          }
        />
      ) : null}

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

        {canUpgradeHere ? (
          <label className={cn(styles.promoField, promoError && styles.promoFieldError)}>
            <span className={styles.promoLabel}>Promo</span>
            <input
              className={styles.promoInput}
              type="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              placeholder="Optional"
              value={promo}
              aria-invalid={promoError != null}
              aria-errormessage={promoError ? "promo-error" : undefined}
              disabled={starting !== null}
              onChange={(e) => {
                setPromo((e.target as HTMLInputElement).value);
                setPromoError(null);
              }}
            />
          </label>
        ) : reservePromoRow ? (
          <span className={cn(styles.skeleton, styles.promoSkeleton)} aria-hidden="true" />
        ) : null}
      </div>

      {canUpgradeHere ? (
        promoError ? (
          <p className={styles.promoError} id="promo-error" role="alert">
            {promoError}
          </p>
        ) : (
          <p className={styles.promoHint}>
            Enter codes here, not at payment — one that covers the plan skips card entry.
          </p>
        )
      ) : reservePromoRow ? (
        <span className={cn(styles.skeleton, styles.hintSkeleton)} aria-hidden="true" />
      ) : view === "ready" ? (
        // A loaded plan with no checkout behind it (billing isn't set up on this
        // deployment): say so, or the cards read as missing their buttons.
        <p className={styles.promoHint}>
          Upgrading isn’t available on this site — the plans below are for reference.
        </p>
      ) : null}

      <div className={styles.plans} aria-busy={loading || undefined}>
        {TIERS.map((t) => {
          const canBuy = buyable(t.id);
          return (
            <PlanCard
              key={t.id}
              tier={t}
              period={period}
              promo={promoByTier.get(t.id)}
              loading={loading}
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
        <a href="https://faizo.net" target="_blank" rel="noopener noreferrer">
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
  promo,
  loading,
  isCurrent,
  featured,
  canBuy,
  starting,
  disabled,
  onBuy,
}: {
  tier: TierDef;
  period: BillingInterval;
  /** Set only while a campaign covers this tier *and* the buyer can purchase it. */
  promo?: PromoPricing;
  /** The server's plan is still loading, so this card's CTA isn't known yet. */
  loading: boolean;
  isCurrent: boolean;
  featured: boolean;
  canBuy: boolean;
  starting: boolean;
  disabled: boolean;
  onBuy: () => void;
}) {
  const listPrice = formatUsd(period === "year" ? tier.yearly : tier.monthly);
  return (
    <div
      className={cn(styles.card, isCurrent && styles.cardCurrent, featured && styles.cardFeatured)}
    >
      {featured ? <span className={styles.featTag}>Most popular</span> : null}
      <div className={styles.cardHead}>
        <span className={styles.cardName}>{tier.name}</span>
        {isCurrent ? <span className={styles.currentPill}>Current</span> : null}
        {promo ? <span className={styles.promoPill}>{promo.campaign.percentOff}% off</span> : null}
      </div>
      <div className={styles.cardPrice}>
        <span className={styles.cardAmount}>{promo ? promo.price : listPrice}</span>
        <span className={styles.cardPer}>{period === "year" ? "/yr" : "/mo"}</span>
        {promo ? (
          // The old price beside the new one. It carries its own label for screen
          // readers, where a line-through is silent and the two figures would
          // otherwise read as one contradiction.
          <span className={styles.cardWas} aria-label={`was ${promo.listPrice}`}>
            {promo.listPrice}
          </span>
        ) : null}
      </div>
      {/* A one-time discount has to say what happens next, right beside the
          headline it discounted — a first-payment price shown alone is a bait
          price, however clearly the fine print explains itself elsewhere. */}
      {promo?.thenNote ? <span className={styles.promoThen}>{promo.thenNote}</span> : null}
      <span className={styles.cardTagline}>{tier.tagline}</span>

      <div className={styles.cardCta}>
        {isCurrent ? (
          <span className={styles.ctaCurrent}>Your plan</span>
        ) : canBuy ? (
          <button type="button" className={styles.ctaBuy} disabled={disabled} onClick={onBuy}>
            {starting ? "Starting…" : "Upgrade"}
          </button>
        ) : loading ? (
          <span className={cn(styles.skeleton, styles.ctaSkeleton)} aria-hidden="true" />
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
              <span className={styles.quotaLabel}>
                {r.label}
                {r.notes?.[tier.id] ? (
                  <span className={styles.quotaNote}> {r.notes[tier.id]}</span>
                ) : null}
              </span>
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
                ) : targets.length === 0 ? (
                  // Why Move is disabled, in view — its tooltip never reaches a
                  // touch screen.
                  <span>{" · "}Add the bot to another server to move this</span>
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

/** Where the plan-dependent controls would be when there's no plan to hang them
 *  on: what's missing and why, beside the one action that can fix it. */
function PlanNotice({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <div className={styles.notice} role="alert">
      <p className={styles.noticeText}>
        <strong>{title}</strong> {detail}
      </p>
      {action}
    </div>
  );
}

/** A small round server glyph — the guild icon, or its initial as a fallback. */
function GuildGlyph({ guild }: { guild: GuildIdentityInfo }) {
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
