/**
 * One-shot auto-start sequencing for the onboarding tour.
 *
 * The tour must land on a *settled, unobstructed* editor — never on top of the
 * first-visit surfaces that precede it. On a genuine first visit the order of
 * events is: the Template Gallery auto-opens (App's landing screen), the user
 * picks a starting point, an interactive template may then run its guided
 * plugin setup, and only when all of that has closed is the editor actually
 * in front. So the trigger here is: *the gallery has been open and is now
 * closed, and no template setup is running* — plus a short settle delay so
 * the layout (and the gallery's exit) finishes before the spotlight measures
 * its first anchor.
 *
 * Requiring "the gallery opened first" also inherits the gallery's own
 * deep-link suppression for free: on share-link / template-link / webhook-
 * return loads the gallery stands down, so the tour does too, and — because
 * nothing is recorded — a later organic visit still gets its one auto-start.
 *
 * The decision itself (first visit vs. pre-tour user vs. already met) lives in
 * `tutorialGate`; this hook only sequences it. Pre-tour users are never
 * auto-toured — they get a single toast pointing at the More menu's
 * "Take the tour" entry, recorded so it can't repeat.
 */

import { useEffect, useRef, useState } from "react";
import { useTemplateGalleryStore } from "@/features/templates/templateGalleryStore";
import { useTemplateSetupStore } from "@/features/templates/templateSetupStore";
import { pushToast } from "@/ui/Toast";
import { readTutorialRecord, tutorialAutoDecision, writeTutorialRecord } from "./tutorialGate";
import { useTutorialStore } from "./tutorialStore";

/** Settle delay between the last overlay closing and the tour appearing. */
const START_DELAY_MS = 600;

export function useTutorialAutoStart(): void {
  // Decided once per load, during first render — before App's mount effects
  // run (in particular before the gallery auto-open stamps its own record,
  // which the gate reads as "evidence of prior use").
  const [decision] = useState(tutorialAutoDecision);
  const galleryOpen = useTemplateGalleryStore((s) => s.open);
  const setupTemplateId = useTemplateSetupStore((s) => s.templateId);
  const galleryWasOpen = useRef(false);
  const fired = useRef(false);

  // Arm immediately so the send coach-mark (raised when template setup or a
  // static template pick nudges toward Send) stands down for the whole
  // first-visit flow — the tour's final step covers the same ground.
  useEffect(() => {
    if (decision === "start") useTutorialStore.getState().arm();
  }, [decision]);

  useEffect(() => {
    if (fired.current) return;
    if (galleryOpen) {
      galleryWasOpen.current = true;
      return;
    }
    if (setupTemplateId) return;

    // `fired` latches only inside the timer callback: if an overlay reopens
    // during the settle delay, the cleanup cancels the timer and the next
    // close simply schedules a fresh one.
    if (decision === "start") {
      // First visit: wait until the landing gallery has come and gone.
      if (!galleryWasOpen.current) return;
      const t = setTimeout(() => {
        fired.current = true;
        // Re-check only the tour's own record in case another tab raced us
        // through it — NOT the full decision, whose "prior use" evidence
        // (gallery stamp, auto-saved draft) this very session has created by
        // now. If a record exists, stand down (un-suppressing the coach-mark).
        if (readTutorialRecord() === null) {
          useTutorialStore.getState().start("auto");
        } else {
          useTutorialStore.getState().disarm();
        }
      }, START_DELAY_MS);
      return () => clearTimeout(t);
    }

    if (decision === "announce") {
      // Pre-tour user: one quiet pointer at the replayable tour, once ever.
      // No gallery requirement — their session may skip the landing screen.
      const t = setTimeout(() => {
        fired.current = true;
        writeTutorialRecord("announced");
        pushToast('New: a quick tour of the editor — find "Take the tour" under More.', "info");
      }, START_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [decision, galleryOpen, setupTemplateId]);
}
