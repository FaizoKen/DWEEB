/**
 * Shared fit measurement for the single-row action bars (the web builder's
 * `ActionBar` and the embedded Activity's `ActivityBar`). Both keep every
 * control on one row by measuring whether the actions fit and collapsing one
 * step at a time when they don't; this is the pixel measurement they share.
 *
 * Returns the width the bar *needs* to show the current (already-rendered) row
 * in full: the right cluster's natural width, plus a reserve for the left
 * cluster (account/server + destination chip), plus the bar's own gap and
 * horizontal padding. The caller compares it against the bar's real width and
 * escalates the collapse ladder by one when `needed` exceeds it.
 */

/** Ceiling (px) on the space reserved for the left cluster. The reserve is the
 *  cluster's real natural width capped at this — a short channel name never
 *  books phantom space (which would collapse the actions with visible room left
 *  over), while a long one truncates gracefully once the actions need the room. */
export const LEFT_MAX_RESERVE = 150;

/** Ceiling on how many utility icons either bar shows inline, however much room
 *  it has. Fit is the floor, not the rule: a wide bar *could* hold six icons in
 *  a row, but a row of undifferentiated glyphs stops being scannable long before
 *  it stops fitting. Only the first {@link MAX_INLINE_UTILITIES} of a bar's
 *  `utilities` list earn a spot; the tail lives in the overflow menu at every
 *  width, where it reads as labelled text. Order the list accordingly — the
 *  everyday actions first. The fit ladder still folds these last few away on top
 *  of the cap as the bar narrows. */
export const MAX_INLINE_UTILITIES = 3;

export function measureNeededWidth(
  bar: HTMLElement,
  left: HTMLElement,
  right: HTMLElement,
): number {
  // A global `transition: all` rule (an anti-flash hack, ~10µs) animates the
  // bar's gap/padding and the clusters' gaps whenever `data-compact` flips.
  // Those transitions are imperceptible in wall-clock time, but the animation
  // clock does not advance during this synchronous layout effect, so a
  // getBoundingClientRect / getComputedStyle here reads the *start-of-
  // transition* value — the OUTGOING (compact) metrics right after we reset to
  // the full row. That under-measures the width, lets the ladder settle
  // non-compact at a size where the full row doesn't fit, and flaps the bar in
  // and out of compact across a ~1px band. Freeze transitions on the measured
  // elements so every read is the final, settled geometry, then restore.
  const frozen = [bar, left, right].map((el) => ({ el, prev: el.style.transition }));
  for (const { el } of frozen) el.style.transition = "none";

  const cs = getComputedStyle(bar);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const gap = parseFloat(cs.columnGap) || 0;

  // The left cluster's natural (untruncated) width, measured with
  // `min-width: max-content` briefly forced on — its rendered box compresses
  // under pressure, so reading it directly would under-reserve. (Disabling
  // flex-shrink is NOT enough: the cluster is itself a flex container whose
  // children carry `min-width: 0`, and Chromium keeps it at its squeezed width
  // — the check then reads back whatever space it happened to get and concludes
  // it fits, so the ladder never engages and the chip crushes to a bare "#"
  // instead of folding an action away.)
  const prevMinWidth = left.style.minWidth;
  left.style.minWidth = "max-content";
  const naturalLeft = left.getBoundingClientRect().width;
  left.style.minWidth = prevMinWidth;

  const reserve = Math.min(naturalLeft, LEFT_MAX_RESERVE);
  const needed = right.getBoundingClientRect().width + reserve + gap + padX;

  // Restore transitions last — after minWidth is already back to its original,
  // so unfreezing can't kick off a stray animation.
  for (const { el, prev } of frozen) el.style.transition = prev;
  return needed;
}
