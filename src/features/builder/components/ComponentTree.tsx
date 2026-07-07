/**
 * Hierarchical view of the message's components.
 *
 * Each row carries its node's id in a `data-node-id` attribute and uses the
 * store's `select` action on click. Reordering happens through the store
 * (`moveSibling` for the inline up/down buttons, `moveToParent` /
 * `moveGalleryItemToGallery` for drag-and-drop) so the preview stays in
 * lockstep with the tree without intermediate state. Drag-and-drop supports
 * same-parent reorders plus cross-parent moves between any two lists of the
 * same kind: top-level ↔ Container, an image to another gallery, a text to
 * another section, and a button to another buttons row.
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
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useMessageStore } from "@/core/state/messageStore";
import { useNodeEditors, type NodeEditor } from "@/core/activity/presence";
import { Avatar } from "@/activity/Avatar";
import { addThenScroll, scrollPreviewNodeIntoView } from "@/features/builder/scrollTreeRow";
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
  ThumbnailComponent,
} from "@/core/schema/types";
import { ComponentType } from "@/core/schema/types";
import { registerAttachment } from "@/core/state/attachmentStore";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { IconButton } from "@/ui/IconButton";
import { PlaceholderInput } from "@/ui/PlaceholderInput";
import { useMessagePlaceholders } from "@/features/builder/useMessagePlaceholders";
import { AddComponentMenu, type AddMenuNode } from "./AddComponentMenu";
import { MessageOptions } from "./MessageOptions";
import { PostedMessageBanner } from "../PostedMessageBanner";
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
import { pushToast } from "@/ui/Toast";
import {
  ValidationContext,
  useMergedValidationView,
  useNodeIssues,
  useValidationSummary,
  worstSeverity,
} from "@/features/builder/useValidation";
import { useFileDrop } from "./useFileDrop";
import { addFilesToGallery, replaceGalleryItemFiles } from "./galleryUpload";
import { Inspector } from "./Inspector";
import { GalleryItemInspector } from "./inspectors/GalleryItemInspector";
import { HeaderIssueChip } from "./HeaderIssueChip";
import { IssueDot, IssueList } from "./ValidationIssues";
import styles from "./ComponentTree.module.css";
import type { ContainerChildFactoryKey } from "@/core/factory/createComponent";

/**
 * Drag-and-drop session shared across every TreeNode. Only one node can be
 * dragged at a time; the active drop indicator lives here so a row can render
 * the caret regardless of where the source originated.
 *
 * Cross-parent moves are allowed between any two lists of the same kind:
 * top-level ↔ Container, image → another gallery, text → another section, and
 * button → another buttons row. Each TreeNode receives a `parentKind` so it
 * can validate drops without re-walking the tree.
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
  /**
   * The tree's scrolling viewport. Drag rows use it to auto-scroll the list
   * when the pointer nears an edge, so a node can be dragged past the visible
   * window of a long tree without letting go.
   */
  scrollRef: RefObject<HTMLDivElement>;
  setDrag: (info: DragInfo | null) => void;
  setGhostStart: (pos: { x: number; y: number } | null) => void;
  setDropTarget: (target: { id: EditorId; position: DropPosition } | null) => void;
}

