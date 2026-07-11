/**
 * "Reveal a message-level setting" signal — the message-wide counterpart of the
 * tree's jump-to-node: node-scoped issues scroll to their tree row, and issues
 * that live on the message itself (thread name, applied tags, mentions,
 * username/avatar) land on the meta header's card instead.
 *
 * A one-shot token store in the `sendNudgeStore` mould keeps this off prop
 * chains: `HeaderIssueChip` fires it, `MessageOptions` consumes it — scrolling
 * its card into view and, when the issue maps to one of its lanes, expanding
 * that lane and focusing its first field.
 */

import { create } from "zustand";

export type OptionsSection = "notification" | "forum";

interface OptionsRevealState {
  /** The lane to expand, or null to just bring the meta card into view (for
   *  message-level issues that live outside the lanes, e.g. username/avatar). */
  section: OptionsSection | null;
  /** Bumped per request so consumers see repeat reveals of the same section. */
  token: number;
  reveal(section: OptionsSection | null): void;
}

export const useOptionsRevealStore = create<OptionsRevealState>((set) => ({
  section: null,
  token: 0,
  reveal: (section) => set((s) => ({ section, token: s.token + 1 })),
}));

/**
 * Which Message-options lane a message-level validation issue lives in, from
 * its code — null for issues shown in the meta header itself (banner or the
 * username/avatar fields), where scrolling the card into view is enough.
 */
export function sectionForIssueCode(code: string): OptionsSection | null {
  if (code.startsWith("THREAD_NAME") || code.startsWith("APPLIED_TAG")) return "forum";
  if (code.startsWith("ALLOWED_MENTIONS")) return "notification";
  return null;
}
