/**
 * Paid servers are ad-free: a send to a Plus or Pro server never shows an ad.
 *
 * Premium is per server, so "is this ad-free" is a question about the send's
 * destination, not about the person. The plan store already holds the tier of
 * the server connected in the builder, which is nearly always where the send
 * went; any other server is asked once per page and remembered.
 *
 * When the answer can't be had, the two ways of being wrong are not equal: an
 * ad on a server someone pays for is a broken promise, one missing impression
 * costs nothing. So a failed lookup (no answer, a 429, a 5xx) reads as ad-free.
 * A clean answer of "free" shows an ad, and so does having nothing to ask with:
 * no server, nobody signed in, or a server whose plan the proxy won't show this
 * person (403/404 — one they don't manage).
 */

import { registerAccountStateReset } from "@/core/auth/accountScopedState";
import { fetchGuildPlan, GuildApiError, type PlanTier } from "@/core/guild/api";
import { isProxyConfigured } from "@/core/guild/config";
import { usePlanStore } from "@/core/plan/planStore";

const known = new Map<string, boolean>();

function paid(tier: PlanTier): boolean {
  return tier !== "free";
}

/** Whether a send to `guildId` must not carry an ad. Never rejects. */
export async function isAdFreeDestination(guildId: string | undefined): Promise<boolean> {
  const id = guildId?.trim();
  // A send whose server we never learned (a pasted webhook we couldn't
  // resolve) has no plan to honour.
  if (!id) return false;

  const plan = usePlanStore.getState();
  if (plan.guildId === id && plan.plan) return paid(plan.plan.tier);

  const cached = known.get(id);
  if (cached !== undefined) return cached;
  if (!isProxyConfigured()) return false;

  try {
    const info = await fetchGuildPlan(id);
    // Signed out (or a server this person can't read): no plan we can see, and
    // no answer worth remembering — signing in may change it.
    if (!info) return false;
    const adFree = paid(info.tier);
    known.set(id, adFree);
    return adFree;
  } catch (e) {
    // The proxy answered and won't show this person that server's plan (a
    // server they don't manage): the same "can't see it" as signed out, not a
    // failure. A 429, our own 5xx or no answer at all is a failed lookup.
    if (e instanceof GuildApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
      return false;
    }
    return true;
  }
}

/** Forget remembered answers — on sign-out, and after a purchase changes one. */
export function forgetAdFreeDestinations(): void {
  known.clear();
}

registerAccountStateReset(forgetAdFreeDestinations);