const DragContext = createContext<DragSession>({
  drag: null,
  ghostStart: null,
  dropTarget: null,
  ghostRef: { current: null as unknown as HTMLDivElement },
  scrollRef: { current: null as unknown as HTMLDivElement },
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
/** Distance from the scroll viewport's top/bottom edge, in px, where a drag
 *  starts auto-scrolling the tree. */
const AUTO_SCROLL_EDGE = 60;
/** Peak auto-scroll speed (px per animation frame) reached at the very edge.
 *  Speed ramps from 0 at the zone's inner boundary to this at the edge. */
const AUTO_SCROLL_MAX_SPEED = 18;

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

type DragSource = {
  id: EditorId;
  type: ComponentTypeValue;
  parentKind: ParentKind;
  parentId: EditorId | null;
};

/**
 * Can `source` be appended *into* `target` when the pointer lands on the
 * target row itself (rather than between rows)? This covers both collapsed and
 * empty parents — e.g. dropping a button onto an empty Buttons Row — and the
 * natural "drop on the header" gesture. Capacity isn't checked here; the store
 * is the final arbiter and silently no-ops an over-capacity drop.
 *
 *  - Container → any top-level-ish component except another Container
 *    (top ↔ container interop).
 *  - Section / ActionRow / MediaGallery → a child of the same specialized kind
 *    coming from a *different* parent of that kind (text→Section,
 *    button→ActionRow, image→MediaGallery).
 */
function canDropInto(source: DragSource, target: RowData): boolean {
  switch (target.nodeType) {
    case ComponentType.Container:
      return (
        source.type !== ComponentType.Container &&
        (source.parentKind === "top" || source.parentKind === "container")
      );
    case ComponentType.Section:
      return source.parentKind === "section";
    case ComponentType.ActionRow:
      return source.parentKind === "actionRow" && source.type === ComponentType.Button;
    case ComponentType.MediaGallery:
      return source.parentKind === "gallery";
    default:
      return false;
  }
}

/**
 * Which drop positions are legal when the given source lands on the given
 * target row?
 *
 *  - Same-parent reorder is always allowed (before/after the target row).
 *  - Cross-parent before/after is allowed between two lists of the same kind:
 *    `top` ↔ `container` interop (a Container can't nest in a Container),
 *    image → another gallery, text → another section, and button → another
 *    buttons row (selects don't move and never sit beside a button).
 *  - The `into` position fires when the target row itself is a parent the
 *    source can be appended into (see `canDropInto`).
 */
function computeAllowedPositions(source: DragSource, target: RowData): DropPosition[] {
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
  } else if (target.parentKind === source.parentKind) {
    // Cross-parent move between two lists of the same specialized kind.
    if (source.parentKind === "gallery" || source.parentKind === "section") {
      out.push("before", "after");
    } else if (
      source.parentKind === "actionRow" &&
      source.type === ComponentType.Button &&
      target.nodeType === ComponentType.Button
    ) {
      out.push("before", "after");
    }
  }

  // into — target row IS a parent the source can join.
  if (canDropInto(source, target)) out.push("into");

  return out;
}

export function ComponentTree() {
  const components = useMessageStore((s) => s.message.components);
  const addTopLevelComponent = useMessageStore((s) => s.addTopLevelComponent);
  const addTopLevelSection = useMessageStore((s) => s.addTopLevelSection);
  const atLimit = components.length >= LIMITS.TOP_LEVEL_COMPONENTS;

  // Top-level add menu. Most entries add their component directly; "Section" and
  // "Buttons Row" are expandable parents whose label adds the plain wrapper and
  // whose children add a specific variant (accessory kind / button or select).
  const topLevelNodes = useMemo<AddMenuNode[]>(() => {
    const add = (t: ComponentTypeValue) => addThenScroll(() => addTopLevelComponent(t));
    return TOP_LEVEL_PICKER.map((t) => {
      // "Section" and "Buttons Row" are group headers: clicking expands to the
      // variants below; they add nothing on their own.
      if (t === ComponentType.Section) {
        return {
          type: t,
          children: [
            {
              type: ComponentType.Thumbnail,
              onPick: () => addThenScroll(() => addTopLevelSection("thumbnail")),
            },
            {
              type: ComponentType.Button,
              onPick: () => addThenScroll(() => addTopLevelSection("button")),
            },
          ],
        };
      }
      if (t === ComponentType.ActionRow) {
        return {
          type: t,
          children: [ComponentType.Button, ...ROW_SELECT_PICKER].map((ct) => ({
            type: ct,
            onPick: () => add(ct),
          })),
        };
      }
      return { type: t, onPick: () => add(t) };
    });
  }, [addTopLevelComponent, addTopLevelSection]);

  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [ghostStart, setGhostStart] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<DragSession["dropTarget"]>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragSession = useMemo<DragSession>(
    () => ({
      drag,
      ghostStart,
      dropTarget,
      ghostRef,
      scrollRef,
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

  // One validation pass for the whole tree, shared via context so each row is a
  // cheap map lookup instead of its own re-validation. The plugin guild checks
  // are folded in (not in `validateMessage`, which is pure) so a wrong-server
  // binding gets the same tree-dot + inspector-banner as any issue. The header's
  // issue chip reads this same merged view via `useMergedValidationView`.
  const validation = useMergedValidationView();

  return (
    <ValidationContext.Provider value={validation}>
      <DragContext.Provider value={dragSession}>
        <div className={styles.tree}>
          <div ref={scrollRef} className={styles.scroll}>
            <PostedMessageBanner />
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

          {/* The one validation indicator: a pill floating at the pane's
              top-right, just under the action bar. Docked here (not in the action
              bar) so it's shared verbatim by the web and Activity editors and
              never crowds the bar's controls. Self-hides when the message is clean. */}
          <div className={styles.issueDock}>
            <HeaderIssueChip view={validation} />
          </div>

          <div className={styles.footer}>
            <AddComponentMenu
              nodes={topLevelNodes}
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
    </ValidationContext.Provider>
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
  const placeholders = useMessagePlaceholders();

  // Both walk the whole tree. Keyed on `message` so a drag (which re-renders
  // this header via its parent on every pointermove) doesn't re-walk the tree —
  // only an actual message change recomputes.
  const characters = useMemo(() => countCharacters(message), [message]);
  const components = useMemo(() => countComponents(message), [message]);

  // The at-a-glance issue *count* now lives in the header bar's chip (shared with
  // the Activity bar); here we only surface message-level problems that have no
  // component to point at (bad mentions, …) as a readable banner. "A message must
  // contain at least one component" is already covered by the empty-tree
  // placeholder, so drop it to avoid saying it twice.
  const { messageIssues } = useValidationSummary();
  const bannerIssues = messageIssues.filter((i) => i.code !== "EMPTY_MESSAGE");

  return (
    <section className={styles.meta} aria-label="Webhook execution overrides">
      {bannerIssues.length > 0 ? <IssueList issues={bannerIssues} /> : null}

      <div className={styles.row2}>
        <Field label="Username">
          {(id) => (
            <PlaceholderInput
              id={id}
              data-meta-field="username"
              value={username}
              maxLength={LIMITS.WEBHOOK_USERNAME}
              placeholders={placeholders}
              onChange={(value) => setUsername(value)}
              placeholder="Leave blank to use the webhook default"
            />
          )}
        </Field>
        <Field label="Avatar URL">
          {(id) => (
            <PlaceholderInput
              id={id}
              data-meta-field="avatar"
              type="url"
              value={avatar}
              placeholders={placeholders}
              onChange={(value) => setAvatar(value)}
              placeholder="https://… or {server_icon}"
            />
          )}
        </Field>
      </div>
      <MessageOptions />
      <div className={styles.metaFooter}>
        <div className={styles.stats}>
          <StatPill
            value={components}
            max={LIMITS.TOTAL_COMPONENTS}
            label={components === 1 ? "component" : "components"}
          />
          <StatPill
            value={characters}
            max={LIMITS.TOTAL_CHARACTERS}
            label={characters === 1 ? "char" : "chars"}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * A budget pill that shifts from neutral → amber → red as the count nears its
 * Discord limit, so the user sees message health at a glance instead of parsing
 * raw numbers. "Near" trips at 85% of the cap; "full" once the cap is hit.
 */
function StatPill({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? value / max : 0;
  return (
    <span
      className={cn(
        styles.statPill,
        ratio >= 1 ? styles.statPillFull : ratio >= 0.85 ? styles.statPillNear : null,
      )}
    >
      {value} / {max} {label}
    </span>
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
  const { drag, dropTarget, ghostRef, scrollRef, setDrag, setGhostStart, setDropTarget } =
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
  // Last known pointer position (viewport coords), kept current while dragging
  // so the auto-scroll loop can re-hit-test the row under a stationary pointer.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  // Handle of the in-flight auto-scroll rAF, or null when idle.
  const autoScrollRef = useRef<number | null>(null);
  // Latest hit-test fn, so the rAF loop can invoke it without listing it as a
  // dependency (which would rebuild the loop callback every render).
  const updateDropTargetRef = useRef<(clientX: number, clientY: number) => void>(() => {});

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

  // One animation-frame tick of edge auto-scroll. When the pointer sits within
  // AUTO_SCROLL_EDGE px of the scroll viewport's top or bottom, nudge the
  // scrollTop — faster the closer to the edge — and re-run the hit-test so the
  // drop indicator follows the rows now sliding under a stationary pointer.
  // Reschedules itself; the handle lives in autoScrollRef so endDrag can cancel.
  const runAutoScroll = useCallback(() => {
    const container = scrollRef.current;
    const pointer = lastPointerRef.current;
    if (!container || !pointer) {
      autoScrollRef.current = null;
      return;
    }
    const rect = container.getBoundingClientRect();
    const topGap = pointer.y - rect.top;
    const bottomGap = rect.bottom - pointer.y;
    let delta = 0;
    if (topGap < AUTO_SCROLL_EDGE) {
      const strength = Math.min(1, (AUTO_SCROLL_EDGE - topGap) / AUTO_SCROLL_EDGE);
      delta = -Math.ceil(strength * AUTO_SCROLL_MAX_SPEED);
    } else if (bottomGap < AUTO_SCROLL_EDGE) {
      const strength = Math.min(1, (AUTO_SCROLL_EDGE - bottomGap) / AUTO_SCROLL_EDGE);
      delta = Math.ceil(strength * AUTO_SCROLL_MAX_SPEED);
    }
    if (delta !== 0) {
      const before = container.scrollTop;
      container.scrollTop = before + delta;
      if (container.scrollTop !== before) updateDropTargetRef.current(pointer.x, pointer.y);
    }
    autoScrollRef.current = requestAnimationFrame(runAutoScroll);
  }, [scrollRef]);

  const startAutoScroll = useCallback(() => {
    if (autoScrollRef.current === null) {
      autoScrollRef.current = requestAnimationFrame(runAutoScroll);
    }
  }, [runAutoScroll]);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current !== null) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  }, []);

  const beginDrag = useCallback(
    (startX: number, startY: number) => {
      lastPointerRef.current = { x: startX, y: startY };
      setGhostStart({ x: startX, y: startY });
      setDrag(dragInfo);
      startAutoScroll();
    },
    [dragInfo, setDrag, setGhostStart, startAutoScroll],
  );

  const endDrag = useCallback(
    (doCommit: boolean) => {
      stopAutoScroll();
      lastPointerRef.current = null;
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
    [commit, setDrag, setDropTarget, setGhostStart, stopAutoScroll],
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
  // Keep the auto-scroll loop pointed at the freshest hit-test closure.
  updateDropTargetRef.current = updateDropTargetFromPointer;

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

      // Record the live pointer position for the edge auto-scroll loop, which
      // re-hit-tests from here when the content scrolls under a still pointer.
      lastPointerRef.current = { x: e.clientX, y: e.clientY };

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

  // Unmount cleanup: clear any pending long-press timer, detach the touchmove
  // blocker, and cancel an in-flight auto-scroll frame so none can fire against
  // an unmounted component.
  useEffect(() => {
    return () => {
      const state = stateRef.current;
      if (state) releasePointerState(state);
      stopAutoScroll();
    };
  }, [releasePointerState, stopAutoScroll]);

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

/** Avatars shown on a row before collapsing the rest into a "+N". */
const MAX_PRESENCE = 3;

/**
 * Live "who's editing this block" cluster for a tree row — the visible half of
 * the Activity's per-node presence (see `core/activity/presence`). Renders the
 * other editors currently focused on this node as small avatars, each ringed in
 * that person's colour; the row itself also gets an outline in the first
 * editor's colour (applied by the caller). Returns null when nobody else is
 * here, which is always the case in the web app — so the shared tree pays
 * nothing for the feature outside Discord.
 */
function PresenceCluster({ editors }: { editors: NodeEditor[] }) {
  if (editors.length === 0) return null;
  const shown = editors.slice(0, MAX_PRESENCE);
  const extra = editors.length - shown.length;
  const names = editors.map((e) => e.name);
  const title =
    names.length === 1
      ? `${names[0]} is editing this`
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are editing this`;
  return (
    <span className={styles.presence} title={title} aria-label={title}>
      {shown.map((e) => (
        <span
          key={e.userId}
          className={styles.presenceSlot}
          style={{ "--ring": e.color } as CSSProperties}
        >
          <Avatar id={e.userId} name={e.name} avatar={e.avatar} size={16} />
        </span>
      ))}
      {extra > 0 ? <span className={styles.presenceMore}>+{extra}</span> : null}
    </span>
  );
}

function TreeNode({ node, parentKind, parentId, parentSiblingIds, siblingIndex }: TreeNodeProps) {
  // Subscribe to just this row's selected state so changing the selection only
  // re-renders the two rows whose highlight flips, not every row in the tree.
  const isSelected = useMessageStore((s) => s.selectedId === node._id);
  // Other collaborators currently editing THIS node (Activity only — empty and
  // inert in the web app, so this subscription never wakes there).
  const editors = useNodeEditors(node._id);
  const select = useMessageStore((s) => s.select);
  const moveSibling = useMessageStore((s) => s.moveSibling);
  const moveToParent = useMessageStore((s) => s.moveToParent);
  const remove = useMessageStore((s) => s.remove);
  const duplicate = useMessageStore((s) => s.duplicate);
  const addContainerChild = useMessageStore((s) => s.addContainerChild);
  const addContainerComponent = useMessageStore((s) => s.addContainerComponent);
  const addContainerSection = useMessageStore((s) => s.addContainerSection);
  const addSectionText = useMessageStore((s) => s.addSectionText);
  const addRowButton = useMessageStore((s) => s.addRowButton);
  const addRowSelect = useMessageStore((s) => s.addRowSelect);
  const addGalleryItem = useMessageStore((s) => s.addGalleryItem);
  const meta = COMPONENT_META[node.type];
  const issues = useNodeIssues(node._id);
  const severity = worstSeverity(issues);

  const { siblings, extras } = childGroups(node);
  const siblingIds = useMemo(() => siblings.map((c) => c._id), [siblings]);
  const ownChildKind = childParentKind(node);
  const adders = collectAdders(node, {
    addContainerChild,
    addContainerComponent,
    addContainerSection,
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

  // Native file drop: dropping image(s)/video(s) onto a MediaGallery row appends
  // them as new images; dropping an image onto a Thumbnail row sets its media.
  // This is a separate event channel from the pointer-based reorder above, so
  // the two never collide. Other component rows opt out (`enabled: false`).
  const patchNode = useMessageStore((s) => s.patchNode);
  const isGallery = node.type === ComponentType.MediaGallery;
  const isThumbnail = node.type === ComponentType.Thumbnail;
  const handleDroppedFiles = useCallback(
    (files: File[]) => {
      if (node.type === ComponentType.MediaGallery) {
        addFilesToGallery(node._id, node.items.length, files);
      } else if (node.type === ComponentType.Thumbnail) {
        const file = files[0];
        if (!file) return;
        patchNode<ThumbnailComponent>(node._id, {
          media: { url: registerAttachment(file), attachment_id: undefined },
        });
        select(node._id);
      }
    },
    [node, patchNode, select],
  );
  const { isDragOver: fileDragOver, handlers: fileDropHandlers } = useFileDrop({
    accept: isGallery ? "image/*,video/*" : "image/*",
    multiple: isGallery,
    enabled: isGallery || isThumbnail,
    onFiles: handleDroppedFiles,
    onReject: () =>
      pushToast(
        isGallery ? "Only images and videos can be added here." : "Only images can be added here.",
        "error",
      ),
  });

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
      // preview→tree scroll in ComponentRenderer.
      select(node._id);
      scrollPreviewNodeIntoView(node._id);
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
          fileDragOver && styles.rowFileDrop,
          editors.length > 0 && styles.rowEditing,
        )}
        // Outline this row in the first collaborator's colour when they're
        // editing it (no-op when `editors` is empty — see `--presence-color`).
        style={
          editors.length > 0
            ? ({ "--presence-color": editors[0]!.color } as CSSProperties)
            : undefined
        }
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
        {...fileDropHandlers}
        onClick={onRowClick}
      >
        <span className={styles.chevron} aria-hidden="true">
          {isSelected ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        </span>
        <span className={styles.glyphCell}>
          <span
            className={cn(styles.glyph, severity === "error" && styles.glyphError)}
            aria-hidden="true"
          >
            {meta.glyph}
          </span>
          <IssueDot issues={issues} />
        </span>
        <span className={styles.label}>{meta.label}</span>
        <span className={styles.summary}>{summarize(node)}</span>

        <PresenceCluster editors={editors} />

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
  const editors = useNodeEditors(item._id);
  const select = useMessageStore((s) => s.select);
  const moveGalleryItem = useMessageStore((s) => s.moveGalleryItem);
  const moveGalleryItemToGallery = useMessageStore((s) => s.moveGalleryItemToGallery);
  const removeGalleryItem = useMessageStore((s) => s.removeGalleryItem);
  const duplicateGalleryItem = useMessageStore((s) => s.duplicateGalleryItem);
  const issues = useNodeIssues(item._id);
  const severity = worstSeverity(issues);

  const canMoveUp = index > 0;
  const canMoveDown = index < total - 1;
  const canDuplicate = total < LIMITS.GALLERY_ITEMS;
  const canRemove = total > 1;

  // Drag-and-drop reorder, sharing the component-row gesture engine. The
  // `"gallery"` parent kind makes `computeAllowedPositions` permit before/after
  // drops among sibling images of the same gallery as well as images of any
  // other gallery, plus an `into` drop onto a gallery row.
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
      if (position === "into") {
        // Dropped onto a gallery row — append into that gallery (`target.id`).
        moveGalleryItemToGallery(galleryId, target.id, item._id, Number.MAX_SAFE_INTEGER);
        return;
      }
      // before/after another image — `target.parentId` is its gallery, which
      // may differ from this image's gallery (a cross-gallery move).
      const idx = target.siblingIndex + (position === "after" ? 1 : 0);
      moveGalleryItemToGallery(galleryId, target.parentId ?? galleryId, item._id, idx);
    },
    [moveGalleryItemToGallery, galleryId, item._id],
  );
  const {
    isDragging,
    showDropBefore,
    showDropAfter,
    showDropInto,
    consumeJustDragged,
    pointerHandlers,
  } = usePointerDragRow({ isReorderable: true, dragInfo, allowed, commit });

  // Dropping a file onto an image row replaces that image in place; extra files
  // in the same drop are inserted right after it (see `replaceGalleryItemFiles`).
  const handleDroppedFiles = useCallback(
    (files: File[]) => replaceGalleryItemFiles(galleryId, item._id, total, files),
    [galleryId, item._id, total],
  );
  const { isDragOver: fileDragOver, handlers: fileDropHandlers } = useFileDrop({
    accept: "image/*,video/*",
    multiple: true,
    onFiles: handleDroppedFiles,
    onReject: () => pushToast("Only images and videos can be added here.", "error"),
  });

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
    scrollPreviewNodeIntoView(item._id, "center");
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
          fileDragOver && styles.rowFileDrop,
          editors.length > 0 && styles.rowEditing,
        )}
        style={
          editors.length > 0
            ? ({ "--presence-color": editors[0]!.color } as CSSProperties)
            : undefined
        }
        data-tree-row="true"
        data-row-id={item._id}
        data-parent-kind="gallery"
        data-parent-id={galleryId}
        data-sibling-index={index}
        {...pointerHandlers}
        {...fileDropHandlers}
        onClick={onRowClick}
      >
        <span className={styles.chevron} aria-hidden="true">
          {isSelected ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        </span>
        <span className={styles.glyphCell}>
          <span
            className={cn(styles.glyph, severity === "error" && styles.glyphError)}
            aria-hidden="true"
          >
            ▦
          </span>
          <IssueDot issues={issues} />
        </span>
        <span className={styles.label}>Image</span>
        <span className={styles.summary}>{summarizeGalleryItem(item)}</span>

        <PresenceCluster editors={editors} />

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
  addContainerComponent: (id: EditorId, type: ComponentTypeValue) => void;
  addContainerSection: (id: EditorId, accessoryKind: "thumbnail" | "button") => void;
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
          nodes={CONTAINER_PICKER.map((t): AddMenuNode => {
            // "Section" and "Buttons Row" are group headers: clicking expands to
            // their variants; they add nothing on their own.
            if (t === ComponentType.Section) {
              return {
                type: t,
                children: [
                  {
                    type: ComponentType.Thumbnail,
                    onPick: () => addThenScroll(() => h.addContainerSection(node._id, "thumbnail")),
                  },
                  {
                    type: ComponentType.Button,
                    onPick: () => addThenScroll(() => h.addContainerSection(node._id, "button")),
                  },
                ],
              };
            }
            if (t === ComponentType.ActionRow) {
              return {
                type: t,
                children: [ComponentType.Button, ...ROW_SELECT_PICKER].map((ct) => ({
                  type: ct,
                  onPick: () => addThenScroll(() => h.addContainerComponent(node._id, ct)),
                })),
              };
            }
            return {
              type: t,
              onPick: () =>
                addThenScroll(() => h.addContainerChild(node._id, t as ContainerChildFactoryKey)),
            };
          })}
          disabled={node.components.length >= LIMITS.CONTAINER_CHILDREN}
          trigger={<AddChildButton label="Add to container" />}
        />
      </li>,
    );
  }

  if (isSection(node) && (node as SectionComponent).components.length < LIMITS.SECTION_TEXTS_MAX) {
    out.push(
      <li key="__add_section_text" className={styles.adderItem}>
        <AddChildButton
          label="Add text"
          onClick={() => addThenScroll(() => h.addSectionText(node._id))}
        />
      </li>,
    );
  }

  if (isActionRow(node)) {
    const row = node;
    if (!isSelectRow(row)) {
      if (row.components.length < LIMITS.ACTION_ROW_BUTTONS && !row.components.some(isSelect)) {
        out.push(
          <li key="__add_row_button" className={styles.adderItem}>
            <AddChildButton
              label="Add button"
              onClick={() => addThenScroll(() => h.addRowButton(node._id))}
            />
          </li>,
        );
      }
      if (row.components.length === 0) {
        out.push(
          <li key="__add_row_select" className={styles.adderItem}>
            <AddComponentMenu
              nodes={ROW_SELECT_PICKER.map((t) => ({
                type: t,
                onPick: () =>
                  addThenScroll(() => h.addRowSelect(node._id, t as SelectComponent["type"])),
              }))}
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
          onClick={() => addThenScroll(() => h.addGalleryItem(node._id))}
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
