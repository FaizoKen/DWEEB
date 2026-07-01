/**
 * Quick-feedback submission.
 *
 * Posts a suggestion / bug report / question straight to DWEEB's feedback
 * FORUM channel from the browser, via a fixed incoming webhook. A forum webhook
 * needs a `thread_name` (posting one opens a new forum thread) and accepts
 * `applied_tags` — the forum's own tag snowflakes — so each report lands
 * pre-sorted under the right tag.
 *
 * On the web the request goes straight to discord.com — no DWEEB backend in the
 * loop. The webhook URL is injected at build time (`VITE_FEEDBACK_WEBHOOK_URL`);
 * it's a public, write-only credential that can only create posts in the one
 * feedback channel, never read anything. When it's unset the feature stays dormant
 * (`isFeedbackConfigured()` is false and every entry point hides), so a build
 * without it behaves exactly as before.
 *
 * Inside a Discord Activity that direct post is impossible — the sandboxed iframe
 * can't reach discord.com (the same CSP wall that makes publishing go through the
 * proxy). There we relay the exact same payload through `POST /api/activity/feedback`,
 * which forwards it to the webhook the proxy holds server-side. So the operator
 * sets `VITE_FEEDBACK_WEBHOOK_URL` (web + the entry-point gate) *and* the backend's
 * `FEEDBACK_WEBHOOK_URL` (the Activity relay's destination) together.
 */

import { isActivityMode } from "@/core/activity/runtime";
import { proxyFetch } from "@/core/net/proxyFetch";

/** Where the team and community follow up — shown to the user after they send,
 *  so they know where a reply will come from. */
export const SUPPORT_INVITE_URL = "https://discord.gg/2wB7rHRDg2";

/** Feedback forum webhook, injected at build time. Empty → feature dormant. */
const FEEDBACK_WEBHOOK_URL: string = (import.meta.env.VITE_FEEDBACK_WEBHOOK_URL ?? "").trim();

/** True when a feedback webhook is configured — the feature is usable. */
export function isFeedbackConfigured(): boolean {
  return FEEDBACK_WEBHOOK_URL.length > 0;
}

/** A category the user picks; doubles as the forum tag applied to the post. */
export interface FeedbackTag {
  /**
   * The forum channel's tag snowflake. Leave it "" until the real ids are wired
   * in — an empty id is simply omitted from `applied_tags`, so posting still
   * works (just untagged) before the ids exist.
   */
  id: string;
  label: string;
  /** Leading emoji — shown in the picker and prefixed to the forum thread title. */
  emoji: string;
  /** One-line description under the option. */
  hint: string;
}

/**
 * The categories offered, in display order. Each `id` is the matching forum tag
 * snowflake on the feedback channel, so a report lands pre-sorted under its tag.
 */
export const FEEDBACK_TAGS: readonly FeedbackTag[] = [
  {
    id: "1518246042993430598",
    label: "Suggestion",
    emoji: "💡",
    hint: "An idea or an improvement you'd like",
  },
  {
    id: "1518251471471382528",
    label: "Bug",
    emoji: "🐛",
    hint: "Something is broken or behaving wrong",
  },
  {
    id: "1518251562978382025",
    label: "Question",
    emoji: "❓",
    hint: "How do I…? Something you need help with",
  },
  {
    id: "1518251625863577650",
    label: "Other",
    emoji: "💬",
    hint: "Anything else you want to tell us",
  },
] as const;

/** Discord caps a forum `thread_name` at 100 characters. */
export const FEEDBACK_SUMMARY_MAX = 100;
/** Webhook message body cap (non-Nitro). We keep headroom for the footer. */
export const FEEDBACK_DETAILS_MAX = 1800;

export interface FeedbackInput {
  tag: FeedbackTag;
  /** Short title → the forum thread name. */
  summary: string;
  /** The body of the report → the post's message content. */
  details: string;
  /** Optional Discord handle so the team can reach back. */
  contact?: string;
}

export type FeedbackResult = { ok: true } | { ok: false; error: string };

