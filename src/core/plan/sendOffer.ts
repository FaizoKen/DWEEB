/**
 * When the send receipt may carry DWEEB's own Plus offer.
 *
 * It takes the one slot under the receipt whenever this build shows no
 * third-party ad (`core/ads`), so the two can never share a receipt. It loads
 * nothing from anyone else, so the rules here are about not nagging:
 *
 * - **Only to someone who can take it.** Signed in, and the destination server
 *   is confirmed Free with checkout available. Anything unknown (no server, a
 *   failed lookup) shows nothing: a paying server must never be sold to.
 * - **Never in the Discord Activity**, which can't run checkout.
 * - **Never a first impression.** The first successful send stays clean.
 * - **Once a day at most, and "Not now" buys a month of quiet.**
 * - **No storage, no offer.** A dismissal that can't be saved would be a nag.
 */

import { isActivityMode } from "@/core/activity/runtime";
import { adsConfigured } from "@/core/ads/config";
import { fetchGuildPlan, type PlanInfo } from "@/core/guild/api";
import { usePlanStore } from "./planStore";
import { LIST_PRICES } from "./prices";
import { applyPercentOff, formatUsd, promoFor, type PromoCampaign } from "./promo";
import { isCheckoutConfigured } from "./stripeConfig";

/** Minimum gap between two receipts that carry the offer. */
export const OFFER_COOLDOWN_MS = 24 * 60 * 60_000;
/** How long a dismissal keeps the offer away. */
export const OFFER_SNOOZE_MS = 30 * 24 * 60 * 60_000;
/** Below this viewport height the receipt has no room to spare for it. */
export const OFFER_MIN_VIEWPORT_HEIGHT = 560;

const STORAGE_KEY = "dweeb.offer.receipt.v1";

export interface OfferRecord {
  sends: number;
  lastShownAt: number | null;
  dismissedAt: number | null;
}

export interface SendOfferFacts {
  activity: boolean;
  signedIn: boolean;
  viewportHeight: number;
  /** The record *before* this send; null when storage can't be used. */
  record: OfferRecord | null;
  now: number;
}

/** Whether this build's receipt slot belongs to the offer. */
export function sendOfferAvailable(): boolean {
  return !adsConfigured() && isCheckoutConfigured();
}

/** A clock that moved backwards must not hide the offer until it catches up. */
function within(since: number | null, windowMs: number, now: number): boolean {
  return since !== null && now >= since && now - since < windowMs;
}

/** Whether this receipt may try the offer. The server check runs after. */
export function sendOfferAllowed({
  activity,
  signedIn,
  viewportHeight,
  record,
  now,
}: SendOfferFacts): boolean {
  if (activity || !signedIn || !record) return false;
  if (viewportHeight < OFFER_MIN_VIEWPORT_HEIGHT) return false;
  if (record.sends < 1) return false;
  if (within(record.dismissedAt, OFFER_SNOOZE_MS, now)) return false;
  return !within(record.lastShownAt, OFFER_COOLDOWN_MS, now);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read the record: missing or malformed is a fresh browser, unreadable is null
 *  (blocked site data throws on the `localStorage` access itself). */
export function readOfferRecord(): OfferRecord | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  let parsed: Partial<Record<keyof OfferRecord, unknown>> = {};
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (value && typeof value === "object") parsed = value;
  } catch {
    // Malformed: a fresh browser.
  }
  return {
    sends: Math.max(0, Math.floor(finite(parsed.sends) ?? 0)),
    lastShownAt: finite(parsed.lastShownAt),
    dismissedAt: finite(parsed.dismissedAt),
  };
}

/** Read-modify-write, since every tab shares the record. False if it didn't stick. */
function updateRecord(change: (record: OfferRecord) => Partial<OfferRecord>): boolean {
  const current = readOfferRecord();
  if (!current) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...change(current) }));
    return true;
  } catch {
    return false;
  }
}

export function recordOfferShown(now: number): void {
  updateRecord(() => ({ lastShownAt: now }));
}

export function recordOfferDismissed(now: number): void {
  updateRecord(() => ({ dismissedAt: now }));
}

/** The one call the Send panel makes: count this send, and say whether its
 *  receipt may try the offer. */
export function takeSendOfferTicket(signedIn: boolean, now: number = Date.now()): boolean {
  if (!sendOfferAvailable()) return false;
  const record = readOfferRecord();
  const saved = updateRecord(({ sends }) => ({ sends: sends + 1 }));
  return sendOfferAllowed({
    activity: isActivityMode(),
    signedIn,
    viewportHeight: typeof window === "undefined" ? 0 : window.innerHeight,
    record: saved ? record : null,
    now,
  });
}

/** Whether the destination is confirmed Free and can be upgraded here. Every
 *  doubt is a no. Never rejects. */
export async function canOfferPlus(guildId: string | undefined): Promise<boolean> {
  const id = guildId?.trim();
  if (!id) return false;
  const loaded = usePlanStore.getState();
  let plan: PlanInfo | null = loaded.guildId === id ? loaded.plan : null;
  if (!plan) {
    try {
      plan = await fetchGuildPlan(id);
    } catch {
      return false;
    }
  }
  return plan?.tier === "free" && plan.billing === true;
}

/** Plus's monthly price as the offer prints it. A first-payment discount names
 *  the renewal in the same line, or the headline is a bait price. */
export function plusPriceLine(campaign: PromoCampaign | null = promoFor("plus", "month")): string {
  const list = formatUsd(LIST_PRICES.plus.month);
  if (!campaign) return `${list}/mo before tax`;
  const price = formatUsd(applyPercentOff(LIST_PRICES.plus.month, campaign.percentOff));
  return campaign.duration === "first-payment"
    ? `${price} for the first month, then ${list}/mo, before tax`
    : `${price}/mo before tax`;
}
