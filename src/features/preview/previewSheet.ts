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

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from "react";

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
  // Deadline (epoch ms) before which a click is the tail of a swipe, not a tap.
  const swallowClickUntil = useRef(0);

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
    // The drag handle is also the sheet's close button, and the message body
    // holds selectable components — the finger ends the swipe still over one of
    // them, so the browser follows up with a click. That click is not a tap.
    swallowClickUntil.current = Date.now() + 400;
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

  // Capture phase, on the sheet root: runs before the handle's own onClick (and
  // before the preview's backdrop/selection clicks) so a post-swipe click can be
  // cancelled outright.
  const onClickCapture = (e: ReactMouseEvent) => {
    if (Date.now() >= swallowClickUntil.current) return;
    swallowClickUntil.current = 0;
    e.preventDefault();
    e.stopPropagation();
  };

  return {
    sheetRef,
    swipeProps: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
      onClickCapture,
    },
  };
}

/**
 * Keyboard/focus lifecycle for the mobile form of the preview. The visual
 * sheet is shared by the web app and Activity, so keeping this here prevents
 * the two shells drifting apart again.
 */
export function usePreviewSheetA11y(
  open: boolean,
  isMobileSheet: boolean,
  onClose: () => void,
  sheetRef: RefObject<HTMLElement>,
) {
  const openerRef = useRef<HTMLElement | null>(null);
  const openerKeyRef = useRef<string | null>(null);
  const activeRef = useRef(false);

  // Call synchronously from an opener's event handler. MiniPreview unmounts in
  // the same render that opens the sheet, so waiting for a layout effect would
  // otherwise see `body` instead of the real trigger.
  const rememberOpener = useCallback(() => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || focused === document.body) return;
    openerRef.current = focused;
    openerKeyRef.current = focused.dataset.previewOpener ?? null;
  }, []);

  useLayoutEffect(() => {
    const active = open && isMobileSheet;
    if (active === activeRef.current) return;
    activeRef.current = active;

    if (active) {
      // Programmatic opens do not call rememberOpener; preserve a synchronously
      // captured (possibly now-disconnected) trigger when one exists.
      if (!openerRef.current) rememberOpener();
      const sheet = sheetRef.current;
      sheet?.focus({ preventScroll: true });

      // The live Preview is latched on in an effect so its exit animation can
      // finish. One frame later its drag handle (the sheet's close control) is
      // available.
      const frame = requestAnimationFrame(() => {
        sheet
          ?.querySelector<HTMLButtonElement>("[data-preview-close='true']")
          ?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }

    const opener = openerRef.current;
    const openerKey = openerKeyRef.current;
    const frame = requestAnimationFrame(() => {
      // Selecting a preview component intentionally moves focus to its editor.
      // Never overwrite an explicit focus destination outside the closing
      // sheet; the handle/Escape/swipe leave focus in the sheet or body.
      const current = document.activeElement;
      if (
        current instanceof HTMLElement &&
        current !== document.body &&
        !sheetRef.current?.contains(current)
      ) {
        openerRef.current = null;
        openerKeyRef.current = null;
        return;
      }
      const remountedOpener = openerKey
        ? document.querySelector<HTMLElement>(`[data-preview-opener="${CSS.escape(openerKey)}"]`)
        : null;
      const fallback = document.querySelector<HTMLElement>("[data-preview-opener='mini']");
      const target = opener?.isConnected ? opener : (remountedOpener ?? fallback);
      if (target && !target.closest("[inert]")) {
        target.focus({ preventScroll: true });
      }
      openerRef.current = null;
      openerKeyRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [isMobileSheet, open, rememberOpener, sheetRef]);

  useEffect(() => {
    if (!open || !isMobileSheet) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A portalled Modal above the sheet owns Escape until it closes.
      if (document.querySelector("[data-modal-backdrop='true']:not([inert])")) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobileSheet, onClose, open]);

  return rememberOpener;
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
