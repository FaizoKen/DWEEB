/**
 * Mobile preview-sheet plumbing, shared by the web app (`app/App`) and the
 * embedded Discord Activity (`activity/ActivityApp`).
 *
 * On narrow viewports both surfaces hide the preview as a side column and bring
 * it up as a bottom sheet on demand. The resting open/close slide lives in CSS
 * (driven by `data-preview-open`); this module owns the JS that the CSS can't:
 * the swipe-down-to-dismiss gesture and a hook that tracks whether we're in the
 * sheet layout at all (so a second live `<Preview>` is only mounted there).
 */

import { useEffect, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";

// Must match the `@media (max-width: 900px)` breakpoint in global.css /
// Preview.module.css / ActivityApp.module.css that switches the preview from
// side column to sheet.
export const MOBILE_SHEET_QUERY = "(max-width: 900px)";

/**
 * Drives the mobile preview sheet's swipe-to-dismiss gesture.
 *
 * The sheet's resting open/close slide lives in CSS (driven by
 * `data-preview-open`). The whole sheet is swipeable so the user doesn't
 * have to hunt for the drag handle: the gesture engages either on the
 * handle (which has `touch-action: none`) or on the message area when the
 * scroll is already at the top. We re-check `scrollTop` on each move so
 * that if native scrolling has happened first, the swipe-to-dismiss never
 * steals the gesture — the user can scroll freely.
 *
 * Once engaged we disable the CSS transition inline and follow the finger
 * 1:1 with `translateY`; on release we restore the CSS timing and either
 * finish the slide down (a drag past the threshold dismisses) or snap back
 * to the open position.
 *
 * The handler short-circuits whenever the viewport is wider than the mobile
 * breakpoint (e.g. phone in landscape, tablets, desktop). On those layouts
 * the preview is a side column, not a sheet — `translateY` would break it
 * and hijack native scrolling.
 */
export function usePreviewSwipeToClose(onClose: () => void) {
  const sheetRef = useRef<HTMLElement>(null);
  const startY = useRef(0);
  const deltaY = useRef(0);
  const active = useRef(false);
  // null = undecided, true = eligible to engage, false = abandon for this gesture.
  const eligible = useRef<boolean | null>(null);
  const inScrollArea = useRef(false);

  const isMobileSheetLayout = () =>
    typeof window !== "undefined" && window.matchMedia(MOBILE_SHEET_QUERY).matches;

  const onTouchStart = (e: ReactTouchEvent) => {
    if (!isMobileSheetLayout()) return;
    const touch = e.touches[0];
    const el = sheetRef.current;
    if (!touch || !el) return;
    const scroll = el.querySelector<HTMLElement>("[data-preview-scroll]");
    inScrollArea.current = scroll ? scroll.contains(e.target as Node) : false;
    active.current = false;
    eligible.current = null;
    startY.current = touch.clientY;
    deltaY.current = 0;
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    if (!isMobileSheetLayout()) return;
    const touch = e.touches[0];
    const el = sheetRef.current;
    if (!touch || !el) return;
    const dy = touch.clientY - startY.current;

    if (active.current) {
      const clamped = Math.max(0, dy);
      deltaY.current = clamped;
      el.style.transform = `translateY(${clamped}px)`;
      return;
    }
    if (eligible.current === false) return;

    // Treat any upward intent or sideways drag as "user is scrolling, not
    // dismissing" and abandon for the rest of the gesture so native scroll
    // owns it.
    if (dy < -2) {
      eligible.current = false;
      return;
    }
    // Wait for a clear downward intent before deciding.
    if (dy <= 10) return;

    // Re-check the scroll position now, not just at touchstart — if native
    // scroll has carried us off the top, we yield to it.
    const scroll = el.querySelector<HTMLElement>("[data-preview-scroll]");
    const atTop = !scroll || scroll.scrollTop <= 0;
    if (inScrollArea.current && !atTop) {
      eligible.current = false;
      return;
    }

    eligible.current = true;
    active.current = true;
    el.style.transition = "none";
    const clamped = Math.max(0, dy);
    deltaY.current = clamped;
    el.style.transform = `translateY(${clamped}px)`;
  };

  const onTouchEnd = () => {
    const el = sheetRef.current;
    if (!active.current || !el) return;
    active.current = false;
    const height = el.offsetHeight || window.innerHeight;
    const shouldClose = deltaY.current > Math.min(160, height * 0.3);
    el.style.transition = "";
    if (shouldClose) {
      // Finish the slide down, then hand the transform back to CSS.
      el.style.transform = "translateY(100%)";
      const cleanup = () => {
        el.style.transform = "";
        el.removeEventListener("transitionend", cleanup);
      };
      el.addEventListener("transitionend", cleanup);
      onClose();
    } else {
      el.style.transform = "";
    }
  };

  return {
    sheetRef,
    swipeProps: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd },
  };
}

/**
 * Subscribe to a media query, re-rendering when it flips.
 *
 * Syncs once on mount, not just via the `change` event: the viewport can change
 * between the initial render (the `useState` initializer) and this effect
 * attaching the listener. In the Discord Activity that's the common case — the
 * iframe is often narrow during the splash/handshake and only resized to its
 * real (often desktop) size a moment later. If that resize lands in the gap the
 * `change` event fires with no listener attached, is lost, and the size then
 * stays stable, leaving us stuck on the stale initial value. Syncing here closes
 * the gap. Some webview/resize paths also resize without reliably emitting a
 * `change` on the MQL, so we watch plain `resize` too (cheap — React bails out
 * when the boolean is unchanged).
 */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const sync = () => setMatches(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      mql.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, [query]);
  return matches;
}

/**
 * Tracks whether the layout is in its mobile (bottom-sheet) form. Used to gate
 * mounting the live mini preview: it renders a second full <Preview /> tree, so
 * we only want it alive on the viewports where it's actually shown.
 */
export function useIsMobileSheet() {
  return useMediaQuery(MOBILE_SHEET_QUERY);
}
