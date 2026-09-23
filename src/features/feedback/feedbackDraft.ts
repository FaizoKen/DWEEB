/**
 * An unsent feedback report, kept for the rest of this tab's session.
 *
 * `App` unmounts the dialog on every close — Escape, a stray backdrop click,
 * the × — so a half-written report used to vanish with one misplaced keypress.
 * It is saved here while being typed and restored when the dialog next opens,
 * until it is sent or explicitly discarded. sessionStorage, not local: a report
 * is a one-sitting thing and shouldn't outlive the tab it was written in.
 *
 * Every access is guarded — a browser that blocks site data throws from the
 * `sessionStorage` accessor itself — and anything unreadable is "no draft".
 * Only the lazily loaded dialog imports this, so it costs the boot bundle
 * nothing.
 */

import {
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_DETAILS_MAX,
  FEEDBACK_SUMMARY_MAX,
  FEEDBACK_TAGS,
} from "@/core/feedback/submit";

const STORAGE_KEY = "dweeb.feedback.draft.v1";

export interface FeedbackDraft {
  tagIndex: number;
  summary: string;
  details: string;
  contact: string;
}

/** Nothing worth keeping: a picked type alone isn't a report. */
export function isEmptyFeedbackDraft(draft: FeedbackDraft): boolean {
  return !draft.summary.trim() && !draft.details.trim() && !draft.contact.trim();
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function loadFeedbackDraft(): FeedbackDraft | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const tag = record.tagIndex;
    const draft: FeedbackDraft = {
      tagIndex:
        typeof tag === "number" && Number.isInteger(tag) && tag >= 0 && tag < FEEDBACK_TAGS.length
          ? tag
          : 0,
      // Clamped like the inputs themselves, so a tampered record can't smuggle
      // in more than the form would ever let anyone type.
      summary: text(record.summary, FEEDBACK_SUMMARY_MAX),
      details: text(record.details, FEEDBACK_DETAILS_MAX),
      contact: text(record.contact, FEEDBACK_CONTACT_MAX),
    };
    return isEmptyFeedbackDraft(draft) ? null : draft;
  } catch {
    return null;
  }
}

/** Keep the report as it stands; an emptied form removes the saved copy. */
export function saveFeedbackDraft(draft: FeedbackDraft): void {
  try {
    if (isEmptyFeedbackDraft(draft)) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Blocked or full storage — the report still sends; it just won't survive a close.
  }
}

export function clearFeedbackDraft(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was saved, then.
  }
}
