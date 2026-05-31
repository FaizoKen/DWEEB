/**
 * Hierarchical view of the message's components.
 *
 * Each row carries its node's id in a `data-node-id` attribute and uses the
 * store's `select` action on click. Reordering happens through the store
 * (`moveSibling` for the inline up/down buttons, `moveToParent` for
 * drag-and-drop) so the preview stays in lockstep with the tree without
 * intermediate state. Drag-and-drop supports same-parent reorders plus
 * cross-parent moves between the top-level list and Containers — Section
 * texts and ActionRow buttons stay scoped to their parent because those
 * sibling arrays carry specialized types.
 *
 * The "add" affordance is contextual: the menu only offers component types
 * legal in the current parent. This avoids producing invalid trees that the
 * validator would then have to reject after the fact.
 */

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AriaAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useMessageStore } from "@/core/state/messageStore";
import { scrollTreeRowIntoView } from "@/features/builder/scrollTreeRow";
import {
  COMPONENT_META,
  CONTAINER_PICKER,
  ROW_SELECT_PICKER,
  TOP_LEVEL_PICKER,
} from "@/core/schema/metadata";
import { isActionRow, isContainer, isSection, isSelect, isSelectRow } from "@/core/schema/guards";
import type { ComponentTypeValue, SelectComponent } from "@/core/schema/types";
import { LIMITS } from "@/core/schema/limits";
import { countCharacters, countComponents } from "@/core/schema/traversal";
import type {
  ActionRowComponent,
  AnyComponent,
  ContainerComponent,
  EditorId,
  MediaGalleryComponent,
  MediaGalleryItem,
  SectionComponent,
} from "@/core/schema/types";
import { ComponentType } from "@/core/schema/types";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { IconButton } from "@/ui/IconButton";
import { TextInput } from "@/ui/TextInput";
import { AddComponentMenu } from "./AddComponentMenu";
import { AdvancedMessageOptions } from "./AdvancedMessageOptions";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  PlusIcon,
  TrashIcon,
} from "@/ui/Icon";
import { cn } from "@/lib/cn";
import { Inspector } from "./Inspector";
import { GalleryItemInspector } from "./inspectors/GalleryItemInspector";
import styles from "./ComponentTree.module.css";
import type { ContainerChildFactoryKey, TopLevelFactoryKey } from "@/core/factory/createComponent";

/**
 * Drag-and-drop session shared across every TreeNode. Only one node can be
 * dragged at a time; the active drop indicator lives here so a row can render
 * the caret regardless of where the source originated.
 *
 * Cross-parent moves are allowed between the top-level list and Containers
 * only — the Section/ActionRow sibling lists carry specialized types and are
 * refused. Each TreeNode receives a `parentKind` so it can validate drops
 * without re-walking the tree.
 */
type DropPosition = "before" | "after" | "into";

/** What kind of list this node's parent is. Drop rules vary per kind. */
type ParentKind = "top" | "container" | "section" | "actionRow" | "gallery";

interface DragInfo {
  id: EditorId;
  type: ComponentTypeValue;
  parentKind: ParentKind;
  parentId: EditorId | null;
}

interface DragSession {
  drag: DragInfo | null;
  /**
   * Initial pointer coords at the moment drag began. Lets the ghost mount at
   * the right place before the first pointermove update — important on touch
   * where the finger is often still for a beat after long-press fires.
   */
  ghostStart: { x: number; y: number } | null;
  dropTarget: { id: EditorId; position: DropPosition } | null;
  ghostRef: RefObject<HTMLDivElement>;
  setDrag: (info: DragInfo | null) => void;
  setGhostStart: (pos: { x: number; y: number } | null) => void;
  setDropTarget: (target: { id: EditorId; position: DropPosition } | null) => void;
}

const DragContext = createContext<DragSession>({
  drag: null,
  ghostStart: null,
  dropTarget: null,
  ghostRef: { current: null as unknown as HTMLDivElement },
  setDrag: () => {},
  setGhostStart: () => {},
  setDropTarget: () => {},
});

/** Long-press threshold before a touch turns into a drag (ms). */
const LONG_PRESS_MS = 350;
/** Movement budget during the long-press window before we abandon (px). */
const TOUCH_CANCEL_TOLERANCE = 8;
/** Movement that promotes a mouse press to a drag (px). */
const MOUSE_DRAG_THRESHOLD = 4;
/** CSS class added to <body> while a drag is active. Suppresses scrolling
 *  and text selection across the page so the finger can't accidentally pan. */
const BODY_DRAG_CLASS = "dnd-active";

/** What kind of list this node exposes for its children. */
function childParentKind(node: AnyComponent): ParentKind | null {
  if (isContainer(node)) return "container";
  if (isSection(node)) return "section";
  if (isActionRow(node)) return "actionRow";
  return null;
}

/**
 * Drop-time view of a row, read from its data-* attributes. We rely on data
 * attributes (not React state) because pointer capture means only the source
 * row receives pointer events — to identify the row under the pointer we go
 * via `document.elementFromPoint`, which gives us a DOM node, not a React
 * instance.
 */
