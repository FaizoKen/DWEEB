import { useMessageStore } from "@/core/state/messageStore";

/**
 * Smooth-scroll a component tree row into view by its editor id.
 *
 * Aligns the row to the top of the viewport (`block: "start"`) so the selected
 * node — and the children / inline inspector that unfold beneath it — get the
 * most room, rather than burying it mid-list. Rows near the end of a long tree
 * simply land as high as the remaining scroll allows.
 *
 * Deferred one frame so a row that was just added or revealed by a selection
 * change has mounted (and the layout has settled) before `scrollIntoView`
 * measures positions. Safe to call with an id that isn't in the tree — the
 * query simply finds nothing.
 */
export function scrollTreeRowIntoView(id: string): void {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(`[data-tree-row="true"][data-row-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/** Nearest ancestor that actually scrolls vertically, or null for the page. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p) {
    const overflow = getComputedStyle(p).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return null;
}

/** A clicked row below this fraction of its scroller's height gets scrolled up. */
const REVEAL_THRESHOLD = 0.55;

/**
 * After a row click opens its inline editor, keep that editor on screen.
 *
 * Clicking a row near the bottom of the tree pane used to open a ~400px editor
 * entirely below the fold — nothing visibly happened. Unlike
 * {@link scrollTreeRowIntoView} this is deliberately gentle: a row already in
 * the upper half of the pane stays put (a click shouldn't yank the list
 * around), only one in the lower part scrolls to the top so the editor that
 * unfolds beneath it has room. Deferred one frame so the editor has mounted.
 */
export function revealTreeRowEditor(id: string): void {
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(
      `[data-tree-row="true"][data-row-id="${CSS.escape(id)}"]`,
    );
    if (!row) return;
    const scroller = scrollParentOf(row);
    const box = scroller
      ? scroller.getBoundingClientRect()
      : { top: 0, height: window.innerHeight };
    const rowTop = row.getBoundingClientRect().top - box.top;
    if (rowTop > box.height * REVEAL_THRESHOLD) {
      row.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

/**
 * Smooth-scroll the rendered preview to the component matching an editor id —
 * the mirror of {@link scrollTreeRowIntoView}, which moves the tree row.
 *
 * Desktop only: on mobile the preview is a hidden bottom sheet, so there's
 * nothing on screen to bring into view. Deferred one frame so a selection that
 * just revealed or added the node has mounted (and the layout has settled)
 * before `scrollIntoView` measures positions. Safe to call with an id that
 * isn't rendered — the query simply finds nothing.
 */
export function scrollPreviewNodeIntoView(
  id: string,
  block: ScrollLogicalPosition = "start",
): void {
  if (window.matchMedia("(max-width: 900px)").matches) return;
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(`[data-preview-scroll] [data-node-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block });
  });
}

/**
 * Run an "add component" action, then smooth-scroll the freshly added row into
 * view so it's ready to edit. Every `addX` store action selects the new node,
 * so we read `selectedId` back once the action has committed and scroll to it.
 */
export function addThenScroll(addFn: () => void): void {
  addFn();
  const newId = useMessageStore.getState().selectedId;
  if (newId) scrollTreeRowIntoView(newId);
}
