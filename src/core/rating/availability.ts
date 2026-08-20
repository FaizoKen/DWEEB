/**
 * Runtime capability check for first-party product ratings.
 *
 * The feature is off by default on the proxy (`RATINGS_ENABLED`), because it
 * adds a durable store a deployment has to point at real storage deliberately.
 * So the app cannot know at build time whether a score would be accepted, and
 * asking someone to rate on a deployment that answers 501 would waste the one
 * time this prompt is allowed to appear.
 *
 * Same shape as the feedback / avatar-upload / MCP gates.
 */

import { isProxyConfigured } from "@/core/guild/config";
import { proxyFetch } from "@/core/net/proxyFetch";

type Availability = "unknown" | "available" | "unavailable";

let availability: Availability = isProxyConfigured() ? "unknown" : "unavailable";
let inflight: Promise<boolean> | null = null;

/** Resolve the proxy's runtime capability once, sharing one request. */
export function ensureRatingsAvailable(force = false): Promise<boolean> {
  if (!isProxyConfigured()) {
    availability = "unavailable";
    return Promise.resolve(false);
  }
  if (!force && availability !== "unknown") {
    return Promise.resolve(availability === "available");
  }
  if (inflight) return inflight;

  inflight = proxyFetch("/api/capabilities")
    .then(async (response) => {
      const body = (await response.json().catch(() => null)) as { ratings?: unknown } | null;
      const enabled = response.ok && body?.ratings === true;
      availability = enabled ? "available" : "unavailable";
      return enabled;
    })
    .catch(() => {
      availability = "unavailable";
      return false;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test seam. */
export function __resetRatingsAvailability(): void {
  availability = isProxyConfigured() ? "unknown" : "unavailable";
  inflight = null;
}
