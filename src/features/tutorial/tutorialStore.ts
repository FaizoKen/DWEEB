/**
 * Onboarding tour store.
 *
 * Owns the guided tour's live state: whether it's running, which step it's on,
 * and — before it even starts — whether an auto-start is *armed* for this load.
 * A tiny global store in the mould of `templateGalleryStore` / `sendNudgeStore`
 * so any surface (App's auto-start hook, the Builder's More menu, the overlay
 * itself) can drive it without prop chains.
 *
 * "Armed" exists so the two first-run spotlights never stack: template setup
 * ends by raising the send nudge, whose coach-mark rings the Send button — but
 * on a first visit the tour is about to start and its final step spotlights
 * Send with the same guidance. While armed (or active), `SendCoachMark` and the
 * mobile preview-raise stand down; once the tour finishes or is skipped, later
 * nudges behave normally again.
 *
 * Persistence policy (see `tutorialGate`): an *auto* start writes "started"
 * immediately, so even a tab closed mid-tour counts as met — auto-start is
 * strictly one-shot. Finishing writes "done", skipping "skipped". A *manual*
 * replay (More menu) writes nothing on start; only its outcome is recorded.
 */

import { create } from "zustand";
import { TOUR_STEPS } from "./steps";
import { writeTutorialRecord } from "./tutorialGate";

interface TutorialState {
  /** "idle" until `start()`, then "active" while the overlay is up. */
  status: "idle" | "active";
  /** 0-based index into `TOUR_STEPS`. */
  step: number;
  /** An auto-start is scheduled for this load (first visit, tour not yet met). */
  armed: boolean;
  arm(): void;
  /** Cancel a scheduled auto-start without recording anything. */
  disarm(): void;
  /** Begin the tour from step 0. `mode` decides the persistence write. */
  start(mode: "auto" | "manual"): void;
  next(): void;
  back(): void;
  /** Jump straight to a step (the callout's progress dots). */
  goTo(step: number): void;
  /** Bail out early — records the skip so auto-start never returns. */
  skip(): void;
  finish(): void;
}

export const useTutorialStore = create<TutorialState>((set, get) => ({
  status: "idle",
  step: 0,
  armed: false,

  arm: () => set({ armed: true }),

  disarm: () => set({ armed: false }),

  start(mode) {
    if (get().status === "active") return;
    if (mode === "auto") writeTutorialRecord("started");
    set({ status: "active", step: 0 });
  },

  next() {
    const { step } = get();
    if (step >= TOUR_STEPS.length - 1) {
      get().finish();
    } else {
      set({ step: step + 1 });
    }
  },

  back: () => set((s) => ({ step: Math.max(0, s.step - 1) })),

  goTo: (step) => set({ step: Math.min(Math.max(0, step), TOUR_STEPS.length - 1) }),

  skip() {
    writeTutorialRecord("skipped", get().step);
    set({ status: "idle", step: 0, armed: false });
  },

  finish() {
    writeTutorialRecord("done");
    set({ status: "idle", step: 0, armed: false });
  },
}));

/**
 * Whether the tour currently claims the first-run spotlight — armed for an
 * imminent auto-start, or already running. `SendCoachMark` (and App's
 * nudge-raises-preview effect) consult this to stand down.
 */
export function tourClaimsSpotlight(): boolean {
  const s = useTutorialStore.getState();
  return s.armed || s.status === "active";
}
