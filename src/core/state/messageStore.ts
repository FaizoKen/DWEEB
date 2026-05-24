/**
 * Editor state store.
 *
 * One Zustand store owns the live message + selection. Components subscribe
 * to narrow slices via `useMessageStore(selector)` so that, e.g., editing
 * one TextDisplay doesn't rerender the entire inspector tree.
 *
 * Mutation rules:
 *  - All edits go through the actions below — components never call
 *    `setState` directly.
 *  - Every action treats the previous tree as immutable. `traversal.updateById`
 *    rebuilds only the path from root to the edited node, so React's referential
 *    equality on untouched subtrees still holds.
 *  - History (undo/redo) is captured by snapshotting the message before each
 *    structural action. Field edits coalesce into a single history entry per
 *    burst (see `pushHistory`).
 */

import { create } from "zustand";
import { newId } from "@/lib/id";
import {
  createTopLevel,
  type ContainerChildFactoryKey,
  type TopLevelFactoryKey,
} from "@/core/factory/createComponent";
import { BLANK_PRESET, DEFAULT_PRESET, PRESETS } from "@/data/presets";
import { hasSeenWelcome, loadDraftMessage } from "./draftStorage";
import {
  ComponentType,
  isContainer,
  removeById,
  updateById,
  type AnyComponent,
  type ContainerChild,
  type ContainerComponent,
  type EditorId,
  type SectionAccessory,
  type SectionComponent,
  type TextDisplayComponent,
  type TopLevelComponent,
  type WebhookMessage,
} from "@/core/schema";
import {
  createLinkButton,
  createTextDisplay,
  createThumbnail,
} from "@/core/factory/createComponent";

const HISTORY_LIMIT = 50;

interface HistoryFrame {
  message: WebhookMessage;
}

/**
 * Origin of the active message when it was loaded by fetching a previously
 * posted webhook message. Held in memory only (never persisted to draft,
 * URL, or JSON export) so that "Update existing" in the Send panel can
 * default to PATCH-ing the same message instead of POST-ing a new one.
 *
 * Reset to `null` whenever a different message replaces the editor state
 * (preset, import, blank, share URL) — only an active restore opts in.
 */
export interface RestoredOrigin {
  /** Canonical webhook execute URL (no query/fragment). */
  webhookUrl: string;
  /** Message snowflake. */
  messageId: string;
  /** Optional thread the message lives in. */
  threadId?: string;
}

export interface MessageState {
  message: WebhookMessage;
  selectedId: EditorId | null;
  restoredFrom: RestoredOrigin | null;

  past: HistoryFrame[];
  future: HistoryFrame[];

  // Selection -----------------------------------------------------------
  select(id: EditorId | null): void;

  // Whole-message ops --------------------------------------------------
  replaceMessage(next: WebhookMessage): void;
  /** Like `replaceMessage` but records the restore origin for the Send flow. */
  replaceMessageFromRestore(next: WebhookMessage, origin: RestoredOrigin): void;
  /** Drop the restore origin (e.g. user picks "Send as new" in the Send panel). */
  clearRestoreOrigin(): void;
  loadPresetById(presetId: string): void;
  loadDefaultPreset(): void;
  loadBlank(): void;
  setUsername(value: string | undefined): void;
  setAvatarUrl(value: string | undefined): void;

  // Structural ops ------------------------------------------------------
  addTopLevel(type: TopLevelFactoryKey): void;
  addContainerChild(containerId: EditorId, type: ContainerChildFactoryKey): void;
  addSectionText(sectionId: EditorId): void;
  addRowButton(rowId: EditorId): void;
  addGalleryItem(galleryId: EditorId): void;
  setSectionAccessoryKind(sectionId: EditorId, kind: "button" | "thumbnail"): void;

  moveSibling(id: EditorId, direction: -1 | 1): void;
  duplicate(id: EditorId): void;
  remove(id: EditorId): void;

  // Field ops -----------------------------------------------------------
  patchNode<T extends AnyComponent>(id: EditorId, patch: Partial<T>): void;
  /**
   * Replace a node wholesale, preserving its editor id. Use when a style
   * change (e.g. Button style) restructures which fields a node has.
   */
  replaceNode<T extends AnyComponent>(id: EditorId, next: Omit<T, "_id">): void;

