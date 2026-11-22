/**
 * The send receipt's offer: DWEEB's own Plus plan, in the one slot under the
 * footer (`Modal`'s `below`), so its arrival and dismissal never move Done or
 * Open in Discord.
 *
 * It renders nothing until the destination is confirmed Free, and leaves as
 * soon as that server is upgraded. It also has to fit: once the dialog is at
 * its height cap, anything added below squeezes the body and lifts the buttons
 * out from under the finger about to tap them, so on such a screen it bows out
 * before it paints. Nothing here loads from a third party.
 */

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { usePlanStore } from "@/core/plan/planStore";
import { ROLELOGIC_PLAN, ROLELOGIC_URL } from "@/core/plan/prices";
import {
  canOfferPlus,
  plusPriceLine,
  recordOfferDismissed,
  recordOfferShown,
} from "@/core/plan/sendOffer";
import { trackAnalytics } from "@/core/telemetry/analytics";
import { Button } from "@/ui/Button";
import { QUOTA_ROWS } from "./pricingView";
import styles from "./SendOffer.module.css";

/** The limits the offer names, worded from the pricing table so they can't drift. */
const [SCHEDULES, SAVED, PANELS] = (["schedules", "library", "permanent"] as const).map((key) => {
  const row = QUOTA_ROWS.find((r) => r.key === key);
  return row ? `${row.values.plus} ${row.label.toLowerCase()}` : "";
});

/** `placing` renders for the one measurement that happens before paint. */
type Phase = "checking" | "placing" | "shown" | "gone";

export interface SendOfferProps {
  /** The send's destination server: the one the offer upgrades. */
  guildId?: string;
}

export function SendOffer({ guildId }: SendOfferProps) {
  const [phase, setPhase] = useState<Phase>("checking");
  const regionRef = useRef<HTMLElement | null>(null);
  const upgraded = usePlanStore(
    (s) => s.guildId === guildId && s.plan != null && s.plan.tier !== "free",
  );

  useEffect(() => {
    let cancelled = false;
    void canOfferPlus(guildId).then((ok) => {
      if (!cancelled) setPhase(ok ? "placing" : "gone");
    });
    return () => {
      cancelled = true;
    };
  }, [guildId]);

  // Where is the footer with the offer, and without it? `offsetTop`, not a
  // rect: the dialog may still be in its entrance transform.
  useLayoutEffect(() => {
    if (phase !== "placing") return;
    const region = regionRef.current;
    const footer = region?.previousElementSibling;
    if (!region || !(footer instanceof HTMLElement)) {
      setPhase("gone");
      return;
    }
    const withOffer = footer.offsetTop;
    region.style.display = "none";
    const without = footer.offsetTop;
    region.style.display = "";
    if (withOffer !== without) {
      setPhase("gone");
      return;
    }
    setPhase("shown");
    recordOfferShown(Date.now());
    trackAnalytics("send_offer", { result: "shown" });
  }, [phase]);

  if (phase === "checking" || phase === "gone" || upgraded || !guildId) return null;

  const dismiss = (event: MouseEvent<HTMLButtonElement>) => {
    // The button is about to leave: keep focus inside the receipt.
    event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
    setPhase("gone");
    recordOfferDismissed(Date.now());
    trackAnalytics("send_offer", { result: "dismissed" });
  };

  return (
    <aside ref={regionRef} className={styles.region} aria-label="DWEEB Plus offer">
      <p className={styles.title}>More room for this server with Plus</p>
      <p className={styles.text}>
        {SCHEDULES}, {SAVED} and {PANELS}.
      </p>
      <p className={styles.price}>{plusPriceLine()}</p>
      <p className={styles.text}>
        Includes RoleLogic {ROLELOGIC_PLAN.plus} if you{" "}
        <a className={styles.link} href={ROLELOGIC_URL} target="_blank" rel="noopener noreferrer">
          sign in to RoleLogic
        </a>{" "}
        before paying.
      </p>
      <div className={styles.actions}>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Not now
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => usePlanStore.getState().openPricing(guildId, "send_offer")}
        >
          See Plus
        </Button>
      </div>
    </aside>
  );
}
