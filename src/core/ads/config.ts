/**
 * Whether this build shows ads at all — build-time env, like Stripe's key.
 *
 * Unset (every self-hosted build, and production until the AdSense account is
 * approved) means no ad code runs, no ad host is in the CSP, and no `ads.txt`
 * ships. See `adsenseIds.ts` for what counts as a valid value.
 */

import { parseAdsenseClient, parseAdsenseSlot } from "./adsenseIds";

/** `ca-pub-…`, or `""` when ads are off. */
export const ADSENSE_CLIENT = parseAdsenseClient(
  import.meta.env.VITE_ADSENSE_CLIENT as string | undefined,
);

/** The send-receipt ad unit's slot id, or `""` when ads are off. */
export const ADSENSE_SLOT = parseAdsenseSlot(
  import.meta.env.VITE_ADSENSE_SLOT as string | undefined,
);

/** True when both ids are configured — the one switch every ad surface reads. */
export function adsConfigured(): boolean {
  return ADSENSE_CLIENT.length > 0 && ADSENSE_SLOT.length > 0;
}
