/**
 * The one call the Send panel makes: count this successful send and say
 * whether its receipt may try an ad. Gathers the browser facts
 * `sendAdAllowed` judges (see `eligibility.ts` for the rules); the paid-server
 * check runs later, inside the slot, because it may need the network.
 */

import { isActivityMode } from "@/core/activity/runtime";
import { adScriptFailed } from "./adsense";
import { adsConfigured } from "./config";
import {
  browserSavesData,
  browserSendsPrivacySignal,
  readAdRecord,
  recordSend,
  sendAdAllowed,
} from "./eligibility";

export function takeSendAdTicket(now: number = Date.now()): boolean {
  // A build without ads keeps no record at all.
  if (!adsConfigured()) return false;
  const record = readAdRecord();
  recordSend();
  return sendAdAllowed({
    configured: true,
    activity: isActivityMode(),
    privacySignal: browserSendsPrivacySignal(),
    saveData: browserSavesData(),
    blocked: adScriptFailed(),
    addressHoldsState:
      typeof window === "undefined" ||
      window.location.search.length > 1 ||
      window.location.hash.length > 1,
    viewportHeight: typeof window === "undefined" ? 0 : window.innerHeight,
    priorSends: record.sends,
    lastShownAt: record.lastShownAt,
    now,
  });
}
