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

/**
 * The raw stored record: the string (or null when none was written), or
 * `undefined` when storage can't be read at all — missing, or blocked so that
 * `getItem` itself throws. App reads this from a `useState` initializer, so a
 * throw escaping here took the whole app to the ErrorBoundary.
 */
function readRaw(): string | null | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return undefined;
  }
}

/** Read the welcome record, or null if never written / unreadable. */
export function readWelcomeRecord(): WelcomeRecord | null {
  const raw = readRaw();
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

/**
 * Record how the auto-encounter stands. Never throws. True only when the record
 * reads back — a store that silently drops writes would otherwise have the offer
 * made again on every load.
 */
export function writeWelcomeRecord(status: WelcomeRecordStatus): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ status, at: Date.now() }));
    return readWelcomeRecord()?.status === status;
  } catch {
    // Storage disabled or over quota.
    return false;
  }
}

/** What this load should do about the film, per the module rules above. */
export type WelcomeAutoDecision = "show" | "announce" | "no";

export function welcomeAutoDecision(suppress = false): WelcomeAutoDecision {
  // A deliberate SEO/content-page handoff already has a job to do. Suppress
  // the prompt without writing a record so a later organic visit can still
  // receive the one-time orientation.
  if (suppress) return "no";
  // Storage we can't read is storage we can't write the record to either — the
  // one-time offer would come back on every load. The More menu's "Watch the
  // intro" still reaches the film.
  if (readRaw() === undefined) return "no";
  if (readWelcomeRecord()) return "no";
  if (hasGalleryEverAutoOpened() || loadDraft() !== null) return "announce";
  return "show";
}
