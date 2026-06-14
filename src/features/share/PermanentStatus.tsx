/**
 * Read-only "interactive components" status in the post-send success dialog,
 * rendered as the value of the "Interaction" row in the destination facts
 * list — same section as Webhook / Server / Channel.
 *
 * Plugin buttons/selects stop working a set number of days after the message
 * is sent unless the message holds one of the server's permanent slots. The
 * *decision* happens before the send — the confirm dialog owns the "Make
 * permanent" toggle and the inline slot freeing — so this row is purely a
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
import { messageSentAt } from "@/lib/snowflake";
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
function Line({
  tone,
  icon,
  children,
}: {
  tone: "warning" | "success";
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <p className={styles.line}>
      <span className={cn(styles.icon, styles[tone])} aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
    </p>
  );
}

export function PermanentStatusValue({
  status,
  messageId,
  ttlDays,
  signInHint,
  error,
}: PermanentStatusProps) {
  let line: ReactNode;
  let sub: ReactNode = null;
  if (status === "permanent") {
    line = (
      <Line tone="success" icon={<CheckCircleIcon size={14} />}>
        Never expires
      </Line>
    );
    sub = <p className={styles.sub}>Buttons &amp; selects stay clickable</p>;
  } else if (status === "expiring") {
    const sentAt = messageId ? messageSentAt(messageId) : null;
    const expiresAt =
      sentAt && ttlDays != null ? new Date(sentAt.getTime() + ttlDays * 86_400_000) : null;
    const alreadyExpired = expiresAt !== null && expiresAt.getTime() <= Date.now();
    const expiryLabel = expiresAt?.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    line = (
      <Line tone="warning" icon={<ClockIcon size={14} />}>
        {expiryLabel ? (
          alreadyExpired ? (
            <>
              Expired on <strong>{expiryLabel}</strong>
            </>
          ) : (
            <>
              Expires on <strong>{expiryLabel}</strong>
            </>
          )
        ) : (
          <>
            Expires <strong>{ttlDays} days</strong> after sending
          </>
        )}
      </Line>
    );
    sub = <p className={styles.sub}>Update this message to make it never expire</p>;
  } else {
    line = (
      <Line tone="warning" icon={<ClockIcon size={14} />}>
        Expires a few days after sending
      </Line>
    );
    if (signInHint) {
      sub = <p className={styles.sub}>Sign in before sending to make a message never expire</p>;
    }
  }

  return (
    <div className={styles.value}>
      {line}
      {sub}
      {error ? <p className={styles.textError}>{error}</p> : null}
    </div>
  );
}
