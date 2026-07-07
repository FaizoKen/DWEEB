import { useEffect, useRef, type DependencyList, type RefObject } from "react";

/**
 * Scroll a list's active item into view within its *own* scroll container, so an
 * already-selected entry — the connected server, its posted-message section, the
 * selected webhook — is visible when the list opens instead of hidden below the
 * fold (lists open scrolled to the top).
 *
 * Adjusts only the container's `scrollTop`, never `element.scrollIntoView()`,
 * which would also pan any enclosing dialog / popover / page. The browser clamps
 * the result, so a short (non-scrolling) list, or one whose active item is
 * already visible, stays exactly where it is.
 *
 * Behaviour is driven by `deps`, which do double duty:
 *  - They **re-arm** the scroll — change them for a fresh opening or a new
 *    target (e.g. `[open]` for a picker that stays mounted, `[filter, guildId]`
 *    for a tab that reveals the active item later). Pass only *stable*
 *    (primitive) values; an array/object that changes identity every render
 *    would re-scroll on every render.
 *  - Until both the container and the active element are mounted the scroll is
 *    deferred and retried on the next render, so a list whose rows hydrate a
 *    frame after the container (async server data, a portal positioned in an
 *    effect) still lands. Once it fires it latches until `deps` change again.
 */
export function useScrollActiveIntoView(
  containerRef: RefObject<HTMLElement>,
  activeRef: RefObject<HTMLElement>,
  deps: DependencyList,
  align: "center" | "start" = "center",
): void {
  // Re-armed whenever `deps` change; latched once the scroll has fired so a
  // later interaction (typing to filter, scrolling by hand) doesn't yank it back.
  const doneRef = useRef(false);
  useEffect(() => {
    doneRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Runs after every commit: cheap early-returns keep it idle once it has fired,
  // and let it wait out the renders before both refs are present.
  useEffect(() => {
    if (doneRef.current) return;
    const container = containerRef.current;
    const active = activeRef.current;
    if (!container || !active) return;
    doneRef.current = true;

    const cr = container.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    // Centre the item, or float it to the top just inside the container's own
    // top padding (so it isn't tucked under it).
    const lead =
      align === "center"
        ? (cr.height - ar.height) / 2
        : parseFloat(getComputedStyle(container).paddingTop) || 0;
    container.scrollTop += ar.top - cr.top - lead;
  });
}
