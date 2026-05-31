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
  createSelect,
  createTopLevel,
  type ContainerChildFactoryKey,
  type TopLevelFactoryKey,
} from "@/core/factory/createComponent";
import { DEFAULT_PRESET } from "@/data/presets";
import { LIMITS } from "@/core/schema/limits";
import { loadDraftMessage } from "./draftStorage";
import {
  ButtonStyle,
  ComponentType,
  findById,
  isActionRow,
  isButton,
  isContainer,
  isSection,
  isSelect,
  removeById,
  updateById,
  type ActionRowComponent,
  type AllowedMentions,
  type AnyComponent,
  type ContainerChild,
  type ContainerComponent,
  type EditorId,
  type MediaGalleryComponent,
  type MediaGalleryItem,
  type SectionAccessory,
  type SectionComponent,
  type SelectComponent,
  type TextDisplayComponent,
  type TopLevelComponent,
  type WebhookMessage,
} from "@/core/schema";
import {
  createGalleryItem,
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
  loadDefaultPreset(): void;
  setUsername(value: string | undefined): void;
  setAvatarUrl(value: string | undefined): void;
  setTts(value: boolean): void;
  setSuppressNotifications(value: boolean): void;
  setAllowedMentions(value: AllowedMentions | undefined): void;
  setThreadName(value: string | undefined): void;
  setAppliedTags(value: string[] | undefined): void;

  // Structural ops ------------------------------------------------------
  addTopLevel(type: TopLevelFactoryKey): void;
  addContainerChild(containerId: EditorId, type: ContainerChildFactoryKey): void;
  addSectionText(sectionId: EditorId): void;
  addRowButton(rowId: EditorId): void;
  addRowSelect(rowId: EditorId, type: SelectComponent["type"]): void;
  addGalleryItem(galleryId: EditorId): void;
  /** Reorder an image within its gallery by one slot. */
  moveGalleryItem(galleryId: EditorId, itemId: EditorId, direction: -1 | 1): void;
  /**
   * Move an image to an absolute insertion index within its gallery (the
   * drag-and-drop reorder commit). `targetIndex` is the pre-removal insertion
   * index, matching the tree's drop-position math.
   */
  moveGalleryItemToIndex(galleryId: EditorId, itemId: EditorId, targetIndex: number): void;
  /** Remove an image from a gallery (no-op if it's the last remaining image). */
  removeGalleryItem(galleryId: EditorId, itemId: EditorId): void;
  /** Clone an image in place, selecting the copy. No-op at the gallery cap. */
  duplicateGalleryItem(galleryId: EditorId, itemId: EditorId): void;
  /** Patch a single image's fields (media/description/spoiler). */
  patchGalleryItem(galleryId: EditorId, itemId: EditorId, patch: Partial<MediaGalleryItem>): void;
  setSectionAccessoryKind(sectionId: EditorId, kind: "button" | "thumbnail"): void;

  moveSibling(id: EditorId, direction: -1 | 1): void;
  /**
   * Drag-and-drop move. Relocates `id` into `targetParentId`'s children at
   * `targetIndex`. `targetParentId === null` targets the top-level list.
   *
   * Same-parent calls behave as a reorder (`targetIndex` is the insertion
   * index *before* removing the source — the action compensates when moving
   * forward).
   *
   * Cross-parent moves are only honoured between the top-level list and a
   * Container's children. Other slots (Section accessory, Section texts,
   * ActionRow buttons/selects) carry specialized types and cannot accept
   * arbitrary components, so the action silently no-ops if the move would
   * produce an invalid tree (incompatible target, capacity exceeded, or a
   * Container being nested inside another Container).
   */
  moveToParent(id: EditorId, targetParentId: EditorId | null, targetIndex: number): void;
  duplicate(id: EditorId): void;
  remove(id: EditorId): void;
  /**
   * Strip every interactive component (select menus + custom_id buttons) from
   * the tree so the message can be sent through a webhook that isn't
   * application-owned. Action rows left empty are dropped; a Section's mandatory
   * accessory button is downgraded to a Link button instead (the slot can't be
   * empty). Returns how many interactive components were cleared.
   */
  stripInteractive(): number;

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
    } else if (
      "components" in next &&
      Array.isArray((next as { components?: unknown }).components)
    ) {
      (next as unknown as { components: AnyComponent[] }).components = (
        next as unknown as { components: AnyComponent[] }
      ).components.map((c) => stamp(c));
    }
    if ("accessory" in next && next.accessory) {
      (next as unknown as { accessory: AnyComponent }).accessory = stamp(
        (next as unknown as { accessory: AnyComponent }).accessory,
      );
    }
    if ("items" in next && Array.isArray((next as { items?: unknown }).items)) {
      (next as unknown as { items: MediaGalleryItem[] }).items = (
        next as unknown as { items: MediaGalleryItem[] }
      ).items.map((it) => ({ ...it, _id: newId() }));
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
 * Returning users silently pick up where they left off via the persisted
 * draft. First-time visitors and users with no saved draft get the showcase
 * preset so the editor opens with something illustrative.
 *
 * If the URL hash carries a share token, `useShareUrlBootstrap` will
 * overwrite this value shortly after first mount.
 */
function bootstrap(): WebhookMessage {
  const draft = loadDraftMessage();
  if (draft) return draft.message;
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

  loadDefaultPreset() {
    set((s) => ({
      ...pushHistory(s),
      message: reassignIds(DEFAULT_PRESET.message),
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

  setTts(value) {
    set((s) => ({
      ...pushHistory(s),
      message: { ...s.message, tts: value || undefined },
    }));
  },

  setSuppressNotifications(value) {
    set((s) => ({
      ...pushHistory(s),
      message: { ...s.message, suppress_notifications: value || undefined },
    }));
  },

  setAllowedMentions(value) {
    set((s) => ({
      ...pushHistory(s),
      message: { ...s.message, allowed_mentions: value },
    }));
  },

  setThreadName(value) {
    set((s) => ({
      ...pushHistory(s),
      message: { ...s.message, thread_name: value || undefined },
    }));
  },

  setAppliedTags(value) {
    set((s) => ({
      ...pushHistory(s),
      message: { ...s.message, applied_tags: value && value.length > 0 ? value : undefined },
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
      let nextSelection: EditorId | null = null;
      const message = updateById<ActionRowComponent>(s.message, rowId, (row) => {
        // Refuse if the row already holds a select — buttons and selects can't mix.
        const first = row.components[0];
        if (first && isSelect(first)) return row;
        nextSelection = btn._id;
        return {
          ...row,
          components: [
            ...(row.components as ActionRowComponent["components"]),
            btn,
          ] as ActionRowComponent["components"],
        };
      });
      if (!nextSelection) return s;
      return { ...pushHistory(s), message, selectedId: nextSelection };
    });
  },

  addRowSelect(rowId, type) {
    set((s) => {
      const sel = createSelect(type);
      let nextSelection: EditorId | null = null;
      const message = updateById<ActionRowComponent>(s.message, rowId, (row) => {
        // Only empty rows accept a select — a row already holding a button OR
        // a select cannot be silently swapped.
        if (row.components.length > 0) return row;
        nextSelection = sel._id;
        return { ...row, components: [sel] };
      });
      if (!nextSelection) return s;
      return { ...pushHistory(s), message, selectedId: nextSelection };
    });
  },

  addGalleryItem(galleryId) {
    set((s) => {
      const item = createGalleryItem();
      let added = false;
      const message = updateById<MediaGalleryComponent>(s.message, galleryId, (g) => {
        if (g.type !== ComponentType.MediaGallery) return g;
        if (g.items.length >= LIMITS.GALLERY_ITEMS) return g;
        added = true;
        return { ...g, items: [...g.items, item] };
      });
      if (!added) return s;
      // Select the new image so its tree row expands ready to edit — the
      // "go to the last image" behavior, now expressed through selection.
      return { ...pushHistory(s), message, selectedId: item._id };
    });
  },

  moveGalleryItem(galleryId, itemId, direction) {
    set((s) => {
      let moved = false;
      const message = updateById<MediaGalleryComponent>(s.message, galleryId, (g) => {
        if (g.type !== ComponentType.MediaGallery) return g;
        const idx = g.items.findIndex((it) => it._id === itemId);
        if (idx === -1) return g;
        const target = idx + direction;
        if (target < 0 || target >= g.items.length) return g;
        const items = g.items.slice();
        const [picked] = items.splice(idx, 1);
        items.splice(target, 0, picked!);
        moved = true;
        return { ...g, items };
      });
      if (!moved) return s;
      return { ...pushHistory(s), message };
    });
  },

  moveGalleryItemToIndex(galleryId, itemId, targetIndex) {
    set((s) => {
      let moved = false;
      const message = updateById<MediaGalleryComponent>(s.message, galleryId, (g) => {
        if (g.type !== ComponentType.MediaGallery) return g;
        const idx = g.items.findIndex((it) => it._id === itemId);
        if (idx === -1) return g;
        // Clamp, then compensate for the source's own removal when it sits
        // before the target — mirrors `moveToParent`'s same-parent reorder.
        let target = Math.max(0, Math.min(targetIndex, g.items.length));
        if (target > idx) target -= 1;
        if (target === idx) return g;
        const items = g.items.slice();
        const [picked] = items.splice(idx, 1);
        items.splice(target, 0, picked!);
        moved = true;
        return { ...g, items };
      });
      if (!moved) return s;
      return { ...pushHistory(s), message };
    });
  },

  removeGalleryItem(galleryId, itemId) {
    set((s) => {
      let removed = false;
      const message = updateById<MediaGalleryComponent>(s.message, galleryId, (g) => {
        if (g.type !== ComponentType.MediaGallery) return g;
        if (g.items.length <= 1) return g; // keep at least one
        const items = g.items.filter((it) => it._id !== itemId);
        if (items.length === g.items.length) return g;
        removed = true;
        return { ...g, items };
      });
      if (!removed) return s;
      // Fall back to selecting the parent gallery when the removed image was
      // the active selection, so the inspector doesn't go blank.
      return {
        ...pushHistory(s),
        message,
        selectedId: s.selectedId === itemId ? galleryId : s.selectedId,
      };
    });
  },

  duplicateGalleryItem(galleryId, itemId) {
    set((s) => {
      let clonedId: EditorId | null = null;
      const message = updateById<MediaGalleryComponent>(s.message, galleryId, (g) => {
        if (g.type !== ComponentType.MediaGallery) return g;
        if (g.items.length >= LIMITS.GALLERY_ITEMS) return g;
        const idx = g.items.findIndex((it) => it._id === itemId);
        if (idx === -1) return g;
        const clone: MediaGalleryItem = { ...g.items[idx]!, _id: newId() };
        clonedId = clone._id;
        const items = g.items.slice();
        items.splice(idx + 1, 0, clone);
        return { ...g, items };
      });
      if (!clonedId) return s;
      return { ...pushHistory(s), message, selectedId: clonedId };
    });
  },

  patchGalleryItem(galleryId, itemId, patch) {
    set((s) => ({
      ...pushHistory(s),
      message: updateById<MediaGalleryComponent>(s.message, galleryId, (g) =>
        g.type === ComponentType.MediaGallery
          ? {
              ...g,
              items: g.items.map((it) => (it._id === itemId ? { ...it, ...patch } : it)),
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
    // Mirrors drag-and-drop semantics so the arrow buttons can navigate the
    // same boundaries the pointer can: between top-level and Containers, the
    // move can step into an adjacent Container or escape to the grandparent's
    // sibling list. Section/ActionRow children stay scoped to their parent
    // because those slots carry specialized types.
    const state = get();
    const loc = findById(state.message, id);
    if (!loc) return;
    const parent = loc.parent;
    const node = loc.node;

    const siblings: AnyComponent[] =
      parent === null
        ? state.message.components
        : ((parent as unknown as { components?: AnyComponent[] }).components ?? []);
    const idx = siblings.findIndex((c) => c._id === id);
    if (idx === -1) return;

    const canCrossParent = parent === null || isContainer(parent);
    const newIdx = idx + direction;
    const parentId = parent === null ? null : parent._id;

    if (canCrossParent) {
      // Adjacent sibling is a Container we can enter — dive in instead of
      // swapping past it.
      if (newIdx >= 0 && newIdx < siblings.length) {
        const neighbor = siblings[newIdx]!;
        if (
          isContainer(neighbor) &&
          node.type !== ComponentType.Container &&
          neighbor.components.length < LIMITS.CONTAINER_CHILDREN
        ) {
          const insertAt = direction === -1 ? neighbor.components.length : 0;
          get().moveToParent(id, neighbor._id, insertAt);
          return;
        }
      }

      // Out of bounds → pop out to the grandparent's sibling list.
      if (newIdx < 0 || newIdx >= siblings.length) {
        if (parent === null) return; // already at the top, nowhere higher
        const parentLoc = findById(state.message, parent._id);
        if (!parentLoc) return;
        const grand = parentLoc.parent;
        const grandSiblings: AnyComponent[] =
          grand === null
            ? state.message.components
            : ((grand as unknown as { components?: AnyComponent[] }).components ?? []);
        const pIdx = grandSiblings.findIndex((c) => c._id === parent._id);
        if (pIdx === -1) return;
        const insertAt = direction === -1 ? pIdx : pIdx + 1;
        get().moveToParent(id, grand === null ? null : grand._id, insertAt);
        return;
      }
    }

    // Same-parent swap. Covers reorderable top-level/Container moves that
    // don't cross a boundary as well as Section text and ActionRow button
    // reorders, which moveToParent handles via its same-parent branch.
    if (newIdx < 0 || newIdx >= siblings.length) return;
    const targetIndex = direction === 1 ? newIdx + 1 : newIdx;
    get().moveToParent(id, parentId, targetIndex);
  },

  moveToParent(id, targetParentId, targetIndex) {
    set((s) => {
      const sourceLoc = findById(s.message, id);
      if (!sourceLoc) return s;

      const sourceParentId = sourceLoc.parent ? sourceLoc.parent._id : null;

      // Source must live in a reorderable sibling array. Section accessory has
      // a dedicated slot and isn't draggable.
      if (sourceLoc.parent !== null) {
        const parent = sourceLoc.parent;
        const hasSiblingList =
          "components" in parent &&
          Array.isArray((parent as { components?: unknown }).components) &&
          (parent as unknown as { components: AnyComponent[] }).components.some(
            (c) => c._id === id,
          );
        if (!hasSiblingList) return s;
      }

      // Same parent → reorder.
      if (sourceParentId === targetParentId) {
        const reorder = <T extends { _id: EditorId }>(arr: T[]): T[] | null => {
          const idx = arr.findIndex((c) => c._id === id);
          if (idx === -1) return null;
          let target = Math.max(0, Math.min(targetIndex, arr.length));
          if (target > idx) target -= 1;
          if (target === idx) return null;
          const next = arr.slice();
          const [item] = next.splice(idx, 1);
          next.splice(target, 0, item!);
          return next;
        };

        if (sourceParentId === null) {
          const next = reorder(s.message.components);
          if (!next) return s;
          return {
            ...pushHistory(s),
            message: { ...s.message, components: next as TopLevelComponent[] },
          };
        }

        const message = updateById(s.message, sourceParentId, (p) => {
          const arr = (p as unknown as { components: AnyComponent[] }).components;
          const reordered = reorder(arr);
          if (!reordered) return p;
          return { ...p, components: reordered } as typeof p;
        });
        if (message === s.message) return s;
        return { ...pushHistory(s), message };
      }

      // Cross-parent → validate, then remove + insert.
      const node = sourceLoc.node;

      // Only top-level ↔ Container moves are supported. The Section/ActionRow
      // sibling lists carry specialized types that can't accept arbitrary
      // components, so we refuse those transitions.
      if (targetParentId === null) {
        if (s.message.components.length >= LIMITS.TOP_LEVEL_COMPONENTS) return s;
      } else {
        const targetLoc = findById(s.message, targetParentId);
        if (!targetLoc || !isContainer(targetLoc.node)) return s;
        // Containers can't be nested.
        if (node.type === ComponentType.Container) return s;
        if (targetLoc.node.components.length >= LIMITS.CONTAINER_CHILDREN) return s;
      }

      // Source must currently live at top-level or in a Container; otherwise
      // it carries a specialized parent type (Section text, ActionRow button)
      // that we won't relocate.
      if (sourceParentId !== null) {
        const sourceParent = sourceLoc.parent!;
        if (!isContainer(sourceParent)) return s;
      }

      let next = s.message;

      if (sourceParentId === null) {
        next = {
          ...next,
          components: next.components.filter((c) => c._id !== id) as TopLevelComponent[],
        };
      } else {
        next = updateById(next, sourceParentId, (p) => {
          const arr = (p as unknown as { components: AnyComponent[] }).components;
          return { ...p, components: arr.filter((c) => c._id !== id) } as typeof p;
        });
      }

      if (targetParentId === null) {
        const arr = next.components.slice();
        const insertAt = Math.max(0, Math.min(targetIndex, arr.length));
        arr.splice(insertAt, 0, node as TopLevelComponent);
        next = { ...next, components: arr };
      } else {
        next = updateById<ContainerComponent>(next, targetParentId, (p) => {
          const arr = p.components.slice();
          const insertAt = Math.max(0, Math.min(targetIndex, arr.length));
          arr.splice(insertAt, 0, node as ContainerChild);
          return { ...p, components: arr };
        });
      }

      return { ...pushHistory(s), message: next };
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
        if ("items" in next && Array.isArray((next as { items?: unknown }).items)) {
          (next as unknown as { items: MediaGalleryItem[] }).items = (
            node as unknown as { items: MediaGalleryItem[] }
          ).items.map((it) => ({ ...it, _id: newId() }));
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
          if (
            "components" in node &&
            Array.isArray((node as { components?: unknown }).components)
          ) {
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

  stripInteractive() {
    // Mirrors the capability inspector's notion of "interactive": every select
    // menu, plus buttons that carry a custom_id (anything that isn't Link or
    // Premium). Premium buttons are a separate monetization concern, so they
    // stay.
    const isInteractive = (n: AnyComponent): boolean =>
      isSelect(n) ||
      (isButton(n) && n.style !== ButtonStyle.Link && n.style !== ButtonStyle.Premium);

    let count = 0;

    // Returns the transformed node, or null when the node should be dropped
    // entirely (an action row / container left empty by the strip).
    const transform = (node: AnyComponent): AnyComponent | null => {
      if (isActionRow(node)) {
        const kept = node.components.filter((c) => {
          if (isInteractive(c)) {
            count++;
            return false;
          }
          return true;
        });
        if (kept.length === 0) return null;
        if (kept.length === node.components.length) return node;
        return { ...node, components: kept as ActionRowComponent["components"] };
      }
      if (isContainer(node)) {
        let changed = false;
        const kids: ContainerChild[] = [];
        for (const child of node.components) {
          const next = transform(child);
          if (next === null) {
            changed = true;
            continue;
          }
          if (next !== child) changed = true;
          kids.push(next as ContainerChild);
        }
        if (kids.length === 0) return null;
        return changed ? { ...node, components: kids } : node;
      }
      if (isSection(node) && isInteractive(node.accessory)) {
        // A Section must keep an accessory, so downgrade the interactive button
        // to a Link button rather than removing it. Preserve the label.
        count++;
        const label = "label" in node.accessory ? node.accessory.label : undefined;
        return { ...node, accessory: { ...createLinkButton(), label: label || "Open link" } };
      }
      return node;
    };

    const src = get().message;
    let changed = false;
    const components: TopLevelComponent[] = [];
    for (const top of src.components) {
      const next = transform(top);
      if (next === null) {
        changed = true;
        continue;
      }
      if (next !== top) changed = true;
      components.push(next as TopLevelComponent);
    }

    if (changed) {
      set((s) => ({
        ...pushHistory(s),
        message: { ...s.message, components },
        selectedId: null,
      }));
    }
    return count;
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
