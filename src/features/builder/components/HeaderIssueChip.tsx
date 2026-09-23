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
 * rendered preview to it. A message-level problem with no owning node (a missing
 * forum post title, bad mentions, …) jumps to its field instead: the Message
 * options lane that hosts it expands with the field focused (see
 * `optionsReveal.ts`). The jump itself is `jumpToIssue`, shared with the Send
 * panel's "Fix before sending" rows so both land in the same place.
 */

import { chipJumpTarget, issueDestination, jumpToIssue } from "@/features/builder/jumpToIssue";
import type { ValidationView } from "@/features/builder/useValidation";
import { AlertCircleIcon, AlertTriangleIcon } from "@/ui/Icon";
import { cn } from "@/lib/cn";
import styles from "./HeaderIssueChip.module.css";

export function HeaderIssueChip({ view }: { view: ValidationView }) {
  const { errorCount, warningCount, messageIssues } = view;
  const total = errorCount + warningCount;
  if (total === 0) return null;
  // An empty message is an "error" the validator reports, but the tree's own
  // empty-state card already says "add your first component" — a red pill on
  // top of it (with nowhere to jump, since the issue owns no node) reads as
  // something broken right after the user hit Clear.
  const onlyEmptyMessage =
    view.byNode.size === 0 && messageIssues.every((i) => i.code === "EMPTY_MESSAGE");
  if (onlyEmptyMessage) return null;

  // Errors dominate the tint; the jump target prefers the dominant severity but
  // falls back to anything reachable (see `chipJumpTarget`).
  const isError = errorCount > 0;
  const target = chipJumpTarget(view);
  const destination = target ? issueDestination(target) : null;
  const label = `${total} ${total === 1 ? "issue" : "issues"}`;

  return (
    <button
      type="button"
      className={cn(styles.chip, isError ? styles.chipError : styles.chipWarn)}
      onClick={() => {
        if (target) jumpToIssue(target);
      }}
      disabled={!destination}
      aria-label={`${label} to fix — jump to the first one`}
      title={
        destination?.kind === "node"
          ? "Jump to the first component that needs fixing"
          : destination
            ? "Jump to the message setting that needs fixing"
            : "This message has a problem to fix before sending"
      }
    >
      {isError ? <AlertCircleIcon size={12} /> : <AlertTriangleIcon size={12} />}
      {label}
    </button>
  );
}