/** Trim to a max length without cutting mid-line awkwardly past the cap. */
function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Post one feedback report to the forum channel. Resolves `{ ok: true }` on a
 * created thread, or a user-facing `error` for validation/network/Discord
 * failures. Pass an `AbortSignal` to cancel an in-flight submit.
 */
export async function submitFeedback(
  input: FeedbackInput,
  signal?: AbortSignal,
): Promise<FeedbackResult> {
  if (!isFeedbackConfigured()) {
    return { ok: false, error: "Feedback isn’t available in this build." };
  }

  const summary = clamp(input.summary.trim(), FEEDBACK_SUMMARY_MAX);
  const details = clamp(input.details.trim(), FEEDBACK_DETAILS_MAX);
  const contact = input.contact?.trim();
  if (!summary) return { ok: false, error: "Add a short summary." };
  if (!details) return { ok: false, error: "Add a few details so we can act on it." };

  // A subtext footer (`-#`) keeps the triage metadata quiet under the report.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const footer = [
    `-# ${input.tag.emoji} ${input.tag.label} · sent from DWEEB`,
    contact ? `-# 📨 Contact: ${contact}` : null,
    origin ? `-# 🔗 ${origin}` : null,
    ua ? `-# 🖥️ ${clamp(ua, 220)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Final safety cap — `content` must stay under Discord's 2000-char limit even
  // if a long UA pushes the footer out.
  const content = clamp(`${details}\n\n${footer}`, 2000);

  const payload: Record<string, unknown> = {
    // Forum webhooks require a thread_name; it becomes the post's title.
    thread_name: clamp(`${input.tag.emoji} ${summary}`, FEEDBACK_SUMMARY_MAX),
    content,
    // Feedback should never ping anyone, even if the body contains a mention.
    allowed_mentions: { parse: [] },
  };
  // Only attach a tag once its real id is wired in — an empty id 400s.
  if (input.tag.id) payload.applied_tags = [input.tag.id];

  // Inside a Discord Activity the sandboxed iframe can't POST to discord.com, so
  // relay the same report through the proxy (which holds the webhook). Everywhere
  // else, post to the webhook directly (below).
  if (isActivityMode()) return submitViaProxy(payload, signal);

  let res: Response;
  try {
    // `wait=true` makes Discord confirm the thread was created (and surface a
    // structured error) instead of a fire-and-forget 204.
    res = await fetch(`${FEEDBACK_WEBHOOK_URL}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return { ok: false, error: "Cancelled." };
    return {
      ok: false,
      error: "Network request failed. Check your connection and try again.",
    };
  }

  if (res.ok) return { ok: true };

  // Surface Discord's own message when it sent one; otherwise the bare status.
  const text = await res.text().catch(() => "");
  let error = `Couldn’t send feedback (Discord returned ${res.status}). Please try again.`;
  if (text) {
    try {
      const body = JSON.parse(text) as { message?: unknown };
      if (typeof body.message === "string" && body.message.length > 0) {
        error = `Couldn’t send feedback — Discord (${res.status}): ${body.message}`;
      }
    } catch {
      /* keep the default message */
    }
  }
  return { ok: false, error };
}

/**
 * Activity transport: relay the built forum payload through the proxy's
 * `POST /api/activity/feedback`, which forwards it to the webhook it holds
 * server-side (the sandboxed iframe can't reach discord.com). We send only the
 * fields the proxy uses — it re-imposes `allowed_mentions` and stamps the
 * verified sender itself — and read back its `{ error }` body on failure.
 */
async function submitViaProxy(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<FeedbackResult> {
  let res: Response;
  try {
    res = await proxyFetch("/api/activity/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread_name: payload.thread_name,
        content: payload.content,
        applied_tags: payload.applied_tags ?? [],
      }),
      signal,
    });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return { ok: false, error: "Cancelled." };
    return {
      ok: false,
      error: "Network request failed. Check your connection and try again.",
    };
  }

  // The proxy answers 204 on a created post.
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
