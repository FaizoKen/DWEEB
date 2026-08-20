/**
 * The post-send rating prompt.
 *
 * Appears once, after a message has actually posted, and asks for one tap. The
 * score feeds the `aggregateRating` the generated landing page publishes — the
 * only kind of review that changes DWEEB's own search result, since every
 * third-party review site marks its outbound links nofollow.
 *
 * The Top.gg link is shown only *after* a score is recorded, never as a
 * condition of it. Rating is not gated on the answer and the answer is not
 * routed on its value: the site publishes this average, so steering unhappy
 * raters somewhere else would corrupt the number at its source. What the score
 * does change is the follow-up sentence, because inviting someone who just
 * rated the product two stars to go recommend it publicly would be absurd —
 * they are pointed at the feedback form instead, which is where a complaint
 * can actually reach the maintainer.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "@/ui/Icon";
import { useRatingStore } from "@/core/rating/ratingStore";
import { MAX_SCORE, MIN_SCORE } from "@/core/rating/ratingApi";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import styles from "./RatingPrompt.module.css";

const TOPGG_REVIEW_URL = "https://top.gg/bot/1511769679096447016#reviews";

/** Scores that get the "tell other people" follow-up. */
const RECOMMEND_THRESHOLD = 4;

const SCORES = Array.from(
  { length: MAX_SCORE - MIN_SCORE + 1 },
  (_, i) => MAX_SCORE - i,
) as number[];

export function RatingPrompt() {
  const phase = useRatingStore((s) => s.phase);
  const score = useRatingStore((s) => s.score);
  const busy = useRatingStore((s) => s.busy);
  const choose = useRatingStore((s) => s.choose);
  const dismiss = useRatingStore((s) => s.dismiss);
  const openFeedback = useFeedbackStore((s) => s.openFeedback);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The thank-you closes itself. It carries an optional link, so it lingers
  // well past a toast's lifetime — but it is not a decision anyone owes us an
  // answer to, and leaving it pinned over the editor would be its own nag.
  useEffect(() => {
    if (phase !== "thanks") return;
    closeTimer.current = setTimeout(() => dismiss(true), 9000);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = null;
    };
  }, [phase, dismiss]);

  if (phase === "idle" || typeof document === "undefined") return null;

  const recommend = score !== null && score >= RECOMMEND_THRESHOLD;

  return createPortal(
    <div
      className={styles.card}
      role="dialog"
      aria-live="polite"
      aria-label="Rate your experience with DWEEB"
    >
      <div className={styles.head}>
        <p className={styles.title}>
          {phase === "thanks" ? "Thanks — that's recorded." : "How was that?"}
        </p>
        <button
          type="button"
          className={styles.close}
          onClick={() => dismiss(true)}
          aria-label="Dismiss"
        >
          <CloseIcon size={14} />
        </button>
      </div>

      {phase === "asking" ? (
        <>
          <p className={styles.sub}>
            Rate DWEEB out of {MAX_SCORE}. One tap, and it shows on the site as a public score.
          </p>
          {/* Rendered high→low so the CSS sibling selector can light every star
              up to the hovered one; the accessible names still read 1…5. */}
          <div className={styles.stars} data-busy={busy ? "true" : "false"}>
            {SCORES.map((value) => (
              <button
                key={value}
                type="button"
                className={styles.star}
                disabled={busy}
                onClick={() => void choose(value)}
                aria-label={`${value} out of ${MAX_SCORE}`}
              >
                <span aria-hidden="true">★</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className={styles.thanks}>
            {recommend
              ? "Glad it worked for you."
              : score !== null
                ? "Noted — thanks for being honest."
                : "Thanks for rating."}
          </p>
          {recommend ? (
            <p className={styles.thanksNote}>
              If you have another minute,{" "}
              <a
                className={styles.link}
                href={TOPGG_REVIEW_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                leave a review on Top.gg ↗
              </a>{" "}
              — that's where people find DWEEB from inside Discord.
            </p>
          ) : (
            <p className={styles.thanksNote}>
              If something specific was wrong,{" "}
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  dismiss(true);
                  openFeedback();
                }}
              >
                tell me what
              </button>{" "}
              — it goes straight to the maintainer.
            </p>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
