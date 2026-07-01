/**
 * Per-node editing presence — "who is editing which block".
 *
 * The collaboration room already syncs the draft granularly (see `collab.ts`),
 * but that's invisible: you can't tell a teammate is inside a block until their
 * text changes under you. This store closes that gap. Every peer broadcasts the
 * node they currently have selected as a `focus` frame; `collab.ts` funnels the
 * incoming frames in here, and the builder tree paints a coloured ring + avatar
 * on the rows other people are in — so co-editing feels alive and a surprise
 * last-write-wins overwrite becomes a thing you saw coming.
 *
 * Deliberately dependency-free: a plain Zustand store holding data, no SDK/React
 * imports beyond `zustand`. The web app never writes to it (only the Activity's
 * `collab.ts` does), so it stays empty there and the shared tree renders no
 * rings — the feature costs the web bundle a few bytes and nothing at runtime.
 */

import { create } from "zustand";
import { colorFor } from "./avatar";

/** One other editor present on a node. */
export interface NodeEditor {
  userId: string;
  name: string;
  avatar: string | null;
  /** Stable ring hue for this user (their avatar-cluster colour). */
  color: string;
}

interface PresenceState {
  /** nodeId → the editors currently focused there. Arrays keep their reference
   *  across unrelated updates so a tree row only re-renders when *its* node's
   *  roster actually changes. */
  byNode: Record<string, NodeEditor[]>;
  /** userId → the node they're on (or null), so a move can cheaply clear the old
   *  node before adding the new one. */
  focusOf: Record<string, string | null>;

  /** Record that `user` moved their focus to `nodeId` (or nowhere when null). */
  setFocus(user: Omit<NodeEditor, "color">, nodeId: string | null): void;
  /** Drop everyone not in `userIds` — driven by the room roster so a peer who
   *  left stops haunting whatever block they had open. */
  retain(userIds: string[]): void;
  /** Forget everything (room teardown). */
  reset(): void;
}

/** Remove `userId` from a node's editor list, returning a new `byNode` (or the
 *  same reference when nothing changed, so subscribers don't wake needlessly). */
function withoutUser(
  byNode: Record<string, NodeEditor[]>,
  nodeId: string,
  userId: string,
): Record<string, NodeEditor[]> {
  const list = byNode[nodeId];
  if (!list) return byNode;
  const next = list.filter((e) => e.userId !== userId);
  if (next.length === list.length) return byNode;
  const copy = { ...byNode };
  if (next.length === 0) delete copy[nodeId];
  else copy[nodeId] = next;
  return copy;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  byNode: {},
  focusOf: {},

  setFocus(user, nodeId) {
    set((s) => {
      const prevNode = s.focusOf[user.userId] ?? null;
      if (prevNode === nodeId) {
        // Same node — refresh their display fields in place (name/avatar could
        // have arrived late) without disturbing the map shape.
        if (nodeId === null) return s;
        const list = s.byNode[nodeId];
        if (list?.some((e) => e.userId === user.userId)) return s;
        // Fall through to (re)insert if somehow missing.
      }

      let byNode = s.byNode;
      // Clear them from wherever they were.
      if (prevNode) byNode = withoutUser(byNode, prevNode, user.userId);

      if (nodeId) {
        const editor: NodeEditor = { ...user, color: colorFor(user.userId) };
        const existing = byNode[nodeId] ?? [];
        byNode = {
          ...byNode,
          [nodeId]: [...existing.filter((e) => e.userId !== user.userId), editor],
        };
      }

      return { byNode, focusOf: { ...s.focusOf, [user.userId]: nodeId } };
    });
  },

  retain(userIds) {
    set((s) => {
      const keep = new Set(userIds);
      const staleUsers = Object.keys(s.focusOf).filter((uid) => !keep.has(uid));
      if (staleUsers.length === 0) return s;
      let byNode = s.byNode;
      const focusOf = { ...s.focusOf };
      for (const uid of staleUsers) {
        const node = focusOf[uid];
        if (node) byNode = withoutUser(byNode, node, uid);
        delete focusOf[uid];
      }
      return { byNode, focusOf };
    });
  },

  reset() {
    set({ byNode: {}, focusOf: {} });
  },
}));

/** Stable empty roster so unfocused rows subscribe without ever re-rendering. */
const NO_EDITORS: NodeEditor[] = [];

/** The other editors currently on `nodeId` (empty in the web app / when alone).
 *  A tree row calls this; the selector's reference only changes when this node's
 *  roster does, so selection presence is cheap even in a large message. */
export function useNodeEditors(nodeId: string): NodeEditor[] {
  return usePresenceStore((s) => s.byNode[nodeId] ?? NO_EDITORS);
}