  // History -------------------------------------------------------------
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

/** Stamps every component (and every nested component) with a fresh id. */
function reassignIds(message: WebhookMessage): WebhookMessage {
  const stamp = <T extends AnyComponent>(node: T): T => {
    const next = { ...node, _id: newId() } as T;
    if (isContainer(next)) {
      (next as unknown as ContainerComponent).components = (
        next as unknown as ContainerComponent
      ).components.map((c) => stamp(c)) as ContainerChild[];
    } else if ("components" in next && Array.isArray((next as { components?: unknown }).components)) {
      (next as unknown as { components: AnyComponent[] }).components = (
        next as unknown as { components: AnyComponent[] }
      ).components.map((c) => stamp(c));
    }
    if ("accessory" in next && next.accessory) {
      (next as unknown as { accessory: AnyComponent }).accessory = stamp(
        (next as unknown as { accessory: AnyComponent }).accessory,
      );
    }
    return next;
  };
  return { ...message, components: message.components.map((c) => stamp(c)) };
}

function pushHistory(state: MessageState): Pick<MessageState, "past" | "future"> {
  const past = [...state.past, { message: state.message }];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, future: [] };
}

/**
 * Initial editor state.
 *
 * Returning users (welcome-modal already dismissed) silently pick up where
 * they left off via the persisted draft. First-time visitors and users with
 * no saved draft get the showcase preset; the welcome dialog handles the
 * "pick a starter" UX in the App layer.
 *
 * If the URL hash carries a share token, `useShareUrlBootstrap` will
 * overwrite this value shortly after first mount.
 */
function bootstrap(): WebhookMessage {
  if (hasSeenWelcome()) {
    const draft = loadDraftMessage();
    if (draft) return draft.message;
  }
  return reassignIds(DEFAULT_PRESET.message);
}