interface RowData {
  id: EditorId;
  parentKind: ParentKind | null;
  parentId: EditorId | null;
  siblingIndex: number;
  nodeType: ComponentTypeValue;
}

function readRowData(el: Element): RowData | null {
  const id = el.getAttribute("data-row-id");
  if (!id) return null;
  const rawKind = el.getAttribute("data-parent-kind") ?? "";
  const parentKind: ParentKind | null =
    rawKind === "top" ||
    rawKind === "container" ||
    rawKind === "section" ||
    rawKind === "actionRow" ||
    rawKind === "gallery"
      ? rawKind
      : null;
  const rawParentId = el.getAttribute("data-parent-id") ?? "";
  const siblingIndex = Number.parseInt(el.getAttribute("data-sibling-index") ?? "-1", 10);
  const nodeType = Number.parseInt(
    el.getAttribute("data-node-type") ?? "0",
    10,
  ) as ComponentTypeValue;
  return {
    id,
    parentKind,
    parentId: rawParentId === "" ? null : rawParentId,
    siblingIndex,
    nodeType,
  };
}

/**
 * Which drop positions are legal when the given source lands on the given
 * target row?
 *
 *  - Same-parent reorder is always allowed (before/after the target row).
 *  - Cross-parent moves are accepted only between `top` ↔ `container`, and a
 *    Container can't nest inside another Container.
 *  - The `into` position fires when the target row itself is a Container the
 *    source can legally become a child of.
 */
function computeAllowedPositions(
  source: {
    id: EditorId;
    type: ComponentTypeValue;
    parentKind: ParentKind;
    parentId: EditorId | null;
  },
  target: RowData,
): DropPosition[] {
  if (target.id === source.id) return [];
  const out: DropPosition[] = [];

  // before / after — depend on whether `source` can become a sibling of target.
  const sameParent =
    target.parentKind !== null &&
    target.parentKind === source.parentKind &&
    target.parentId === source.parentId;
  if (sameParent) {
    out.push("before", "after");
  } else if (
    (target.parentKind === "top" || target.parentKind === "container") &&
    (source.parentKind === "top" || source.parentKind === "container")
  ) {
    if (!(target.parentKind === "container" && source.type === ComponentType.Container)) {
      out.push("before", "after");
    }
  }

  // into — target row IS a container the source can join.
  if (
    target.nodeType === ComponentType.Container &&
    source.type !== ComponentType.Container &&
    (source.parentKind === "top" || source.parentKind === "container")
  ) {
    out.push("into");
  }

  return out;
}

export function ComponentTree() {
  const components = useMessageStore((s) => s.message.components);
  const addTopLevel = useMessageStore((s) => s.addTopLevel);
  const selectedId = useMessageStore((s) => s.selectedId);
  const select = useMessageStore((s) => s.select);
  const atLimit = components.length >= LIMITS.TOP_LEVEL_COMPONENTS;

  // Clicking empty tree space — not a row (rows stop propagation), its inline
  // editor, or a meta-header control — clears the selection. This collapses
  // any open inspector, minimizing the tree back to its bare outline.
  const clearSelectionOnBackdrop = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (
        (e.target as HTMLElement).closest(
          "[data-tree-row], input, textarea, select, button, label, a, summary",
        )
      )
        return;
      if (selectedId !== null) select(null);
    },
    [selectedId, select],
  );

  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [ghostStart, setGhostStart] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<DragSession["dropTarget"]>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const dragSession = useMemo<DragSession>(
    () => ({
      drag,
      ghostStart,
      dropTarget,
      ghostRef,
      setDrag,
      setGhostStart,
      setDropTarget,
    }),
    [drag, ghostStart, dropTarget],
  );

  // Toggle the body class so global CSS can clamp touch-action / user-select
  // while a drag is in flight, then restore on cleanup. This is what stops a
  // finger drag from being interpreted as a page scroll mid-gesture.
  useEffect(() => {
    if (!drag) return;
    document.body.classList.add(BODY_DRAG_CLASS);
    return () => document.body.classList.remove(BODY_DRAG_CLASS);
  }, [drag]);

  const topLevelIds = useMemo(() => components.map((c) => c._id), [components]);

  return (
    <DragContext.Provider value={dragSession}>
      <div className={styles.tree}>
        <div className={styles.scroll} onClick={clearSelectionOnBackdrop}>
          <MetaHeader />

          {components.length === 0 ? (
            <div className={styles.empty}>
              <p>Nothing here yet. Add your first component to get started.</p>
            </div>
          ) : (
            <ul className={cn(styles.list, styles.topList)}>
              {components.map((c, idx) => (
                <TreeNode
                  key={c._id}
                  node={c}
                  parentKind="top"
                  parentId={null}
                  parentSiblingIds={topLevelIds}
                  siblingIndex={idx}
                />
              ))}
            </ul>
          )}
        </div>

        <div className={styles.footer}>
          <AddComponentMenu
            allowed={TOP_LEVEL_PICKER}
            onPick={(t) => addTopLevel(t as TopLevelFactoryKey)}
            disabled={atLimit}
            align="top"
            trigger={({ open }) => (
              <Button
                variant="primary"
                size="sm"
                leadingIcon={open ? <CloseIcon /> : <PlusIcon />}
                fullWidth
                disabled={atLimit}
              >
                {atLimit ? "Top-level limit reached" : open ? "Close" : "Add component"}
              </Button>
            )}
          />
        </div>
      </div>
      <DragGhost />
    </DragContext.Provider>
  );
}

