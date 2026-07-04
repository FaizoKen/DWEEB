/**
 * Client for DWEEB's own Stripe billing (`server/src/stripe.rs`).
 *
 * DWEEB runs its own embedded Checkout — no redirect to a sibling app. The proxy
 * mints an embedded Checkout session (`/api/stripe/checkout`) and a billing-portal
 * URL (`/api/stripe/portal`); Stripe.js (loaded lazily from js.stripe.com) renders
 * the payment form inline in the pricing modal.
 *
 * All calls send `credentials: "include"` so the proxy can attribute the
 * subscription to the signed-in Discord user. Nothing here throws — callers branch
 * on `ok`.
 */

import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { PROXY_BASE_URL } from "@/core/guild/config";

const PUBLISHABLE_KEY = (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined) ?? "";

let stripePromise: Promise<Stripe | null> | null = null;

/** Lazily load Stripe.js once. Resolves to null when no publishable key is set. */
export function getStripe(): Promise<Stripe | null> {
  if (!PUBLISHABLE_KEY) return Promise.resolve(null);
  if (!stripePromise) stripePromise = loadStripe(PUBLISHABLE_KEY);
  return stripePromise;
}

/** True when in-app checkout can run: a publishable key AND a configured proxy. */
export function isCheckoutConfigured(): boolean {
  return PUBLISHABLE_KEY.length > 0 && PROXY_BASE_URL.length > 0;
}

/** A DWEEB tier that can be purchased. */
export type PaidTier = "plus" | "pro";

/** Billing interval for a subscription. */
export type BillingInterval = "month" | "year";

export type CheckoutResult = { ok: true; clientSecret: string } | { ok: false; error: string };

/** `POST /api/stripe/checkout` `{ tier, interval, guild_id }` → the embedded
 *  Checkout client secret. The subscription is bound to `guildId` (per-server
 *  premium); `interval` defaults to monthly. */
export async function createCheckout(
  tier: PaidTier,
  interval: BillingInterval,
  guildId: string,
): Promise<CheckoutResult> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/stripe/checkout`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, interval, guild_id: guildId }),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the billing service." };
  }
  const data = (await res.json().catch(() => null)) as {
    client_secret?: string;
    error?: string;
  } | null;
  if (!res.ok || !data?.client_secret) {
    return { ok: false, error: data?.error ?? `Couldn't start checkout (${res.status}).` };
  }
  return { ok: true, clientSecret: data.client_secret };
}

/** One of the signed-in user's premium subscriptions, from
 *  `GET /api/stripe/subscriptions`. Ownership (this user pays) is implied; the
 *  `guildId` is the server it currently grants premium to. */
export interface PremiumSubscription {
  /** Stripe subscription id (`sub_…`). */
  id: string;
  /** The server this subscription is bound to (null only for an unbound legacy sub). */
  guildId: string | null;
  tier: PaidTier;
  /** Stripe status — `active` | `trialing` | `past_due`. */
  status: string;
  /** Unix seconds when the current period ends. */
  currentPeriodEnd: number;
  /** True when it's set to end at the period boundary rather than renew. */
  cancelAtPeriodEnd: boolean;
}

/** Raw row shape from the proxy (snake_case), before normalisation. */
interface RawSubscription {
  id: string;
  guild_id: string | null;
  tier: PaidTier;
  status: string;
  current_period_end: number;
  cancel_at_period_end: boolean;
}

/** `GET /api/stripe/subscriptions` → the signed-in user's premium subscriptions
 *  (the "your premium servers" list + move picker source). Empty on any miss —
 *  this only ever hides management UI, never blocks the pricing table. */
export async function fetchMySubscriptions(): Promise<PremiumSubscription[]> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/stripe/subscriptions`, {
      method: "GET",
      credentials: "include",
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as { items?: RawSubscription[] } | null;
  return (data?.items ?? []).map((s) => ({
    id: s.id,
    guildId: s.guild_id,
    tier: s.tier,
    status: s.status,
    currentPeriodEnd: s.current_period_end,
    cancelAtPeriodEnd: s.cancel_at_period_end,
  }));
}

export type ReassignResult = { ok: true } | { ok: false; error: string };

/** `POST /api/stripe/reassign` `{ subscription_id, guild_id }` — move a premium
 *  subscription to a different server. The proxy checks the user owns the sub and
 *  manages the target server. */
export async function reassignSubscription(
  subscriptionId: string,
  guildId: string,
): Promise<ReassignResult> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/stripe/reassign`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription_id: subscriptionId, guild_id: guildId }),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the billing service." };
  }
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, error: data?.error ?? `Couldn't move premium (${res.status}).` };
}

export type PortalResult = { ok: true; url: string } | { ok: false; error: string };

/** `POST /api/stripe/portal` → a Stripe billing-portal URL (redirect to it). */
export async function openBillingPortal(): Promise<PortalResult> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/stripe/portal`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    return { ok: false, error: "Couldn't reach the billing service." };
  }
  const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!res.ok || !data?.url) {
    return { ok: false, error: data?.error ?? `Couldn't open billing (${res.status}).` };
  }
  return { ok: true, url: data.url };
}
