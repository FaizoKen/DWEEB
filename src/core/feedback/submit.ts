/**
 * Quick-feedback submission.
 *
 * Both the web builder and the embedded Activity send a small, closed report
 * shape to the DWEEB proxy. The server owns the destination webhook credential,
 * validates every field, disables mentions, maps categories to forum tags, and
 * constructs the final Discord payload. No webhook URL is present in this
 * module or in the shipped browser bundle.
 */

import { isActivityMode } from "@/core/activity/runtime";
import { proxyFetch } from "@/core/net/proxyFetch";
import { ensureFeedbackAvailability, isFeedbackConfigured } from "@/core/feedback/availability";

export { isFeedbackConfigured, useFeedbackConfigured } from "@/core/feedback/availability";

/** Where the team and community follow up — shown to the user after they send,
 *  so they know where a reply will come from. */
export const SUPPORT_INVITE_URL = "https://discord.gg/2wB7rHRDg2";

export type FeedbackCategory = "suggestion" | "bug" | "question" | "other";

/** A category the user picks; the server maps it to an allow-listed forum tag. */
export interface FeedbackTag {
  category: FeedbackCategory;
  label: string;
  /** Leading emoji shown in the picker and forum post title. */
  emoji: string;
  /** One-line description under the option. */
  hint: string;
}

export const FEEDBACK_TAGS: readonly FeedbackTag[] = [
  {
    category: "suggestion",
    label: "Suggestion",
    emoji: "💡",
    hint: "An idea or an improvement you'd like",
  },
  {
    category: "bug",
    label: "Bug",
    emoji: "🐛",
    hint: "Something is broken or behaving wrong",
  },
  {
    category: "question",
    label: "Question",
    emoji: "❓",
    hint: "How do I…? Something you need help with",
  },
  {
    category: "other",
    label: "Other",
    emoji: "💬",
    hint: "Anything else you want to tell us",
  },
] as const;

/** Discord caps a forum thread name at 100 characters. */
export const FEEDBACK_SUMMARY_MAX = 100;
/** Leave room under Discord's 2,000-character message cap for server footers. */
// Leave enough room for the server-owned footer, optional contact, and the
// Activity's verified sender stamp without silently truncating report details.
export const FEEDBACK_DETAILS_MAX = 1600;
export const FEEDBACK_CONTACT_MAX = 100;

export interface FeedbackInput {
  tag: FeedbackTag;
  summary: string;
  details: string;
  /** Optional Discord handle so the team can reach back. */
  contact?: string;
}

export type FeedbackResult = { ok: true } | { ok: false; error: string };

/** Trim to a max length; the server independently validates the same bounds. */
function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Post one feedback report through the proxy. The Activity endpoint keeps its
 * bearer-authenticated sender stamp; the web endpoint is anonymous and guarded
 * by a strict per-IP budget on the server.
 */
export async function submitFeedback(
  input: FeedbackInput,
  signal?: AbortSignal,
): Promise<FeedbackResult> {
  if (!isFeedbackConfigured() && !(await ensureFeedbackAvailability())) {
    return { ok: false, error: "Feedback isn’t available in this build." };
  }

  const summary = clamp(input.summary.trim(), FEEDBACK_SUMMARY_MAX);
  const details = clamp(input.details.trim(), FEEDBACK_DETAILS_MAX);
  const contact = clamp(input.contact?.trim() ?? "", FEEDBACK_CONTACT_MAX);
  if (!summary) return { ok: false, error: "Add a short summary." };
  if (!details) return { ok: false, error: "Add a few details so we can act on it." };

  const path = isActivityMode() ? "/api/activity/feedback" : "/api/feedback";
  let res: Response;
  try {
    res = await proxyFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: input.tag.category,
        summary,
        details,
        ...(contact ? { contact } : {}),
      }),
      signal,
    });
  } catch (error) {
    if ((error as DOMException)?.name === "AbortError") {
      return { ok: false, error: "Cancelled." };
    }
    return {
      ok: false,
      error: "Network request failed. Check your connection and try again.",
    };
  }

  if (res.ok) return { ok: true };

  const text = await res.text().catch(() => "");
  let error = `Couldn’t send feedback (${res.status}). Please try again.`;
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) error = body.error;
    } catch {
      /* keep the default message */
    }
  }
  return { ok: false, error };
}
