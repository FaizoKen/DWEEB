/**
 * "Should the onboarding tour auto-start?" decision.
 *
 * The guided tour is a one-shot orientation for brand-new users. Auto-starting
 * it more than once — or popping it over a returning user who has already
 * internalised the editor — would turn a welcome into a nag, so this module
 * owns the persistent record of whether the user has met the tour and the
 * decision each load makes from it:
 *
 *  1. **Any record at all ⇒ never auto-start.** "done", "skipped", even a
 *     "started" left by a tab closed mid-tour all mean the user has seen it;
 *     the More-menu "Take the tour" entry covers replays.
 *  2. **No record, but evidence of prior use ⇒ "announce".** Users from before
 *     the tour existed shouldn't be toured like newcomers — they get a one-time
 *     toast pointing at the menu entry instead. "Prior use" is any trace an
 *     earlier session left behind: the gallery's auto-open stamp or a saved
 *     draft.
 *  3. **Clean slate ⇒ "start".** A genuine first visit; the caller sequences
 *     the actual start around the Template Gallery (see `useTutorialAutoStart`).
 *
 * Storage mirrors `galleryAutoOpen` / `draftStorage`: a versioned key and
 * reads that never throw (storage may be disabled or hold an older shape).
 */

import { loadDraft } from "@/core/state/draftStorage";
import { hasGalleryEverAutoOpened } from "@/features/templates/galleryAutoOpen";

const STORAGE_KEY = "dweeb.tutorial.v1";

/** How the user's one auto-encounter with the tour ended (or stands). */
export type TutorialRecordStatus =
  /** Finished every step. */
  | "done"
  /** Dismissed it early (Skip button / Escape). */
  | "skipped"
  /** Auto-started; no outcome recorded yet (e.g. the tab closed mid-tour). */
  | "started"
  /** Pre-tour user — never auto-toured; the discovery toast was shown once. */
  | "announced";

export interface TutorialRecord {
  status: TutorialRecordStatus;
  /** Unix millis when the record was written. */
  at: number;
  /** For "skipped": the 0-based step the user bailed on. */
  step?: number;
}

const STATUSES: readonly string[] = ["done", "skipped", "started", "announced"];

/** Read the tour record, or null if never written / unreadable. */
export function readTutorialRecord(): TutorialRecord | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TutorialRecord;
    if (!parsed || typeof parsed !== "object") return null;
    if (!STATUSES.includes(parsed.status) || typeof parsed.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Record how the auto-encounter stands. Never throws. */
export function writeTutorialRecord(status: TutorialRecordStatus, step?: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    const record: TutorialRecord = { status, at: Date.now() };
    if (step !== undefined) record.step = step;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage disabled or over quota — worst case the tour auto-offers once
    // more on a later visit, which is harmless.
  }
}

/** What this load should do about the tour, per the module rules above. */
export type TutorialAutoDecision = "start" | "announce" | "no";

export function tutorialAutoDecision(): TutorialAutoDecision {
  if (readTutorialRecord()) return "no";
  if (hasGalleryEverAutoOpened() || loadDraft() !== null) return "announce";
  return "start";
}
