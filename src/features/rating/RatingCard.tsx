/**
 * The post-send rating prompt's card, loaded on demand by `RatingPrompt`.
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
 *
 * It is a non-modal side panel, not a dialog: it never takes focus or blocks
 * the editor, it is announced politely, and it goes away on its own. Unanswered,
 * the question leaves after {@link ASK_MS} — without counting as an answer, so
 * a later visit may still ask (the store's once-per-tab guard stops it coming
 * back here). Only the ✕, labelled for what it does, says "don't ask again".
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "@/ui/Icon";
import { startPausableTimer, type PausableTimer } from "@/ui/pausableTimer";
import { useRatingStore } from "@/core/rating/ratingStore";
import { MAX_SCORE, MIN_SCORE } from "@/core/rating/ratingApi";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import styles from "./RatingPrompt.module.css";

const TOPGG_REVIEW_URL = "https://top.gg/bot/1511769679096447016#reviews";

/** Scores that get the "tell other people" follow-up. */
const RECOMMEND_THRESHOLD = 4;

/** How long the question waits for an answer before quietly leaving. */
const ASK_MS = 20_000;
/**
 * The thank-you closes itself too. It carries an optional link, so it lingers
 * well past a toast's lifetime — but it is not a decision anyone owes us an
 * answer to, and leaving it pinned over the editor would be its own nag.
 */
const THANKS_MS = 9000;
/** Time left, at least, once the pointer or focus moves off the card. */
const RESUME_FLOOR_MS = 2000;

const SCORES = Array.from(
  { length: MAX_SCORE - MIN_SCORE + 1 },
  (_, i) => MAX_SCORE - i,
) as number[];

const QUESTION = "How was that?";
const QUESTION_SUB = `Rate DWEEB out of ${MAX_SCORE}. One tap, and it shows on the site as a public score.`;
const THANKS = "Thanks — that's recorded.";

function thanksLine(score: number | null): string {
  if (score !== null && score >= RECOMMEND_THRESHOLD) return "Glad it worked for you.";
  return score !== null ? "Noted — thanks for being honest." : "Thanks for rating.";
}

type Hold = "hover" | "focus" | "hidden";

export function RatingCard() {
  const phase = useRatingStore((s) => s.phase);
  const score = useRatingStore((s) => s.score);
  const busy = useRatingStore((s) => s.busy);
  const choose = useRatingStore((s) => s.choose);
  const dismiss = useRatingStore((s) => s.dismiss);
  const openFeedback = useFeedbackStore((s) => s.openFeedback);
  const cardRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<PausableTimer | null>(null);
  // Pointer on the card, focus in it, or a hidden tab: while any holds, the
  // card is being read (or can't be), so its clock stops.
  const holds = useRef(new Set<Hold>());
  // Filled a couple of frames after the card mounts: a live region that
  // arrives already holding its text is often not announced at all.
  const [spoken, setSpoken] = useState("");

  const hold = (reason: Hold, on: boolean) => {
    if (on) holds.current.add(reason);
    else holds.current.delete(reason);
    if (holds.current.size > 0) timerRef.current?.pause();
    else timerRef.current?.resume(RESUME_FLOOR_MS);
  };

  useEffect(() => {
    if (phase === "idle") {
      setSpoken("");
      holds.current.clear();
      return;
    }
    const asking = phase === "asking";
    // A chosen star leaves with the question, taking focus with it — and no
    // blur says so.
    if (!cardRef.current?.contains(document.activeElement)) holds.current.delete("focus");
    if (document.hidden) holds.current.add("hidden");
    else holds.current.delete("hidden");
    // Each phase leaves on its own: the question without counting as an answer
    // (a later visit may ask again), the thank-you once it has been read.
    const timer = startPausableTimer(
      asking ? ASK_MS : THANKS_MS,
      () => dismiss(!asking),
      holds.current.size > 0,
    );
    timerRef.current = timer;
    const onVisibility = () => hold("hidden", document.hidden);
    // Escape dismisses it too — softly, since an Escape meant for something
    // else must not turn into "never ask again". Whatever already claimed the
    // key (a menu, an open dialog, the directory) keeps it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!document.querySelector("[aria-modal='true']")) dismiss(!asking);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKey);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() =>
        setSpoken(asking ? `${QUESTION} ${QUESTION_SUB}` : `${THANKS} ${thanksLine(score)}`),
      );
    });
    return () => {
      timer.cancel();
      timerRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [phase, score, dismiss]);

  if (phase === "idle" || typeof document === "undefined") return null;

  const recommend = score !== null && score >= RECOMMEND_THRESHOLD;
  const closeLabel = phase === "asking" ? "Don't ask again" : "Close";

  return createPortal(
    <aside
      ref={cardRef}
      className={styles.card}
      aria-label="Rate your experience with DWEEB"
      onPointerEnter={() => hold("hover", true)}
      onPointerLeave={() => hold("hover", false)}
      onFocus={() => hold("focus", true)}
      onBlur={(e) => {
        if (!cardRef.current?.contains(e.relatedTarget as Node | null)) hold("focus", false);
      }}
    >
      {/* The live copy of the visible text, which is hidden from assistive tech
          below so it isn't read twice. */}
      <p className="sr-only" role="status">
        {spoken}
      </p>
      <div className={styles.head}>
        <p className={styles.title} aria-hidden="true">
          {phase === "thanks" ? THANKS : QUESTION}
        </p>
        <button
          type="button"
          className={styles.close}
          onClick={() => dismiss(true)}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <CloseIcon size={16} />
        </button>
      </div>

      {phase === "asking" ? (
        <>
          <p className={styles.sub} aria-hidden="true">
            {QUESTION_SUB}
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
          <p className={styles.thanks} aria-hidden="true">
            {thanksLine(score)}
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
    </aside>,
    document.body,
  );
}
