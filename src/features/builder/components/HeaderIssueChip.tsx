/**
 * The single validation indicator for the editor — a compact pill that floats at
 * the top-right of the builder pane, just under the action bar. It's docked there
 * by `ComponentTree` (shared by the web app and the embedded Activity), so the
 * affordance looks and behaves identically in both, and the editor rows stay
 * clean: per-component detail still lives on the tree rows (the issue dot) and in
 * each inspector.
 *
 * It collapses the whole message's error + warning count into one pill, tinted by
 * the worst severity present. Clicking it jumps to the first offending component
 * — selecting the node, scrolling its tree row into view, and scrolling the
 * rendered preview to it — the same two-sided jump the old header pills did. A
 * message-level problem with no owning node (a missing forum post title, bad
 * mentions, …) jumps to the meta header instead: the card scrolls into view and,
 * when the issue lives in a Message-options lane, that lane expands with its
 * field focused (see `optionsReveal.ts`) — so the chip is clickable for every
 * kind of issue, not just component ones.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { scrollPreviewNodeIntoView, scrollTreeRowIntoView } from "@/features/builder/scrollTreeRow";
import { sectionForIssueCode, useOptionsRevealStore } from "@/features/builder/optionsReveal";
import type { ValidationView } from "@/features/builder/useValidation";
import { AlertCircleIcon, AlertTriangleIcon } from "@/ui/Icon";
import { cn } from "@/lib/cn";
import styles from "./HeaderIssueChip.module.css";

export function HeaderIssueChip({ view }: { view: ValidationView }) {
  const select = useMessageStore((s) => s.select);
  const reveal = useOptionsRevealStore((s) => s.reveal);
  const { errorCount, warningCount, firstErrorNodeId, firstWarningNodeId, messageIssues } = view;
  const total = errorCount + warningCount;
  if (total === 0) return null;

  // Errors dominate the tint and the jump target; only when there are none does
  // a warning-only message colour the chip amber and point at the first warning.
  const isError = errorCount > 0;
  const targetId = isError ? firstErrorNodeId : firstWarningNodeId;
  // With no component to land on, fall back to the first message-level issue of
  // the dominant severity — its home is the meta header / Message options card.
  const messageTarget = targetId
    ? null
    : messageIssues.find((i) => (isError ? i.severity === "error" : i.severity === "warning"));
  const label = `${total} ${total === 1 ? "issue" : "issues"}`;

  const jump = () => {
    if (targetId) {
      select(targetId);
      scrollTreeRowIntoView(targetId);
      scrollPreviewNodeIntoView(targetId);
    } else if (messageTarget) {
      reveal(sectionForIssueCode(messageTarget.code));
    }
  };

  return (
    <button
      type="button"
      className={cn(styles.chip, isError ? styles.chipError : styles.chipWarn)}
      onClick={jump}
      disabled={!targetId && !messageTarget}
      aria-label={`${label} to fix — jump to the first one`}
      title={
        targetId
          ? "Jump to the first component that needs fixing"
          : messageTarget
            ? "Jump to the message setting that needs fixing"
            : "This message has a problem to fix before sending"
      }
    >
      {isError ? <AlertCircleIcon size={12} /> : <AlertTriangleIcon size={12} />}
      {label}
    </button>
  );
}