export const useMessageStore = create<MessageState>((set, get) => ({
  message: bootstrap(),
  selectedId: null,
  restoredFrom: null,
  past: [],
  future: [],

  select(id) {
    set({ selectedId: id });
  },

  replaceMessage(next) {
    set((s) => ({
      ...pushHistory(s),
      message: reassignIds(next),
      selectedId: null,
      restoredFrom: null,
    }));
  },

  replaceMessageFromRestore(next, origin) {
    set((s) => ({
      ...pushHistory(s),
      message: reassignIds(next),
      selectedId: null,
      restoredFrom: origin,
    }));
  },

  clearRestoreOrigin() {
    set({ restoredFrom: null });
  },

  loadPresetById(presetId) {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    set((s) => ({
      ...pushHistory(s),
      message: reassignIds(preset.message),
      selectedId: null,
      restoredFrom: null,
    }));
  },

  loadDefaultPreset() {
    set((s) => ({
      ...pushHistory(s),
      message: reassignIds(DEFAULT_PRESET.message),
      selectedId: null,
      restoredFrom: null,
    }));
  },

  loadBlank() {
    set((s) => ({
      ...pushHistory(s),
      message: reassignIds(BLANK_PRESET.message),
      selectedId: null,
      restoredFrom: null,
    }));
  },

  setUsername(value) {
    set((s) => ({
      ...pushHistory(s),
      message: { ...s.message, username: value || undefined },
    }));
  },

  setAvatarUrl(value) {
    set((s) => ({
      ...pushHistory(s),
      message: { ...s.message, avatar_url: value || undefined },
    }));
  },

  addTopLevel(type) {
    set((s) => {
      const next = createTopLevel(type);
      return {
        ...pushHistory(s),
        message: { ...s.message, components: [...s.message.components, next] },
        selectedId: next._id,
      };
    });
  },

  addContainerChild(containerId, type) {
    set((s) => {
      const child = createTopLevel(type) as ContainerChild;
      return {
        ...pushHistory(s),
        message: updateById<ContainerComponent>(s.message, containerId, (c) => ({
          ...c,
          components: [...c.components, child],
        })),
        selectedId: child._id,
      };
    });
  },

  addSectionText(sectionId) {
    set((s) => {
      const text = createTextDisplay("");
      return {
        ...pushHistory(s),
        message: updateById<SectionComponent>(s.message, sectionId, (sec) => ({
          ...sec,
          components: [...sec.components, text] as SectionComponent["components"],
        })),
        selectedId: text._id,
      };
    });
  },

  addRowButton(rowId) {
    set((s) => {
      const btn = createLinkButton();
      return {
        ...pushHistory(s),
        message: updateById(s.message, rowId, (row) =>
          row.type === ComponentType.ActionRow
            ? { ...row, components: [...row.components, btn] }
            : row,
        ),
        selectedId: btn._id,
      };
    });
  },

  addGalleryItem(galleryId) {
    set((s) => ({
      ...pushHistory(s),
      message: updateById(s.message, galleryId, (g) =>
        g.type === ComponentType.MediaGallery
          ? {
              ...g,
              items: [
                ...g.items,
                {
                  media: {
                    url: "https://placehold.co/600x400/5865F2/ffffff/png?text=Image",
                  },
                },
              ],
            }
          : g,
      ),
    }));
  },

  setSectionAccessoryKind(sectionId, kind) {
    set((s) => ({
      ...pushHistory(s),
      message: updateById<SectionComponent>(s.message, sectionId, (sec) => {
        const accessory: SectionAccessory =
          kind === "button" ? createLinkButton() : createThumbnail();
        return { ...sec, accessory };
      }),
    }));
  },

  moveSibling(id, direction) {
    set((s) => {
      const reorder = <T extends { _id: EditorId }>(arr: T[]): T[] => {
        const idx = arr.findIndex((c) => c._id === id);
        if (idx === -1) return arr;
        const target = idx + direction;
        if (target < 0 || target >= arr.length) return arr;
        const next = arr.slice();
        const [item] = next.splice(idx, 1);
        next.splice(target, 0, item!);
        return next;
      };

      // Try top-level first.
      const topReordered = reorder(s.message.components);
      if (topReordered !== s.message.components) {
        return {
          ...pushHistory(s),
          message: { ...s.message, components: topReordered as TopLevelComponent[] },
        };
      }

      // Walk containers/sections/rows looking for the sibling list that owns
      // this node. We do this immutably via updateById on the parent.
      const reorderInside = (msg: WebhookMessage): WebhookMessage => {
        const walkNode = (node: AnyComponent): AnyComponent => {
          if (isContainer(node)) {
            const reordered = reorder(node.components);
            if (reordered !== node.components)
              return { ...node, components: reordered as ContainerChild[] };
          }
          if ("components" in node && Array.isArray((node as { components?: unknown }).components)) {
            const arr = (node as unknown as { components: AnyComponent[] }).components;
            const reordered = reorder(arr);
            if (reordered !== arr)
              return { ...node, components: reordered } as AnyComponent;
          }
          return node;
        };

        const recurse = (node: AnyComponent): AnyComponent => {
          const next = walkNode(node);
          if (next !== node) return next;
          if (isContainer(node)) {
            let changed = false;
            const components = node.components.map((c) => {
              const r = recurse(c) as ContainerChild;
              if (r !== c) changed = true;
              return r;
            });
            return changed ? { ...node, components } : node;
          }
          return node;
        };

        let changed = false;
        const components = msg.components.map((c) => {
          const r = recurse(c) as TopLevelComponent;
          if (r !== c) changed = true;
          return r;
        });
        return changed ? { ...msg, components } : msg;
      };

      const moved = reorderInside(s.message);
      if (moved === s.message) return s;
      return { ...pushHistory(s), message: moved };
    });
  },

  duplicate(id) {
    set((s) => {
      const cloneWithIds = <T extends AnyComponent>(node: T): T => {
        const next = { ...node, _id: newId() } as T;
        if (isContainer(next)) {
          (next as unknown as ContainerComponent).components = (
            node as unknown as ContainerComponent
          ).components.map((c) => cloneWithIds(c)) as ContainerChild[];
        } else if (
          "components" in next &&
          Array.isArray((next as { components?: unknown }).components)
        ) {
          (next as unknown as { components: AnyComponent[] }).components = (
            node as unknown as { components: AnyComponent[] }
          ).components.map((c) => cloneWithIds(c));
        }
        if ("accessory" in next && next.accessory) {
          (next as unknown as { accessory: AnyComponent }).accessory = cloneWithIds(
            (next as unknown as { accessory: AnyComponent }).accessory,
          );
        }
        return next;
      };

      // Duplicate at top-level if applicable.
      const topIndex = s.message.components.findIndex((c) => c._id === id);
      if (topIndex >= 0) {
        const original = s.message.components[topIndex]!;
        const clone = cloneWithIds(original);
        const next = s.message.components.slice();
        next.splice(topIndex + 1, 0, clone);
        return {
          ...pushHistory(s),
          message: { ...s.message, components: next as TopLevelComponent[] },
          selectedId: clone._id,
        };
      }

      // Otherwise, descend into containers/sections/rows.
      let newSelection: EditorId | null = null;
      const dupIn = (msg: WebhookMessage): WebhookMessage => {
        const dupArr = <T extends { _id: EditorId }>(arr: T[]): T[] | null => {
          const idx = arr.findIndex((c) => c._id === id);
          if (idx < 0) return null;
          const clone = cloneWithIds(arr[idx]! as unknown as AnyComponent) as unknown as T;
          newSelection = (clone as { _id: EditorId })._id;
          const next = arr.slice();
          next.splice(idx + 1, 0, clone);
          return next;
        };

        const recurse = (node: AnyComponent): AnyComponent => {
          if (isContainer(node)) {
            const dupd = dupArr(node.components);
            if (dupd) return { ...node, components: dupd as ContainerChild[] };
            let changed = false;
            const components = node.components.map((c) => {
              const r = recurse(c) as ContainerChild;
              if (r !== c) changed = true;
              return r;
            });
            return changed ? { ...node, components } : node;
          }
          if ("components" in node && Array.isArray((node as { components?: unknown }).components)) {
            const arr = (node as unknown as { components: AnyComponent[] }).components;
            const dupd = dupArr(arr);
            if (dupd) return { ...node, components: dupd } as AnyComponent;
          }
          return node;
        };

        const components = msg.components.map((c) => recurse(c) as TopLevelComponent);
        return { ...msg, components };
      };

      const next = dupIn(s.message);
      if (next === s.message) return s;
      return { ...pushHistory(s), message: next, selectedId: newSelection };
    });
  },

  remove(id) {
    set((s) => ({
      ...pushHistory(s),
      message: removeById(s.message, id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
  },

  patchNode(id, patch) {
    set((s) => ({
      ...pushHistory(s),
      message: updateById(s.message, id, (n) => ({ ...n, ...patch }) as typeof n),
    }));
  },

  replaceNode(id, next) {
    set((s) => ({
      ...pushHistory(s),
      message: updateById(s.message, id, (n) => ({ ...next, _id: n._id }) as typeof n),
    }));
  },

  undo() {
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      return {
        past: s.past.slice(0, -1),
        future: [{ message: s.message }, ...s.future],
        message: prev.message,
      };
    });
  },

  redo() {
    set((s) => {
      const [next, ...rest] = s.future;
      if (!next) return s;
      return {
        past: [...s.past, { message: s.message }],
        future: rest,
        message: next.message,
      };
    });
  },

  canUndo() {
    return get().past.length > 0;
  },

  canRedo() {
    return get().future.length > 0;
  },
}));

/** Selector helpers — keep them outside the hook to avoid re-creating refs. */
export const selectSelectedId = (s: MessageState): EditorId | null => s.selectedId;
export const selectMessage = (s: MessageState): WebhookMessage => s.message;

/**
 * Type-safe patch helper. Use when patching a specific component variant
 * from an inspector — the inspector already knows the concrete type and
 * lets TypeScript narrow the patch shape.
 */
export function patchTextDisplay(id: EditorId, patch: Partial<TextDisplayComponent>): void {
  useMessageStore.getState().patchNode<TextDisplayComponent>(id, patch);
}
