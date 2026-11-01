/**
 * Where an anchored dropdown goes, given how much room the viewport has.
 *
 * It opens below its trigger, flips above when that's clearly the roomier side,
 * and clamps horizontally. A panel taller than the side it opened on gets a
 * `maxHeight` to scroll inside: without one, the rows past the viewport's edge
 * could not be reached at all — by mouse or by arrow key — on a short laptop
 * screen or a phone. `null` means it fits, and the panel keeps its natural size.
 */

export interface MenuAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  maxHeight: number | null;
}

/** Kept clear between the panel and the viewport's edges. */
const MARGIN = 8;
/** Between the trigger and the panel. */
const GAP = 6;

export function placeMenu(
  anchor: MenuAnchor,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "start" | "end",
): MenuPlacement {
  let left = align === "start" ? anchor.left : anchor.right - panel.width;
  if (left + panel.width > viewport.width - MARGIN) left = viewport.width - panel.width - MARGIN;
  if (left < MARGIN) left = MARGIN;

  const spaceBelow = viewport.height - anchor.bottom - MARGIN;
  const spaceAbove = anchor.top - MARGIN;
  const openUp = panel.height + GAP > spaceBelow && spaceAbove > spaceBelow;
  const room = (openUp ? spaceAbove : spaceBelow) - GAP;
  const height = Math.min(panel.height, room);
  const top = openUp ? Math.max(MARGIN, anchor.top - GAP - height) : anchor.bottom + GAP;

  return { left, top, maxHeight: panel.height > room ? room : null };
}
