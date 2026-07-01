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

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { getAttachmentSnapshot, subscribeAttachments } from "@/core/state/attachmentStore";
import { getPluginSummary } from "@/core/state/pluginSummaryCache";
import { interactiveComponents } from "@/core/plugins/targets";
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

/**
 * Fold extra node-scoped issues (e.g. the plugin guild checks below) into a
 * view, returning a new one with the per-node lists, counts, and first-issue
 * ids updated. Issues without a `nodeId` are ignored — this is for component
 * problems only. Base's first-error / first-warning ids win when set, so a real
 * message error still anchors the header's jump affordance.
 */
export function mergeNodeIssues(base: ValidationView, extra: ValidationIssue[]): ValidationView {
  if (extra.length === 0) return base;
  const byNode = new Map(base.byNode);
  let { errorCount, warningCount, firstErrorNodeId, firstWarningNodeId } = base;
  for (const issue of extra) {
    if (issue.nodeId === undefined) continue;
    const existing = byNode.get(issue.nodeId);
    byNode.set(issue.nodeId, existing ? [...existing, issue] : [issue]);
    if (issue.severity === "error") {
      errorCount++;
      if (firstErrorNodeId === null) firstErrorNodeId = issue.nodeId;
    } else {
      warningCount++;
      if (firstWarningNodeId === null) firstWarningNodeId = issue.nodeId;
    }
  }
  return { ...base, byNode, errorCount, warningCount, firstErrorNodeId, firstWarningNodeId };
}

/**
 * Editor-only validation issues for guild-scoped plugin bindings (Self Role et
 * al.), which only work in the server they were set up for. These can't live in
 * `validateMessage` — it's a pure, destination-agnostic function shared with the
 * Send panel, while this depends on the connected guild and the per-binding
 * guild cache (both outside the message). Returned as standard `ValidationIssue`s
 * so {@link mergeNodeIssues} can give them the same tree-dot + inspector-banner
 * treatment as any real problem.
 *
 *  - A connected guild that the binding's target *differs* from is a provable
 *    wrong-server: an **error**.
 *  - No connected guild (signed out / not connected) means we can't compare, but
 *    the binding is still server-locked: a softer **warning** so it isn't
 *    silently dropped (the cache survives logout, so we still see the binding).
 *
 * The real, blocking check still runs at send time against the webhook's guild.
 */
export function usePluginGuildIssues(): ValidationIssue[] {
  const message = useMessageStore((s) => s.message);
  const connectedGuildId = useGuildStore((s) => s.guildId);
  return useMemo(() => {
    const connected = connectedGuildId !== "";
    const issues: ValidationIssue[] = [];
    for (const { nodeId, customId } of interactiveComponents(message)) {
      const entry = getPluginSummary(customId);
      const targetGuildId = entry?.guildId;
      if (!targetGuildId) continue; // not a guild-scoped binding
      if (connected && targetGuildId === connectedGuildId) continue; // correctly placed
      issues.push(
        connected
          ? {
              nodeId,
              severity: "error",
              code: "PLUGIN_GUILD_MISMATCH",
              message: `“${entry.summary.label}” is set up for a different server than the one you're connected to — it won't respond when posted there.`,
            }
          : {
              nodeId,
              severity: "warning",
              code: "PLUGIN_GUILD_UNVERIFIED",
              message: `“${entry.summary.label}” only works in the server it was set up for — connect that server (or sign in) so DWEEB can confirm you're posting there.`,
            },
      );
    }
    return issues;
  }, [message, connectedGuildId]);
}

/**
 * The full validation view — base message checks with the guild-scoped plugin
 * issues folded in — for surfaces that need it *above* the tree's
 * {@link ValidationContext} provider: the web action bar and the Activity bar,
 * whose shared header issue chip must count exactly what the tree does. It's the
 * same fold `ComponentTree` applies before providing the context, extracted so
 * both the provider and the header read one memoized source.
 */
export function useMergedValidationView(): ValidationView {
  const base = useValidationView();
  const pluginIssues = usePluginGuildIssues();
  return useMemo(() => mergeNodeIssues(base, pluginIssues), [base, pluginIssues]);
}

/** Recompute the live validation view from the current message (memoized). */
export function useValidationView(): ValidationView {
  const message = useMessageStore((s) => s.message);
  // Validation reads the attachment registry (`checkAttachmentResolves`), so it
  // must also recompute when blobs are registered, GC'd, or — crucially —
  // restored from IndexedDB on startup. Without this, a reload would clear the
  // preview's "missing" state but leave the stale ATTACHMENT_MISSING error
  // standing until the next message edit. The version bumps on every mutation.
  const attachmentsVersion = useSyncExternalStore(
    subscribeAttachments,
    getAttachmentSnapshot,
    getAttachmentSnapshot,
  );
  return useMemo(() => buildValidationView(message), [message, attachmentsVersion]);
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
