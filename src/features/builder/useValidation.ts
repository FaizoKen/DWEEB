/**
 * Live validation wiring for the editor.
 *
 * `validateMessage` already knows *what* is wrong and *which* node owns each
 * issue (via `issue.nodeId`). This module turns that flat issue list into a
 * shape the tree can consume cheaply:
 *
 *  - it's computed once (memoized on the message) at the top of the tree and
 *    shared down through {@link ValidationContext}, so a 40-row tree doesn't
 *    re-run validation 40 times;
 *  - issues are grouped by node id so a row can ask "do I have problems?" with
 *    a single map lookup, and message-level issues (empty message, bad
 *    allowed_mentions, …) are split out for the meta header to show.
 *
 * The two `firstError`/`firstWarning` ids drive the header's jump-to-issue
 * affordance. They're populated in document order because `validateMessage`
 * walks the tree top-to-bottom.
 */

import { createContext, useContext, useMemo } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { validateMessage, type ValidationIssue } from "@/core/schema/validation";
import type { EditorId, WebhookMessage } from "@/core/schema/types";

export interface ValidationView {
  /** Issues keyed by the editor id of the offending node. */
  byNode: Map<EditorId, ValidationIssue[]>;
  /** Issues with no owning node (message-wide: empty message, mentions, …). */
  messageIssues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  /** First node (document order) carrying an error — for jump-to-issue. */
  firstErrorNodeId: EditorId | null;
  /** First node carrying a warning — used when there are no errors to jump to. */
  firstWarningNodeId: EditorId | null;
}

/** Stable empty list so `useNodeIssues` never hands back a fresh array. */
const NO_ISSUES: ValidationIssue[] = [];

const EMPTY_VIEW: ValidationView = {
  byNode: new Map(),
  messageIssues: NO_ISSUES,
  errorCount: 0,
  warningCount: 0,
  firstErrorNodeId: null,
  firstWarningNodeId: null,
};

/** Pure transform — exported so it can be unit-tested without React. */
export function buildValidationView(message: WebhookMessage): ValidationView {
  const { issues } = validateMessage(message);
  const byNode = new Map<EditorId, ValidationIssue[]>();
  const messageIssues: ValidationIssue[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let firstErrorNodeId: EditorId | null = null;
  let firstWarningNodeId: EditorId | null = null;

  for (const issue of issues) {
    if (issue.severity === "error") errorCount++;
    else warningCount++;

    if (issue.nodeId === undefined) {
      messageIssues.push(issue);
      continue;
    }

    const existing = byNode.get(issue.nodeId);
    if (existing) existing.push(issue);
    else byNode.set(issue.nodeId, [issue]);

    if (issue.severity === "error" && firstErrorNodeId === null) firstErrorNodeId = issue.nodeId;
    if (issue.severity === "warning" && firstWarningNodeId === null)
      firstWarningNodeId = issue.nodeId;
  }

  return {
    byNode,
    messageIssues,
    errorCount,
    warningCount,
    firstErrorNodeId,
    firstWarningNodeId,
  };
}

/** Recompute the live validation view from the current message (memoized). */
export function useValidationView(): ValidationView {
  const message = useMessageStore((s) => s.message);
  return useMemo(() => buildValidationView(message), [message]);
}

/**
 * Shared down the tree so every row reads the same precomputed view. The
 * provider lives in `ComponentTree`; consumers are the rows, the inspectors,
 * and the meta header.
 */
export const ValidationContext = createContext<ValidationView>(EMPTY_VIEW);

/** Issues attached to one node, read from the nearest provider. */
export function useNodeIssues(id: EditorId): ValidationIssue[] {
  return useContext(ValidationContext).byNode.get(id) ?? NO_ISSUES;
}

/** The whole validation view, read from the nearest provider. */
export function useValidationSummary(): ValidationView {
  return useContext(ValidationContext);
}

/** "error" if any issue is an error, "warning" if only warnings, else null. */
export function worstSeverity(issues: ValidationIssue[]): "error" | "warning" | null {
  if (issues.length === 0) return null;
  return issues.some((i) => i.severity === "error") ? "error" : "warning";
}
