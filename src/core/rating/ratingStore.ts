/**
 * When the rating prompt may appear, and what happens when it does.
 *
 * ## The one rule this store exists to enforce
 *
 * Ask once. DWEEB already decided that the intro film is opt-in and that an SEO
 * CTA arrival suppresses the welcome tour — an editor is a workspace, and a
 * recurring "rate us" interruption is exactly the pattern this project has
 * avoided everywhere else. So every gate below is a reason NOT to prompt, and
 * the prompt has to clear all of them:
 *
 *  1. the deployment runs the feature at all (`/api/capabilities`);
 *  2. the person is signed in — the score is keyed to a Discord account, and
 *     an anonymous prompt could only lead to a sign-in wall;
 *  3. they have not already rated, **as the server sees it**, so rating on one
 *     device settles it on every device;
 *  4. they have not dismissed a prompt before (local, permanent);
 *  5. nothing has prompted yet in this tab.
 *
 * It is armed by a *successful send*, not by page load. That is the moment the
 * product has just done its job, so it is both the honest time to ask and the
 * only time the answer means anything.
 *
 * ## Deliberately not here
 *
 * No review gating. Whatever score is picked is recorded and the person is
 * thanked; a high score additionally reveals an optional Top.gg link, because
 * Top.gg is where a Discord-native recommendation actually reaches people. The
 * score itself is never withheld or re-routed based on its value — that would
 * bias the very average the site publishes.
 */

import { create } from "zustand";
import { registerAccountStateReset } from "@/core/auth/accountScopedState";
import { fetchMyRating, submitRating, type MyRating } from "./ratingApi";
import { ensureRatingsAvailable } from "./availability";

/** Remembers a dismissal across sessions. Versioned so a future redesign can
 *  legitimately ask again without silently re-prompting everyone today. */
const DISMISSED_KEY = "dweeb:rating-prompt-dismissed:v1";

/** How long after a successful send the prompt appears. Long enough that it
 *  never races the success modal's own dismissal animation, short enough to
 *  still read as a response to what just happened. */
const ARM_DELAY_MS = 900;

type Phase = "idle" | "asking" | "thanks";

interface RatingState {
  phase: Phase;
  /** The score just submitted, for the thank-you step. */
  score: number | null;
  /** True while the POST is in flight, so the stars can't be double-submitted. */
  busy: boolean;
  /** Arm the prompt after a successful send. Safe to call on every send. */
  arm: () => void;
  /** Record a score. */
  choose: (score: number) => Promise<void>;
  /** Close it. `permanent` marks it never-ask-again. */
  dismiss: (permanent?: boolean) => void;
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // A browser with storage blocked still gets one prompt per tab thanks to
    // `promptedThisSession`; it must not get a crash instead.
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    /* storage unavailable — the session guard still holds for this tab */
  }
}

/** Tab-scoped: one prompt per page load, whatever else happens. */
let promptedThisSession = false;
/** Cancels a pending arm when the account changes underneath it. */
let armTimer: ReturnType<typeof setTimeout> | null = null;
let armToken = 0;

export const useRatingStore = create<RatingState>((set, get) => ({
  phase: "idle",
  score: null,
  busy: false,

  arm: () => {
    if (promptedThisSession || get().phase !== "idle" || wasDismissed()) return;
    const token = ++armToken;
    if (armTimer) clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      armTimer = null;
      void (async () => {
        // Both checks are awaited before anything is shown, so the prompt never
        // appears and then retracts. A refusal at any step is silent: there is
        // nothing a user could do about it and nothing worth telling them.
        const available = await ensureRatingsAvailable();
        if (!available || token !== armToken) return;
        // Only an explicit "signed in, hasn't rated" opens the prompt. Anything
        // else — signed out, offline, an unreadable reply — is `unknown`, and
        // asking then would either waste the one prompt we get or take a tap
        // the server is bound to refuse.
        const mine = await fetchMyRating().catch((): MyRating => ({ state: "unknown" }));
        if (mine.state !== "unrated" || token !== armToken) return;
        if (promptedThisSession || wasDismissed()) return;
        promptedThisSession = true;
        set({ phase: "asking", score: null });
      })();
    }, ARM_DELAY_MS);
  },

  choose: async (score) => {
    if (get().busy) return;
    set({ busy: true });
    const ok = await submitRating(score).catch(() => false);
    // A failed submit still closes with thanks rather than an error toast. The
    // person did the thing we asked; a retry prompt over a number they gave us
    // as a favour would cost them more than the lost data point costs us.
    rememberDismissed();
    set({ phase: "thanks", score: ok ? score : null, busy: false });
  },

  dismiss: (permanent = true) => {
    if (permanent) rememberDismissed();
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    set({ phase: "idle", score: null, busy: false });
  },
}));

/** Arm the prompt after a message posts successfully. */
export function armRatingPrompt(): void {
  useRatingStore.getState().arm();
}

// Signing out mid-arm must not leave a prompt that would post under the next
// account — and the "have they already rated?" answer belongs to whoever was
// signed in when it was asked.
registerAccountStateReset(() => {
  armToken += 1;
  if (armTimer) {
    clearTimeout(armTimer);
    armTimer = null;
  }
  useRatingStore.setState({ phase: "idle", score: null, busy: false });
});

/**
 * Test seam — resets the module-level guards that model "this tab".
 *
 * Deliberately leaves `localStorage` alone: the stored dismissal is what
 * outlives a tab, so a test simulating a fresh visit needs to reset the session
 * guards *without* forgetting that the person already said no.
 */
export function __resetRatingPromptGuards(): void {
  promptedThisSession = false;
  armToken += 1;
  if (armTimer) {
    clearTimeout(armTimer);
    armTimer = null;
  }
  useRatingStore.setState({ phase: "idle", score: null, busy: false });
}
