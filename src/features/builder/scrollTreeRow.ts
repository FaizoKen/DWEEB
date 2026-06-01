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