/**
 * Floating chip that mirrors the dragged component. Positioned via direct DOM
 * writes from the source row's pointermove handler — re-rendering on every
 * pixel is wasteful when only `left`/`top` change.
 */
function DragGhost() {
  const { drag, ghostStart, ghostRef } = useContext(DragContext);

  useLayoutEffect(() => {
    if (!drag || !ghostStart || !ghostRef.current) return;
    ghostRef.current.style.left = `${ghostStart.x + 14}px`;
    ghostRef.current.style.top = `${ghostStart.y - 14}px`;
  }, [drag, ghostStart, ghostRef]);

  if (!drag) return null;
  // Gallery images aren't components, so they carry no COMPONENT_META entry —
  // give them a dedicated ghost. Everything else reads from its type meta.
  const isImage = drag.parentKind === "gallery";
  const glyph = isImage ? "▦" : COMPONENT_META[drag.type].glyph;
  const label = isImage ? "Image" : COMPONENT_META[drag.type].label;
  return createPortal(
    <div ref={ghostRef} className={styles.ghost} aria-hidden="true">
      <span className={styles.ghostGlyph}>{glyph}</span>
      <span className={styles.ghostLabel}>{label}</span>
    </div>,
    document.body,
  );
}

function MetaHeader() {
  const username = useMessageStore((s) => s.message.username ?? "");
  const avatar = useMessageStore((s) => s.message.avatar_url ?? "");
  const message = useMessageStore((s) => s.message);
  const setUsername = useMessageStore((s) => s.setUsername);
  const setAvatar = useMessageStore((s) => s.setAvatarUrl);

  const characters = countCharacters(message);
  const components = countComponents(message);

  return (
    <section className={styles.meta} aria-label="Webhook execution overrides">
      <div className={styles.row2}>
        <Field label="Username">
          {(id) => (
            <TextInput
              id={id}
              data-meta-field="username"
              value={username}
              maxLength={LIMITS.WEBHOOK_USERNAME}
              onChange={(e) => setUsername(e.currentTarget.value)}
              placeholder="Leave blank to use the webhook default"
            />
          )}
        </Field>
        <Field label="Avatar URL">
          {(id) => (
            <TextInput
              id={id}
              data-meta-field="avatar"
              type="url"
              value={avatar}
              onChange={(e) => setAvatar(e.currentTarget.value)}
              placeholder="https://…"
            />
          )}
        </Field>
      </div>
      <AdvancedMessageOptions />
      <div className={styles.stats}>
        <span>
          {components} / {LIMITS.TOTAL_COMPONENTS} components
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {characters} / {LIMITS.TOTAL_CHARACTERS} chars
        </span>
      </div>
    </section>
  );
}

interface TreeNodeProps {
  node: AnyComponent;
  /** What kind of list this node lives in. `null` for non-reorderable slots. */
  parentKind: ParentKind | null;
  /** Id of the parent node, or null when this node sits at the top level. */
  parentId: EditorId | null;
  /**
   * Ids of every node in the same sibling array as this one (including this
   * node). `null` means this node isn't part of a reorderable list (e.g. a
   * Section accessory).
   */
  parentSiblingIds: EditorId[] | null;
  /** This node's position within `parentSiblingIds`. -1 when not reorderable. */
  siblingIndex: number;
}

/**
 * Pointer-based drag-and-drop for a single tree row, shared by component rows
 * (`TreeNode`) and gallery-image rows (`GalleryItemNode`).
 *
 * Owns the gesture state machine — long-press to start on touch, a small
 * movement threshold on mouse, a non-passive `touchmove` blocker so the page
 * doesn't scroll mid-drag, and `elementFromPoint` hit-testing to find the row
 * under the pointer. The row-specific bits are injected:
 *  - `dragInfo`  describes the dragged row (id / type / parent).
 *  - `allowed`   decides which drop positions a hovered target accepts.
 *  - `commit`    performs the actual move once the pointer is released.
 *
 * Returns the row's pointer handlers plus the derived drag/drop flags for this
 * row and a `consumeJustDragged` guard the click handler uses to swallow the
 * synthetic click some browsers fire after a drag.
 */
