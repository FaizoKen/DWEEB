/**
 * The send receipt's ad — the only ad DWEEB shows.
 *
 * It renders under the receipt's footer (`Modal`'s `below`), so it appears
 * after the work is done and its arrival or collapse never moves Done / Open in
 * Discord. It shows nothing at all until it has something to show: the paid-
 * server check and the tag load happen first, and a paid server, a blocked
 * tag, an unfilled request or a request that never answers each leave the
 * receipt exactly as it was without the ad — no empty box, no "please disable
 * your ad blocker". A filled ad is the only state that occupies space for long.
 *
 * The send panel decides whether a receipt may try (`takeSendAdTicket`); this
 * component only carries out that one attempt.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isAdFreeDestination } from "@/core/ads/adFree";
import { loadAdSense, requestAd } from "@/core/ads/adsense";
import { ADSENSE_CLIENT, ADSENSE_SLOT } from "@/core/ads/config";
import { recordAdShown } from "@/core/ads/eligibility";
import { usePlanStore } from "@/core/plan/planStore";
import { isCheckoutConfigured } from "@/core/plan/stripeConfig";
import { trackAnalytics } from "@/core/telemetry/analytics";
import styles from "./SendAd.module.css";

/** The unit's box: a 320×100 large mobile banner, narrowed to fit. */
const AD_MAX_WIDTH = 320;
const AD_HEIGHT = 100;
/** Narrower than this, no standard creative fits — skip rather than squeeze. */
const AD_MIN_WIDTH = 250;
/** How long a pushed request may go without Google saying filled or unfilled. */
const FILL_TIMEOUT_MS = 10_000;

type Phase = "checking" | "placing" | "filled" | "gone";

/** How the one attempt ended — the `result` of the `ad_slot` analytics event. */
export type SendAdResult = "filled" | "unfilled" | "blocked" | "timeout" | "no_room" | "ad_free";

export interface SendAdProps {
  /** The send's destination server: paid servers are ad-free, and "Remove ads"
   *  opens that server's plans. */
  guildId?: string;
}

export function SendAd({ guildId }: SendAdProps) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [width, setWidth] = useState(0);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const insRef = useRef<HTMLModElement | null>(null);
  const pushed = useRef(false);
  const reported = useRef(false);

  // Only refs and state setters, so the steps below can call it without
  // listing it — and without re-running when the component re-renders.
  const finish = useRef((result: SendAdResult) => {
    if (!reported.current) {
      reported.current = true;
      trackAnalytics("ad_slot", { result });
    }
    if (result === "filled") {
      recordAdShown(Date.now());
      setPhase("filled");
    } else {
      setPhase("gone");
    }
  }).current;

  // Step 1: is this send ad-free, and will the tag load at all? Both before
  // anything renders, so neither answer can flash a box that then vanishes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (await isAdFreeDestination(guildId)) {
        if (!cancelled) finish("ad_free");
        return;
      }
      const loaded = await loadAdSense();
      if (cancelled) return;
      if (loaded) setPhase("placing");
      else finish("blocked");
    })();
    return () => {
      cancelled = true;
    };
  }, [guildId, finish]);

  // Step 2: the region is on screen — size the unit to the room it has.
  useLayoutEffect(() => {
    if (phase !== "placing") return;
    const available = Math.floor(slotRef.current?.clientWidth ?? 0);
    const next = Math.min(AD_MAX_WIDTH, available);
    if (next < AD_MIN_WIDTH) finish("no_room");
    else setWidth(next);
  }, [phase, finish]);

  // Step 3: the sized `ins` is attached — ask Google to fill it (once; a second
  // push for the same slot throws), then follow the status attribute AdSense
  // stamps on it.
  useEffect(() => {
    if (phase !== "placing" || width === 0) return;
    const ins = insRef.current;
    if (!ins) return;
    if (!pushed.current) {
      pushed.current = true;
      if (!requestAd()) {
        finish("timeout");
        return;
      }
    }
    const read = () => {
      const status = ins.getAttribute("data-ad-status");
      if (status === "filled") finish("filled");
      else if (status === "unfilled") finish("unfilled");
      return status === "filled" || status === "unfilled";
    };
    if (read()) return;
    const observer = new MutationObserver(() => {
      if (read()) observer.disconnect();
    });
    observer.observe(ins, { attributes: true, attributeFilter: ["data-ad-status"] });
    // An answer that never comes removes the slot outright (never just hides
    // it): a request still in flight then has nothing left to fill.
    const timer = window.setTimeout(() => {
      observer.disconnect();
      if (!read()) finish("timeout");
    }, FILL_TIMEOUT_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [phase, width, finish]);

  if (phase === "checking" || phase === "gone") return null;

  const canRemove = Boolean(guildId) && isCheckoutConfigured();

  return (
    <aside className={styles.region} aria-label="Advertisement" data-phase={phase}>
      <div className={styles.head}>
        <span className={styles.label}>Advertisement</span>
        {canRemove && guildId ? (
          <button
            type="button"
            className={styles.remove}
            onClick={() => usePlanStore.getState().openPricing(guildId, "send_ad")}
          >
            Remove ads
          </button>
        ) : null}
      </div>
      <div ref={slotRef} className={styles.slot} style={{ height: AD_HEIGHT }}>
        {width > 0 ? (
          // `data-adtest` keeps local development from counting as traffic.
          <ins
            ref={insRef}
            className="adsbygoogle"
            style={{ display: "inline-block", width, height: AD_HEIGHT }}
            data-ad-client={ADSENSE_CLIENT}
            data-ad-slot={ADSENSE_SLOT}
            data-adtest={import.meta.env.DEV ? "on" : undefined}
          />
        ) : null}
      </div>
    </aside>
  );
}
