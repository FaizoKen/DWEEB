/**
 * Message-level issues, routed to their home field.
 *
 * `validateMessage` emits some issues with no owning component — they belong
 * to the message's own settings: username/avatar (the meta header's inputs),
 * thread name / applied tags (the Forum post lane), allowed-mentions ids (the
 * Notifications lane). `fieldForIssueCode` is the single map from an issue
 * code to that home; everything it maps renders inline under its field (like
 * any other field error) and is dropped from the meta header's banner, which
 * keeps only the truly message-wide leftovers (top-level/total limits).
 *
 * The reveal store is the message-wide counterpart of the tree's
 * jump-to-node: `HeaderIssueChip` fires it with the issue's home field, and
 * `MessageOptions` answers — expanding the lane that hosts the field (when it
 * lives in one), scrolling it into view, and focusing the control. A one-shot
 * token store in the `sendNudgeStore` mould keeps this off prop chains.
 */

import { create } from "zustand";
import type { ValidationIssue } from "@/core/schema/validation";

export type OptionsSection = "notification" | "forum";

/** A message-level setting that owns validation issues. `username`/`avatar`
 *  live on the meta header itself; the rest live in a Message-options lane. */
export type MessageIssueField =
  | "username"
  | "avatar"
  | "thread_name"
  | "applied_tags"
  | "mention_roles"
  | "mention_users";

/**
 * Which field a message-level validation issue belongs to, from its code —
 * null for the few issues that are genuinely message-wide (component limits),
 * which stay in the meta header's banner.
 */
export function fieldForIssueCode(code: string): MessageIssueField | null {
  if (code.startsWith("USERNAME")) return "username";
  if (code.startsWith("AVATAR_URL")) return "avatar";
  if (code.startsWith("THREAD_NAME")) return "thread_name";
  if (code.startsWith("APPLIED_TAG")) return "applied_tags";
  if (code === "ALLOWED_MENTIONS_BAD_ROLE" || code === "ALLOWED_MENTIONS_CONFLICT_ROLES")
    return "mention_roles";
  if (code === "ALLOWED_MENTIONS_BAD_USER" || code === "ALLOWED_MENTIONS_CONFLICT_USERS")
    return "mention_users";
  return null;
}

/** What one field shows: its first error and first warning, in issue order. */
export interface FieldIssueSlot {
  error?: string;
  warning?: string;
}

/**
 * Group a validation view's message-level issues by home field — the shape the
 * meta header (username/avatar) and `MessageOptions` (lane fields) both feed
 * their `Field` error/warning props from. Issues with no home (message-wide
 * limits) are skipped; they stay in the meta header's banner.
 */
export function routeMessageIssues(
  issues: readonly ValidationIssue[],
): Map<MessageIssueField, FieldIssueSlot> {
  const out = new Map<MessageIssueField, FieldIssueSlot>();
  for (const issue of issues) {
    const field = fieldForIssueCode(issue.code);
    if (!field) continue;
    const slot = out.get(field) ?? {};
    if (issue.severity === "error") slot.error ??= issue.message;
    else slot.warning ??= issue.message;
    out.set(field, slot);
  }
  return out;
}

/** The Message-options lane hosting a field — null for the meta header's own
 *  username/avatar inputs, which sit outside the lanes. */
export function sectionForField(field: MessageIssueField): OptionsSection | null {
  switch (field) {
    case "thread_name":
    case "applied_tags":
      return "forum";
    case "mention_roles":
    case "mention_users":
      return "notification";
    default:
      return null;
  }
}

interface OptionsRevealState {
  /** The field to land on, or null to just bring the meta area into view (for
   *  banner-only issues with no single owning control). */
  field: MessageIssueField | null;
  /** Bumped per request so consumers see repeat reveals of the same field. */
  token: number;
  reveal(field: MessageIssueField | null): void;
}

export const useOptionsRevealStore = create<OptionsRevealState>((set) => ({
  field: null,
  token: 0,
  reveal: (field) => set((s) => ({ field, token: s.token + 1 })),
}));