function usePointerDragRow({
  isReorderable,
  dragInfo,
  allowed,
  commit,
}: {
  isReorderable: boolean;
  dragInfo: DragInfo;
  allowed: (target: RowData) => DropPosition[];
  commit: (target: RowData, position: DropPosition) => void;
}) {
  const { drag, dropTarget, ghostRef, setDrag, setGhostStart, setDropTarget } =
    useContext(DragContext);

  interface PointerState {
    pointerId: number;
    startX: number;
    startY: number;
    isDragging: boolean;
    longPressTimer: number | null;
    /**
     * Non-passive `touchmove` listener attached to document for the lifetime
     * of this touch gesture. React's own pointer/touch listeners are passive,
     * so `e.preventDefault()` inside onPointerMove can't actually suppress the
     * browser's scroll interpretation — we have to do it from a listener we
     * registered with `{ passive: false }`. Without this, iOS/Android fire
     * `pointercancel` the moment the finger moves after long-press, which
     * looks to the user like the drag "auto-released".
     */
    touchMoveBlocker: ((ev: TouchEvent) => void) | null;
  }
  const stateRef = useRef<PointerState | null>(null);
  const lastDropRef = useRef<{ id: EditorId; position: DropPosition } | null>(null);
  const justDraggedRef = useRef(false);

  const releasePointerState = useCallback((state: PointerState) => {
    if (state.longPressTimer !== null) {
      window.clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
    }
    if (state.touchMoveBlocker) {
      document.removeEventListener("touchmove", state.touchMoveBlocker);
      state.touchMoveBlocker = null;
    }
  }, []);

  const beginDrag = useCallback(
    (startX: number, startY: number) => {
      setGhostStart({ x: startX, y: startY });
      setDrag(dragInfo);
    },
    [dragInfo, setDrag, setGhostStart],
  );

  const endDrag = useCallback(
    (doCommit: boolean) => {
      const last = lastDropRef.current;
      if (doCommit && last) {
        const targetEl = document.querySelector(
          `[data-tree-row="true"][data-row-id="${CSS.escape(last.id)}"]`,
        );
        const data = targetEl ? readRowData(targetEl) : null;
        if (data) commit(data, last.position);
      }
      lastDropRef.current = null;
      setDrag(null);
      setGhostStart(null);
      setDropTarget(null);
    },
    [commit, setDrag, setDropTarget, setGhostStart],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isReorderable) return;
      // Don't consume presses that land on action buttons or interactive
      // children inside the row — they need to keep firing click.
      if ((e.target as HTMLElement).closest(`.${styles.actions}`)) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore — some platforms reject capture mid-event */
      }

      const state: PointerState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        isDragging: false,
        longPressTimer: null,
        touchMoveBlocker: null,
      };

      if (e.pointerType === "touch" || e.pointerType === "pen") {
        // Capture coords for the timer closure — React reuses the event.
        const x = e.clientX;
        const y = e.clientY;
        state.longPressTimer = window.setTimeout(() => {
          if (stateRef.current !== state) return; // gesture already ended
          state.longPressTimer = null;
          state.isDragging = true;
          beginDrag(x, y);
          if (typeof navigator.vibrate === "function") {
            try {
              navigator.vibrate(15);
            } catch {
              /* not supported */
            }
          }
        }, LONG_PRESS_MS);

        const blocker = (ev: TouchEvent) => {
          if (stateRef.current === state && state.isDragging && ev.cancelable) {
            ev.preventDefault();
          }
        };
        state.touchMoveBlocker = blocker;
        document.addEventListener("touchmove", blocker, { passive: false });
      }

      stateRef.current = state;
    },
    [beginDrag, isReorderable],
  );

  const updateDropTargetFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const under = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const targetEl = under?.closest('[data-tree-row="true"]');
      if (!targetEl) {
        if (lastDropRef.current !== null) {
          lastDropRef.current = null;
          setDropTarget(null);
        }
        return;
      }
      const targetData = readRowData(targetEl);
      if (!targetData) return;

      const allowedPositions = allowed(targetData);
      if (allowedPositions.length === 0) {
        if (lastDropRef.current !== null) {
          lastDropRef.current = null;
          setDropTarget(null);
        }
        return;
      }

      const rect = (targetEl as HTMLElement).getBoundingClientRect();
      const ratio = (clientY - rect.top) / rect.height;
      const hasInto = allowedPositions.includes("into");
      let position: DropPosition;
      if (hasInto) {
        if (ratio < 0.25 && allowedPositions.includes("before")) position = "before";
        else if (ratio > 0.75 && allowedPositions.includes("after")) position = "after";
        else position = "into";
      } else if (ratio < 0.5 && allowedPositions.includes("before")) {
        position = "before";
      } else if (allowedPositions.includes("after")) {
        position = "after";
      } else {
        position = allowedPositions[0]!;
      }

      const prev = lastDropRef.current;
      if (prev?.id !== targetData.id || prev?.position !== position) {
        lastDropRef.current = { id: targetData.id, position };
        setDropTarget(lastDropRef.current);
      }
    },
    [allowed, setDropTarget],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== e.pointerId) return;

      const adx = Math.abs(e.clientX - state.startX);
      const ady = Math.abs(e.clientY - state.startY);

      if (!state.isDragging) {
        if (state.longPressTimer !== null) {
          // Pre-drag touch: if the finger moves before the long-press fires,
          // we assume the user is trying to scroll. Bail and release capture.
          if (adx > TOUCH_CANCEL_TOLERANCE || ady > TOUCH_CANCEL_TOLERANCE) {
            releasePointerState(state);
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
              /* ignore */
            }
            stateRef.current = null;
          }
          return;
        }
        if (
          e.pointerType === "mouse" &&
          (adx > MOUSE_DRAG_THRESHOLD || ady > MOUSE_DRAG_THRESHOLD)
        ) {
          state.isDragging = true;
          beginDrag(e.clientX, e.clientY);
        } else {
          return;
        }
      }

      // We're dragging. Block native gestures associated with this pointer.
      e.preventDefault();

      // Move the ghost imperatively — re-rendering the whole tree on every
      // pixel of motion would be wasteful.
      if (ghostRef.current) {
        ghostRef.current.style.left = `${e.clientX + 14}px`;
        ghostRef.current.style.top = `${e.clientY - 14}px`;
      }

      updateDropTargetFromPointer(e.clientX, e.clientY);
    },
    [beginDrag, ghostRef, releasePointerState, updateDropTargetFromPointer],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      releasePointerState(state);
      if (state.isDragging) {
        endDrag(true);
        justDraggedRef.current = true;
      }
      stateRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [endDrag, releasePointerState],
  );

  const onPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      releasePointerState(state);
      if (state.isDragging) {
        endDrag(false);
      }
      stateRef.current = null;
    },
    [endDrag, releasePointerState],
  );

  // Unmount cleanup: clear any pending long-press timer and detach the
  // touchmove blocker so neither can fire against an unmounted component.
  useEffect(() => {
    return () => {
      const state = stateRef.current;
      if (state) releasePointerState(state);
    };
  }, [releasePointerState]);

  const consumeJustDragged = useCallback(() => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return true;
    }
    return false;
  }, []);

  const id = dragInfo.id;
  return {
    isDragging: drag?.id === id,
    showDropBefore: !!drag && dropTarget?.id === id && dropTarget.position === "before",
    showDropAfter: !!drag && dropTarget?.id === id && dropTarget.position === "after",
    showDropInto: !!drag && dropTarget?.id === id && dropTarget.position === "into",
    consumeJustDragged,
    pointerHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}

