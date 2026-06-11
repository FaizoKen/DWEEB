/**
 * Read-only "interactive components" status in the post-send success dialog.
 *
 * Plugin buttons/selects stop working a set number of days after the message
 * is sent unless the message holds one of the server's permanent slots. The
 * *decision* happens before the send — the confirm dialog owns the "Make
 * permanent" toggle and the inline slot freeing — so this section is purely a
 * receipt: it states the outcome the Send panel already knows, without
 * re-fetching or offering to change anything. Changing your mind = update the
 * message, which re-opens the confirm with the toggle.
 *
 *  - permanent → green "never expires";
 *  - expiring  → amber concrete expiry date: send time decoded from the
 *    message snowflake plus the deployment TTL — the same arithmetic the
 *    interactions dispatcher applies server-side;
 *  - unknown   → generic expiry warning, used when the slot state never
 *    loaded; `signInHint` adds the nudge when the cause was being signed out.
 *
 * A failed pre-send claim/release arrives as `error`, shown under the row.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { CheckCircleIcon, ClockIcon } from "@/ui/Icon";
import styles from "./PermanentStatus.module.css";

export interface PermanentStatusProps {
  /** Final expiry state of the just-sent message. */
  status: "permanent" | "expiring" | "unknown";
  /** The message's id — anchors the concrete expiry date when expiring. */
  messageId?: string;
  /** Days components stay clickable, when expiring. */
  ttlDays?: number;
  /** Nudge to sign in before sending next time (unknown state only). */
  signInHint?: boolean;
  /** Why the pre-send claim/release failed, when it did. */
  error?: string;
}

/** One glanceable line: tinted status icon + short copy. The tint alone
 *  signals state (amber = expiring, green = permanent). */
function Row({
  tone,
  icon,
  children,
}: {
  tone: "warning" | "success";
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <span className={cn(styles.badge, styles[tone])}>{icon}</span>
      <div className={styles.copy}>{children}</div>
    </div>
  );
}

/** First millisecond of 2015 — the epoch Discord snowflakes count from. */
const DISCORD_EPOCH_MS = 1420070400000n;

/** When a message was sent, decoded from its snowflake id. Editing a message
 *  doesn't change its id, so this (plus the TTL) is the true expiry anchor. */
function messageSentAt(messageId: string): Date | null {
  if (!/^\d{15,25}$/.test(messageId)) return null;
  return new Date(Number((BigInt(messageId) >> 22n) + DISCORD_EPOCH_MS));
}

export function PermanentStatusSection({
  status,
  messageId,
  ttlDays,
  signInHint,
  error,
}: PermanentStatusProps) {
  let row: ReactNode;
  if (status === "permanent") {
    row = (
      <Row tone="success" icon={<CheckCircleIcon size={15} />}>
        <p className={styles.title}>This message is permanent</p>
        <p className={styles.sub}>Buttons &amp; selects never expire</p>
      </Row>
    );
  } else if (status === "expiring") {
    const sentAt = messageId ? messageSentAt(messageId) : null;
    const expiresAt =
      sentAt && ttlDays != null ? new Date(sentAt.getTime() + ttlDays * 86_400_000) : null;
    const alreadyExpired = expiresAt !== null && expiresAt.getTime() <= Date.now();
    const expiryLabel = expiresAt?.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    row = (
      <Row tone="warning" icon={<ClockIcon size={15} />}>
        <p className={styles.title}>
          {expiryLabel ? (
            alreadyExpired ? (
              <>
                Buttons &amp; selects <strong>expired {expiryLabel}</strong>
              </>
            ) : (
              <>
                Buttons &amp; selects expire <strong>{expiryLabel}</strong>
              </>
            )
          ) : (
            <>
              Buttons &amp; selects expire <strong>{ttlDays} days</strong> after sending
            </>
          )}
        </p>
        <p className={styles.sub}>Update this message to make it permanent</p>
      </Row>
    );
  } else {
    row = (
      <Row tone="warning" icon={<ClockIcon size={15} />}>
        <p className={styles.title}>Buttons &amp; selects expire a few days after sending</p>
        {signInHint ? (
          <p className={styles.sub}>Sign in before sending to make a message permanent</p>
        ) : null}
      </Row>
    );
  }

  return (
    <section className={styles.section} aria-label="Interactive components">
      {row}
      {error ? <p className={styles.textError}>{error}</p> : null}
    </section>
  );
}
