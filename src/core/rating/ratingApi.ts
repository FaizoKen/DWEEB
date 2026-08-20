/**
 * Client for the first-party rating endpoints (`server/src/rating.rs`).
 *
 * The rating exists to be published as `aggregateRating` in DWEEB's structured
 * data — which is the only form of "review" that changes DWEEB's own search
 * result, since every third-party review platform marks its outbound links
 * nofollow. That makes the number a factual claim, so the server keys it on the
 * signed-in Discord user id and this client never tries to remember a score on
 * its behalf.
 */

import { proxyFetch } from "@/core/net/proxyFetch";
import { isProxyConfigured, PROXY_BASE_URL } from "@/core/guild/config";

/** Ends of the scale, mirroring `MIN_SCORE`/`MAX_SCORE` on the proxy. */
export const MIN_SCORE = 1;
export const MAX_SCORE = 5;

export interface RatingAggregate {
  average: number;
  count: number;
  best: number;
  worst: number;
  distribution: number[];
}

/**
 * What the server knows about the caller's own rating.
 *
 * Three states, not two, and the distinction is load-bearing. `/api/rating/me`
 * is identity-gated, so it answers 401 for a signed-out caller — collapsing
 * that into "hasn't rated yet" would prompt someone whose score the server is
 * then bound to refuse, losing their tap silently. `unknown` covers every
 * reason we cannot answer (signed out, offline, feature off, malformed reply)
 * and means exactly one thing to the caller: do not ask.
 */
export type MyRating =
  | { state: "rated"; score: number }
  | { state: "unrated" }
  | { state: "unknown" };

/**
 * The caller's own rating.
 *
 * Asked of the server rather than of localStorage on purpose: the prompt must
 * appear once per person, and a device-local memory would re-ask the same
 * person on their laptop after they rated on their phone.
 */
export async function fetchMyRating(signal?: AbortSignal): Promise<MyRating> {
  if (!isProxyConfigured()) return { state: "unknown" };
  const response = await proxyFetch("/api/rating/me", { signal });
  if (!response.ok) return { state: "unknown" };
  const body = (await response.json().catch(() => null)) as { mine?: unknown } | null;
  if (!body || !("mine" in body)) return { state: "unknown" };
  if (typeof body.mine === "number") return { state: "rated", score: body.mine };
  // An explicit null is the server saying "signed in, hasn't rated" — the one
  // answer that earns a prompt.
  return body.mine === null ? { state: "unrated" } : { state: "unknown" };
}

/** Record the signed-in user's score. Resolves false on any refusal. */
export async function submitRating(score: number, signal?: AbortSignal): Promise<boolean> {
  if (!isProxyConfigured()) return false;
  if (!Number.isInteger(score) || score < MIN_SCORE || score > MAX_SCORE) return false;
  const response = await proxyFetch("/api/rating", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ score }),
    signal,
  });
  return response.ok;
}

/** Public aggregate. Unused by the builder today — the generated pages read it
 *  at build time — but it is the same contract, so it lives beside its siblings. */
export async function fetchRatingSummary(signal?: AbortSignal): Promise<RatingAggregate | null> {
  if (!PROXY_BASE_URL) return null;
  const response = await proxyFetch("/api/rating", { signal });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as RatingAggregate | null;
}
