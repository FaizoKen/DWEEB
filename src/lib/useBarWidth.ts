/**
 * Width observation for the single-row action bars (the web builder's `ActionBar`
 * and the embedded Activity's `ActivityBar`). The companion to
 * `measureBarFit`: that module measures whether the row fits, this one tells the
 * bar when to measure again.
 *
 * Why it isn't a bare `new ResizeObserver(() => setWidth(...))`:
 *
 * Resize notifications are delivered inside the frame's rendering steps, after
 * layout and before paint. A `setState` made *in* that callback re-renders and
 * runs the bar's layout effect in the SAME delivery cycle — so the collapse
 * ladder escalates a step, the bar's content changes, and the observed element's
 * box changes again while the browser is still delivering. The browser can't
 * deliver that follow-up in this frame, so it gives up on the loop and fires a
 * global error: **"ResizeObserver loop completed with undelivered
 * notifications"**. Nothing is broken (the next frame settles it), but it lands
 * on `window.onerror` — which in production means a crash beacon and a pager
 * alert for a non-crash.
 *
 * Hopping the state update to the next animation frame moves the resize the
 * ladder causes *out* of the delivery cycle that observed it, so the follow-up
 * notification is delivered normally and the loop closes quietly. Coalescing on
 * one pending frame keeps a burst of notifications (a drag-resize) to one
 * measurement per frame, and re-reading the width inside the frame means the
 * value used is the current one, not the one from a stale entry.
 */

import { useLayoutEffect, useState } from "react";

/** Accepts any ref shape (`useRef<HTMLDivElement>(null)` included) — the hook
 *  only ever reads `.current`. */
type ReadonlyElementRef = { readonly current: HTMLElement | null };

/**
 * Track `ref`'s client width, re-measured off the resize-notification cycle.
 * Returns `0` until the element mounts.
 */
export function useBarWidth(ref: ReadonlyElementRef): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = ref.current?.clientWidth ?? 0;
      setWidth((current) => (current === next ? current : next));
    };

    const ro = new ResizeObserver(() => {
      if (frame !== 0) return; // already measuring this frame
      frame = requestAnimationFrame(measure);
    });
    ro.observe(el);

    // The first measurement is safe to take synchronously (we're in a layout
    // effect, not a resize callback), and taking it here rather than waiting a
    // frame means the bar fits its row before the first paint.
    measure();

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [ref]);

  return width;
}
