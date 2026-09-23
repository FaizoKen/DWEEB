/**
 * Jump from a validation issue to the place in the editor that fixes it.
 *
 * One routine behind both of the editor's "go to the problem" affordances — the
 * header's issue chip and the Send panel's "Fix before sending" rows — so the
 * two always land in exactly the same spot:
 *
 *  - a **component** issue selects its node (which unfolds the row's inline
 *    editor), scrolls the tree row to the top of the pane and scrolls the
 *    rendered preview to the component;
 *  - a **message-level** issue reveals its home field instead: the
 *    Message-options lane (or the meta header's username / avatar input) that
 *    `fieldForIssueCode` maps it to, expanded and focused — and a message-wide
 *    limit with no single field brings the options card into view;
 *  - "the message is empty" goes nowhere: there is nothing to select or
 *    reveal, and the tree's own empty-state card already says what to do.
 */

import type { ValidationIssue } from "@/core/schema/validation";
import type { EditorId } from "@/core/schema/types";
import { useMessageStore } from "@/core/state/messageStore";
import { scrollPreviewNodeIntoView, scrollTreeRowIntoView } from "./scrollTreeRow";
import { fieldForIssueCode, useOptionsRevealStore, type MessageIssueField } from "./optionsReveal";
import type { ValidationView } from "./useValidation";

/** The two fields of an issue that decide where it lives. */
export type JumpableIssue = Pick<ValidationIssue, "nodeId" | "code">;

export type IssueDestination =
  | { kind: "node"; nodeId: EditorId }
  /** `field` null = a message-wide issue: bring the options card into view. */
  | { kind: "message"; field: MessageIssueField | null };

/** Where an issue can be fixed, or null when there is nowhere to take the user. */
export function issueDestination(issue: JumpableIssue): IssueDestination | null {
  if (issue.nodeId !== undefined) return { kind: "node", nodeId: issue.nodeId };
  if (issue.code === "EMPTY_MESSAGE") return null;
  return { kind: "message", field: fieldForIssueCode(issue.code) };
}

/**
 * Take the user to an issue. Returns whether it had somewhere to go (false
 * leaves everything untouched). The scrolls are deferred a frame by the
 * helpers, so a caller may close a dialog first and jump in the same click.
 */
export function jumpToIssue(issue: JumpableIssue): boolean {
  const destination = issueDestination(issue);
  if (!destination) return false;
  if (destination.kind === "node") {
    useMessageStore.getState().select(destination.nodeId);
    scrollTreeRowIntoView(destination.nodeId);
    scrollPreviewNodeIntoView(destination.nodeId);
  } else {
    useOptionsRevealStore.getState().reveal(destination.field);
  }
  return true;
}

/**
 * The issue the header chip jumps to: the first component carrying the
 * dominant severity (errors outrank warnings), else the first message-level
 * issue of that severity with somewhere to go, else anything else that has
 * one — so the chip stays useful when the dominant error has no destination
 * (an empty message beside a reserved username or a warned-about button).
 */
export function chipJumpTarget(
  view: Pick<
    ValidationView,
    "errorCount" | "firstErrorNodeId" | "firstWarningNodeId" | "messageIssues"
  >,
): JumpableIssue | null {
  const isError = view.errorCount > 0;
  const dominantNode = isError ? view.firstErrorNodeId : view.firstWarningNodeId;
  if (dominantNode) return { nodeId: dominantNode, code: "" };
  const reachable = view.messageIssues.filter((i) => issueDestination(i) !== null);
  const dominantMessage = reachable.find((i) => i.severity === (isError ? "error" : "warning"));
  if (dominantMessage) return dominantMessage;
  if (isError && view.firstWarningNodeId) return { nodeId: view.firstWarningNodeId, code: "" };
  return reachable[0] ?? null;
}