function TreeNode({ node, parentKind, parentId, parentSiblingIds, siblingIndex }: TreeNodeProps) {
  // Subscribe to just this row's selected state so changing the selection only
  // re-renders the two rows whose highlight flips, not every row in the tree.
  const isSelected = useMessageStore((s) => s.selectedId === node._id);
  const select = useMessageStore((s) => s.select);
  const moveSibling = useMessageStore((s) => s.moveSibling);
  const moveToParent = useMessageStore((s) => s.moveToParent);
  const remove = useMessageStore((s) => s.remove);
  const duplicate = useMessageStore((s) => s.duplicate);
  const addContainerChild = useMessageStore((s) => s.addContainerChild);
  const addSectionText = useMessageStore((s) => s.addSectionText);
  const addRowButton = useMessageStore((s) => s.addRowButton);
  const addRowSelect = useMessageStore((s) => s.addRowSelect);
  const addGalleryItem = useMessageStore((s) => s.addGalleryItem);
  const meta = COMPONENT_META[node.type];

  const { siblings, extras } = childGroups(node);
  const siblingIds = useMemo(() => siblings.map((c) => c._id), [siblings]);
  const ownChildKind = childParentKind(node);
  const adders = collectAdders(node, {
    addContainerChild,
    addSectionText,
    addRowButton,
    addRowSelect,
    addGalleryItem,
  });
  // Media-gallery images render as their own child rows (like Section texts),
  // so they can be selected, collapsed/expanded, reordered, and removed.
  const galleryItems =
    node.type === ComponentType.MediaGallery ? (node as MediaGalleryComponent).items : null;
  const hasNested =
    siblings.length > 0 ||
    extras.length > 0 ||
    adders.length > 0 ||
    (galleryItems?.length ?? 0) > 0;

  const isReorderable = parentSiblingIds !== null && parentKind !== null;

  // A node is "stuck" at an edge only when there's truly nowhere for it to go.
  // Container children at the edge of their sibling list can still pop out to
  // the grandparent (see `moveSibling`), so they keep both arrows.
  const lastSiblingIndex = parentSiblingIds ? parentSiblingIds.length - 1 : -1;
  const canMoveUp = isReorderable && (siblingIndex > 0 || parentKind === "container");
  const canMoveDown =
    isReorderable && (siblingIndex < lastSiblingIndex || parentKind === "container");

  const dragInfo = useMemo<DragInfo>(
    () => ({ id: node._id, type: node.type, parentKind: parentKind ?? "top", parentId }),
    [node._id, node.type, parentKind, parentId],
  );
  const allowed = useCallback(
    (target: RowData) => computeAllowedPositions(dragInfo, target),
    [dragInfo],
  );
  const commit = useCallback(
    (target: RowData, position: DropPosition) => {
      if (position === "into") {
        // Append. The store clamps `targetIndex` to the container's length.
        moveToParent(node._id, target.id, Number.MAX_SAFE_INTEGER);
      } else {
        const idx = target.siblingIndex + (position === "after" ? 1 : 0);
        moveToParent(node._id, target.parentId, idx);
      }
    },
    [moveToParent, node._id],
  );
  const {
    isDragging,
    showDropBefore,
    showDropAfter,
    showDropInto,
    consumeJustDragged,
    pointerHandlers,
  } = usePointerDragRow({ isReorderable, dragInfo, allowed, commit });

  const onRowClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      // A completed drag also fires a click on the source row in some
      // browsers — swallow that so the row isn't accidentally selected.
      if (consumeJustDragged()) return;
      // Click the already-open row again to minimize it — clearing the
      // selection and collapsing the inline inspector.
      if (isSelected) {
        select(null);
        return;
      }
      // Click an unselected row to select it, then (desktop only) scroll the
      // preview to the matching rendered component — the mirror of the
      // preview→tree scroll in ComponentRenderer. On mobile the preview is a
      // hidden bottom sheet, so there's nothing to bring into view. Deferred a
      // frame so the freshly-revealed inline inspector has settled the layout
      // before `scrollIntoView` measures positions.
      select(node._id);
      if (window.matchMedia("(max-width: 900px)").matches) return;
      const targetId = node._id;
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            `[data-preview-scroll] [data-node-id="${CSS.escape(targetId)}"]`,
          )
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    },
    [consumeJustDragged, isSelected, node._id, select],
  );

  return (
    <li>
      <div
        className={cn(
          styles.row,
          isSelected && styles.rowSelected,
          isDragging && styles.rowDragging,
          showDropBefore && styles.rowDropBefore,
          showDropAfter && styles.rowDropAfter,
          showDropInto && styles.rowDropInto,
        )}
        // Data attributes drive drop-target resolution: the source's
        // pointermove uses `document.elementFromPoint` + `closest()` to find
        // a row, then reads these to validate and place the drop.
        data-tree-row="true"
        data-row-id={node._id}
        data-parent-kind={parentKind ?? ""}
        data-parent-id={parentId ?? ""}
        data-sibling-index={siblingIndex}
        data-node-type={node.type}
        {...pointerHandlers}
        onClick={onRowClick}
      >
        <span className={styles.chevron} aria-hidden="true">
          {isSelected ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        </span>
        <span className={styles.glyph} aria-hidden="true">
          {meta.glyph}
        </span>
        <span className={styles.label}>{meta.label}</span>
        <span className={styles.summary}>{summarize(node)}</span>

        <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
          {canMoveUp ? (
            <IconButton size="sm" label="Move up" onClick={() => moveSibling(node._id, -1)}>
              <ArrowUpIcon size={12} />
            </IconButton>
          ) : null}
          {canMoveDown ? (
            <IconButton size="sm" label="Move down" onClick={() => moveSibling(node._id, 1)}>
              <ArrowDownIcon size={12} />
            </IconButton>
          ) : null}
          <IconButton size="sm" label="Duplicate" onClick={() => duplicate(node._id)}>
            <CopyIcon size={12} />
          </IconButton>
          <IconButton size="sm" variant="danger" label="Delete" onClick={() => remove(node._id)}>
            <TrashIcon size={12} />
          </IconButton>
        </div>
      </div>

      {isSelected ? (
        <div className={styles.editorPanel} onClick={(e) => e.stopPropagation()}>
          <Inspector />
        </div>
      ) : null}

      {hasNested ? (
        <ul className={styles.list}>
          {galleryItems?.map((item, idx) => (
            <GalleryItemNode
              key={item._id}
              galleryId={node._id}
              item={item}
              index={idx}
              total={galleryItems.length}
            />
          ))}
          {siblings.map((child, idx) => (
            <TreeNode
              key={(child as { _id: EditorId })._id}
              node={child}
              parentKind={ownChildKind}
              parentId={node._id}
              parentSiblingIds={siblingIds}
              siblingIndex={idx}
            />
          ))}
          {extras.map((child) => (
            <TreeNode
              key={(child as { _id: EditorId })._id}
              node={child}
              parentKind={null}
              parentId={node._id}
              parentSiblingIds={null}
              siblingIndex={-1}
            />
          ))}
          {adders}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * A single gallery image rendered as a tree row, mirroring `TreeNode`'s look
 * and affordances (chevron, glyph, up/down/duplicate/delete) but operating on
 * a `MediaGalleryItem` instead of a component. Hold-and-drag reordering uses
 * the same `usePointerDragRow` engine as component rows, scoped to sibling
 * images of the same gallery.
 */
function GalleryItemNode({
  galleryId,
  item,
  index,
  total,
}: {
  galleryId: EditorId;
  item: MediaGalleryItem;
  index: number;
  total: number;
}) {
  const isSelected = useMessageStore((s) => s.selectedId === item._id);
  const select = useMessageStore((s) => s.select);
  const moveGalleryItem = useMessageStore((s) => s.moveGalleryItem);
  const moveGalleryItemToIndex = useMessageStore((s) => s.moveGalleryItemToIndex);
  const removeGalleryItem = useMessageStore((s) => s.removeGalleryItem);
  const duplicateGalleryItem = useMessageStore((s) => s.duplicateGalleryItem);

  const canMoveUp = index > 0;
  const canMoveDown = index < total - 1;
  const canDuplicate = total < LIMITS.GALLERY_ITEMS;
  const canRemove = total > 1;

  // Drag-and-drop reorder, sharing the component-row gesture engine. The
  // `"gallery"` parent kind makes `computeAllowedPositions` permit before/after
  // drops only among sibling images of the same gallery.
  const dragInfo = useMemo<DragInfo>(
    () => ({
      id: item._id,
      type: ComponentType.MediaGallery,
      parentKind: "gallery",
      parentId: galleryId,
    }),
    [item._id, galleryId],
  );
  const allowed = useCallback(
    (target: RowData) => computeAllowedPositions(dragInfo, target),
    [dragInfo],
  );
  const commit = useCallback(
    (target: RowData, position: DropPosition) => {
      const idx = target.siblingIndex + (position === "after" ? 1 : 0);
      moveGalleryItemToIndex(galleryId, item._id, idx);
    },
    [moveGalleryItemToIndex, galleryId, item._id],
  );
  const {
    isDragging,
    showDropBefore,
    showDropAfter,
    showDropInto,
    consumeJustDragged,
    pointerHandlers,
  } = usePointerDragRow({ isReorderable: true, dragInfo, allowed, commit });

  const onRowClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    // Swallow the synthetic click a finished drag fires on the source row.
    if (consumeJustDragged()) return;
    // Click the open row again to collapse it.
    if (isSelected) {
      select(null);
      return;
    }
    select(item._id);
    // Desktop: mirror the row→preview scroll TreeNode does, landing on this
    // image's rendered figure. On mobile the preview is a hidden sheet.
    if (window.matchMedia("(max-width: 900px)").matches) return;
    const targetId = item._id;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-preview-scroll] [data-node-id="${CSS.escape(targetId)}"]`,
        )
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <li>
      <div
        className={cn(
          styles.row,
          isSelected && styles.rowSelected,
          isDragging && styles.rowDragging,
          showDropBefore && styles.rowDropBefore,
          showDropAfter && styles.rowDropAfter,
          showDropInto && styles.rowDropInto,
        )}
        data-tree-row="true"
        data-row-id={item._id}
        data-parent-kind="gallery"
        data-parent-id={galleryId}
        data-sibling-index={index}
        {...pointerHandlers}
        onClick={onRowClick}
      >
        <span className={styles.chevron} aria-hidden="true">
          {isSelected ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        </span>
        <span className={styles.glyph} aria-hidden="true">
          ▦
        </span>
        <span className={styles.label}>Image</span>
        <span className={styles.summary}>{summarizeGalleryItem(item)}</span>

        <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
          {canMoveUp ? (
            <IconButton
              size="sm"
              label="Move up"
              onClick={() => moveGalleryItem(galleryId, item._id, -1)}
            >
              <ArrowUpIcon size={12} />
            </IconButton>
          ) : null}
          {canMoveDown ? (
            <IconButton
              size="sm"
              label="Move down"
              onClick={() => moveGalleryItem(galleryId, item._id, 1)}
            >
              <ArrowDownIcon size={12} />
            </IconButton>
          ) : null}
          <IconButton
            size="sm"
            label="Duplicate"
            disabled={!canDuplicate}
            onClick={() => duplicateGalleryItem(galleryId, item._id)}
          >
            <CopyIcon size={12} />
          </IconButton>
          {canRemove ? (
            <IconButton
              size="sm"
              variant="danger"
              label="Delete image"
              onClick={() => removeGalleryItem(galleryId, item._id)}
            >
              <TrashIcon size={12} />
            </IconButton>
          ) : null}
        </div>
      </div>

      {isSelected ? (
        <div className={styles.editorPanel} onClick={(e) => e.stopPropagation()}>
          <GalleryItemInspector galleryId={galleryId} item={item} />
        </div>
      ) : null}
    </li>
  );
}

/** Short right-aligned summary for a gallery image row: its filename or state. */
function summarizeGalleryItem(item: MediaGalleryItem): string {
  const url = item.media.url?.trim();
  if (url) {
    const withoutQuery = url.split(/[?#]/)[0] ?? url;
    const segment = withoutQuery.split("/").filter(Boolean).pop();
    return segment || url;
  }
  if (item.media.attachment_id) return `attachment ${item.media.attachment_id}`;
  return "No image set";
}

interface AdderHandlers {
  addContainerChild: (id: EditorId, type: ContainerChildFactoryKey) => void;
  addSectionText: (id: EditorId) => void;
  addRowButton: (id: EditorId) => void;
  addRowSelect: (id: EditorId, type: SelectComponent["type"]) => void;
  addGalleryItem: (id: EditorId) => void;
}

function collectAdders(node: AnyComponent, h: AdderHandlers): ReactNode[] {
  const out: ReactNode[] = [];

  if (isContainer(node)) {
    out.push(
      <li key="__add_container" className={styles.adderItem}>
        <AddComponentMenu
          allowed={CONTAINER_PICKER}
          disabled={node.components.length >= LIMITS.CONTAINER_CHILDREN}
          onPick={(t) => h.addContainerChild(node._id, t as ContainerChildFactoryKey)}
          trigger={<AddChildButton label="Add to container" />}
        />
      </li>,
    );
  }

  if (isSection(node) && (node as SectionComponent).components.length < LIMITS.SECTION_TEXTS_MAX) {
    out.push(
      <li key="__add_section_text" className={styles.adderItem}>
        <AddChildButton label="Add text" onClick={() => h.addSectionText(node._id)} />
      </li>,
    );
  }

  if (isActionRow(node)) {
    const row = node;
    if (!isSelectRow(row)) {
      if (row.components.length < LIMITS.ACTION_ROW_BUTTONS && !row.components.some(isSelect)) {
        out.push(
          <li key="__add_row_button" className={styles.adderItem}>
            <AddChildButton label="Add button" onClick={() => h.addRowButton(node._id)} />
          </li>,
        );
      }
      if (row.components.length === 0) {
        out.push(
          <li key="__add_row_select" className={styles.adderItem}>
            <AddComponentMenu
              allowed={ROW_SELECT_PICKER}
              onPick={(t) => h.addRowSelect(node._id, t as SelectComponent["type"])}
              trigger={<AddChildButton label="Add select…" />}
            />
          </li>,
        );
      }
    }
  }

  if (
    node.type === ComponentType.MediaGallery &&
    (node as MediaGalleryComponent).items.length < LIMITS.GALLERY_ITEMS
  ) {
    out.push(
      <li key="__add_gallery_item" className={styles.adderItem}>
        <AddChildButton
          label="Add image"
          onClick={() => {
            // addGalleryItem appends the image and selects it; scroll its new
            // row into view so it's ready to edit.
            h.addGalleryItem(node._id);
            const newId = useMessageStore.getState().selectedId;
            if (newId) scrollTreeRowIntoView(newId);
          }}
        />
      </li>,
    );
  }

  return out;
}

const AddChildButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    onClick?: () => void;
    "aria-haspopup"?: AriaAttributes["aria-haspopup"];
    "aria-expanded"?: AriaAttributes["aria-expanded"];
    "aria-controls"?: string;
  }
>(function AddChildButton({ label, onClick, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={styles.addChild} onClick={onClick} {...rest}>
      <span className={styles.addChildPlus} aria-hidden="true">
        +
      </span>
      <span>{label}</span>
    </button>
  );
});

/**
 * Split a node's children into the reorderable sibling array (`siblings`) and
 * non-reorderable extras like a Section's accessory (`extras`). The tree
 * renders both, but only `siblings` participates in drag-and-drop.
 */
function childGroups(node: AnyComponent): {
  siblings: AnyComponent[];
  extras: AnyComponent[];
} {
  if (isContainer(node)) return { siblings: node.components, extras: [] };
  if (isSection(node)) return { siblings: [...node.components], extras: [node.accessory] };
  if (isActionRow(node)) return { siblings: [...node.components], extras: [] };
  return { siblings: [], extras: [] };
}

function summarize(node: AnyComponent): string {
  if (node.type === ComponentType.TextDisplay) {
    const t = node.content.replace(/\s+/g, " ").trim();
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  }
  if (node.type === ComponentType.Container) {
    const cc = (node as ContainerComponent).components.length;
    return `${cc} ${cc === 1 ? "child" : "children"}`;
  }
  if (node.type === ComponentType.MediaGallery) {
    const n = (node as MediaGalleryComponent).items.length;
    return `${n} ${n === 1 ? "image" : "images"}`;
  }
  if (node.type === ComponentType.ActionRow) {
    const row = node as ActionRowComponent;
    if (isSelectRow(row)) return "1 select";
    const n = row.components.length;
    return `${n} ${n === 1 ? "button" : "buttons"}`;
  }
  if (node.type === ComponentType.Button) {
    return "label" in node ? (node.label ?? "") : "";
  }
  if (isSelect(node)) {
    return node.custom_id || "";
  }
  return "";
}
