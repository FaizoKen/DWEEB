/**
 * Quick-feedback dialog.
 *
 * A small form that posts a suggestion / bug / question to DWEEB's feedback
 * forum channel (see `core/feedback/submit`), then swaps to a thank-you view
 * that points the user at the support server — so they know where the dev and
 * community will reply.
 *
 * Self-contained: it reads its own open/close state from `feedbackStore`, so
 * any entry point just calls `openFeedback()`. `App` mounts it lazily only
 * while open.
 */

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Select } from "@/ui/Select";
import { TextInput } from "@/ui/TextInput";
import { TextArea } from "@/ui/TextArea";
import { CheckCircleIcon, SparkleIcon, SupportIcon } from "@/ui/Icon";
import { isActivityMode } from "@/core/activity/runtime";
import {
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_DETAILS_MAX,
  FEEDBACK_SUMMARY_MAX,
  FEEDBACK_TAGS,
  SUPPORT_INVITE_URL,
  submitFeedback,
} from "@/core/feedback/submit";
import { useFeedbackStore } from "./feedbackStore";
import styles from "./FeedbackDialog.module.css";

const TOPGG_REVIEW_URL = "https://top.gg/bot/1511769679096447016#reviews";

export function FeedbackDialog() {
  const activityMode = isActivityMode();
  const close = useFeedbackStore((s) => s.closeFeedback);

  const [tagIndex, setTagIndex] = useState(0);
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const tag = FEEDBACK_TAGS[tagIndex] ?? FEEDBACK_TAGS[0]!;
  const canSend = summary.trim().length > 0 && details.trim().length > 0 && !busy;

  const handleSend = async () => {
    if (!canSend) return;
    setError(null);
    setBusy(true);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const result = await submitFeedback(
      { tag, summary, details, contact: contact.trim() || undefined },
      ac.signal,
    );
    setBusy(false);
    if (!result.ok) {
      if (result.error === "Cancelled.") return;
      setError(result.error);
      return;
    }
    setSent(true);
  };

  if (sent) {
    return (
      <Modal
        open
        onClose={close}
        size="sm"
        title="Thanks for the feedback"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Done
            </Button>
            <Button
              variant="primary"
              leadingIcon={<SupportIcon />}
              onClick={() => {
                window.open(SUPPORT_INVITE_URL, "_blank", "noopener,noreferrer");
                close();
              }}
            >
              Join the support server ↗
            </Button>
          </>
        }
      >
        <div className={styles.banner} role="status">
          <span className={styles.check} aria-hidden="true">
            <CheckCircleIcon size={20} />
          </span>
          <p className={styles.bannerText}>
            Sent it through — thank you! It’s now a post in our feedback forum.
          </p>
        </div>
        <p className={styles.lead}>
          The dev and the community follow up in the{" "}
          <a href={SUPPORT_INVITE_URL} target="_blank" rel="noopener noreferrer">
            support server
          </a>{" "}
          — join to track replies on your report
          {contact.trim() || activityMode ? "" : " (we have no way to reach you otherwise)"}.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={close}
      title="Send feedback"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSend} disabled={!canSend}>
            {busy ? "Sending…" : "Send feedback"}
          </Button>
        </>
      }
    >
      <p className={styles.lead}>
        Spotted a bug or have an idea? Send it straight to our feedback forum — no account needed.
      </p>
      <p className={styles.disclosure} role="note">
        Your report and optional contact are visible to members of that forum. Don’t include webhook
        URLs, API keys, or other secrets.
        {activityMode
          ? " Because you are using the Discord Activity, the report also includes your verified Discord display name and user ID."
          : ""}
      </p>

      <Field label="Type">
        {(id) => (
          <Select
            id={id}
            value={tagIndex}
            onChange={(e) => setTagIndex(Number(e.currentTarget.value))}
          >
            {FEEDBACK_TAGS.map((t, i) => (
              <option key={t.label} value={i}>
                {t.emoji} {t.label} — {t.hint}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field
        label="Summary"
        hint="A short title for your report — this becomes the forum post’s name."
      >
        {(id) => (
          <TextInput
            id={id}
            value={summary}
            maxLength={FEEDBACK_SUMMARY_MAX}
            onChange={(e) => setSummary(e.currentTarget.value)}
            placeholder={
              tag.label === "Bug"
                ? "e.g. Preview clips long embeds on mobile"
                : "e.g. Add a dark-mode toggle"
            }
          />
        )}
      </Field>

      <Field
        label="Details"
        hint={`${details.length}/${FEEDBACK_DETAILS_MAX} — what happened, what you expected, steps to reproduce.`}
      >
        {(id) => (
          <TextArea
            id={id}
            rows={6}
            value={details}
            maxLength={FEEDBACK_DETAILS_MAX}
            onChange={(e) => setDetails(e.currentTarget.value)}
            placeholder="The more specific, the faster we can act on it."
          />
        )}
      </Field>

      <Field
        label="Your Discord (optional)"
        hint={
          activityMode
            ? "Optional extra contact detail; Activity reports already include your verified Discord identity."
            : "So we can @ you with a reply. Otherwise, watch the support server."
        }
      >
        {(id) => (
          <TextInput
            id={id}
            value={contact}
            maxLength={FEEDBACK_CONTACT_MAX}
            onChange={(e) => setContact(e.currentTarget.value)}
            placeholder="username or username#0000"
            spellCheck={false}
          />
        )}
      </Field>

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.review}>
        <span className={styles.reviewIcon} aria-hidden="true">
          <SparkleIcon size={18} />
        </span>
        <p className={styles.reviewText}>
          If you’re enjoying DWEEB, please consider leaving a review on{" "}
          <a href={TOPGG_REVIEW_URL} target="_blank" rel="noopener noreferrer">
            Top.gg ↗
          </a>
          !
        </p>
      </div>
    </Modal>
  );
}
