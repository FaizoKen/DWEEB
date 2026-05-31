/**
 * Smooth-scroll a component tree row into view by its editor id.
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
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
