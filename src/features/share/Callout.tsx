/**
 * Compact, low-noise callout shared across the Share-dialog panels.
 *
 * Replaces the old full-fill colored boxes (loud yellow/blue/red blocks of
 * prose) with a slim accent rail + subtle tint, an icon, a one-line headline,
 * and an optional `<details>` disclosure for the longer explanation — so the
 * panels stay short and calm by default while keeping every word a click away.
 */

import { type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { AlertCircleIcon, AlertTriangleIcon, InfoIcon } from "@/ui/Icon";
import styles from "./Callout.module.css";

export type CalloutTone = "info" | "warning" | "danger";

const DEFAULT_ICON: Record<CalloutTone, ReactNode> = {
  info: <InfoIcon size={15} />,
  warning: <AlertTriangleIcon size={15} />,
  danger: <AlertCircleIcon size={15} />,
};

const TONE_CLASS: Record<CalloutTone, string | undefined> = {
  info: styles.info,
  warning: styles.warning,
  danger: styles.danger,
};

export function Callout({
  tone = "info",
  icon,
  title,
  children,
  more,
  moreLabel = "Details",
  actions,
  role,
  className,
}: {
  tone?: CalloutTone;
  /** Override the default per-tone icon, or pass `null` to drop it. */
  icon?: ReactNode;
  /** Bold, always-visible headline. */
  title?: ReactNode;
  /** Always-visible body — keep it to a line or two. */
  children?: ReactNode;
  /** Longer explanation, folded behind a `<details>` disclosure. */
  more?: ReactNode;
  moreLabel?: string;
  /** Action buttons rendered under the body. */
  actions?: ReactNode;
  role?: "note" | "alert";
  className?: string;
}) {
  const resolvedIcon = icon === undefined ? DEFAULT_ICON[tone] : icon;
  return (
    <div className={cn(styles.callout, TONE_CLASS[tone], className)} role={role}>
      {resolvedIcon ? <span className={styles.icon}>{resolvedIcon}</span> : null}
      <div className={styles.content}>
        {title ? <div className={styles.title}>{title}</div> : null}
        {children ? <div className={styles.body}>{children}</div> : null}
        {more ? (
          <details className={styles.more}>
            <summary className={styles.summary}>{moreLabel}</summary>
            <div className={styles.moreBody}>{more}</div>
          </details>
        ) : null}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>
  );
}
