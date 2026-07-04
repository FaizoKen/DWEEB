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

export type CheckoutResult = { ok: true; clientSecret: string } | { ok: false; error: string };

/** `POST /api/stripe/checkout` `{ tier }` → the embedded Checkout client secret. */
export async function createCheckout(tier: PaidTier): Promise<CheckoutResult> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/stripe/checkout`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
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
