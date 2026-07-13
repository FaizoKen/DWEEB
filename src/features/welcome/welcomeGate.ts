/**
 * "Should the app offer the intro film?" decision.
 *
 * The welcome video (the DWEEB launch film — problem → build → preview → send,
 * with captions burned in) is an optional orientation for brand-new users.
 * Prompting more than once would turn a welcome into a nag, so this module owns
 * the persistent record of whether the user has met it and the
 * decision each load makes from it:
 *
 *  1. **Any record at all ⇒ never prompt.** The More-menu "Watch the intro"
 *     entry covers replays.
 *  2. **No record, but evidence of prior use ⇒ "announce".** Users from before
 *     the film existed already know the editor — they get the same one-time
 *     toast pointing at the menu entry. "Prior use" is any trace an earlier
 *     session left behind: the gallery's auto-open stamp or a saved draft.
 *  3. **Clean slate ⇒ "show".** A genuine first visit.
 *
 * Storage mirrors `galleryAutoOpen` / `draftStorage`: a versioned key and
 * reads that never throw (storage may be disabled or hold an older shape).
 */

import { loadDraft } from "@/core/state/draftStorage";
import { hasGalleryEverAutoOpened } from "@/features/templates/galleryAutoOpen";

const STORAGE_KEY = "dweeb.welcome.v1";

/** How the user's one auto-encounter with the film stands. */
export type WelcomeRecordStatus =
  /** Legacy record from releases that auto-played the film. */
  | "shown"
  /** The discovery toast was shown once. */
  | "announced";

export interface WelcomeRecord {
  status: WelcomeRecordStatus;
  /** Unix millis when the record was written. */
  at: number;
}

const STATUSES: readonly string[] = ["shown", "announced"];

/** Read the welcome record, or null if never written / unreadable. */
export function readWelcomeRecord(): WelcomeRecord | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WelcomeRecord;
    if (!parsed || typeof parsed !== "object") return null;
    if (!STATUSES.includes(parsed.status) || typeof parsed.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Record how the auto-encounter stands. Never throws. */
export function writeWelcomeRecord(status: WelcomeRecordStatus): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ status, at: Date.now() }));
  } catch {
    // Storage disabled or over quota — worst case the app offers the film once
    // more on a later visit, which is harmless.
  }
}

/** What this load should do about the film, per the module rules above. */
export type WelcomeAutoDecision = "show" | "announce" | "no";

export function welcomeAutoDecision(): WelcomeAutoDecision {
  if (readWelcomeRecord()) return "no";
  if (hasGalleryEverAutoOpened() || loadDraft() !== null) return "announce";
  return "show";
}
