/**
 * Guided onboarding tour — a multi-step spotlight over the live editor.
 *
 * Renders while `tutorialStore` is active: a full-viewport scrim with a hole
 * punched over the current step's anchor (drawn with an oversized box-shadow,
 * so the hole glides between anchors as steps change), plus a callout beside it
 * carrying the step's copy, progress dots, and Back / Next / Skip controls.
 *
 * Design decisions, deliberately different from the one-shot `SendCoachMark`:
 *
 *  - **The scrim blocks the app.** The tour is a ~20-second orientation, not a
 *    hint; letting clicks through mid-tour would tangle it with real dialogs.
 *    Clicking anywhere outside the callout advances instead (the common "tap
 *    to continue" idiom), Escape skips, and arrow keys navigate — so the whole
 *    thing can be flicked through in seconds.
 *  - **It repositions rather than dismisses** on scroll/resize, and a gentle
 *    interval re-measures the anchor so late layout (fonts, images, the action
 *    bar's staged label collapse) never leaves the ring hanging in space.
 *  - **Anchors resolve per measure** from each step's candidate list (first
 *    element actually visible in the viewport wins), which is how one script
 *    serves desktop and mobile (see `steps.ts`). A step with no visible anchor
 *    is skipped automatically.
 *
 * Accessibility: the callout is a focused `role="dialog"` (aria-modal, labelled
 * by the step title) with a minimal Tab cycle across its controls; Enter/Space
 * outside a button advance; reduced motion disables the glide and fades.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/ui/Button";
import { TOUR_STEPS, type TourSide } from "./steps";
import { useTutorialStore } from "./tutorialStore";
import styles from "./TutorialTour.module.css";

/** An on-screen box, in viewport coordinates. */
interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** How far the spotlight hole extends beyond the anchor. */
const HOLE_PAD = 6;
/** Min on-screen size, per axis, for an anchor to count as visible. Keeps a
 *  sliver — e.g. the mobile preview sheet's top edge peeking 0.4px into the
 *  viewport while "closed" — from beating the intended fallback anchor. */
const MIN_VISIBLE = 24;
/** Gap between the anchor and the callout. */
const GAP = 14;
/** Min gap kept between the callout and the viewport edges. */
const EDGE = 12;
const CALLOUT_WIDTH = 304;
/** Re-measure cadence guarding against layout that shifts under the tour. */
const POLL_MS = 350;

export function TutorialTour() {
  const active = useTutorialStore((s) => s.status === "active");
  return active ? <TourOverlay /> : null;
}

/** The current step's resolved target: its rect plus any copy override. */
interface Target {
  rect: Rect;
  body?: string;
}

/** First candidate anchor that exists and is visible within the viewport. */
function resolveTarget(step: number): Target | null {
  for (const anchor of TOUR_STEPS[step]!.anchors) {
    const el = document.querySelector(anchor.selector);
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    // Reject anchors that are too small or (mostly) parked outside the
    // viewport — e.g. the mobile preview sheet translated off-screen — so the
    // fallback candidate gets its turn.
    const visibleW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const visibleH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (visibleW < MIN_VISIBLE || visibleH < MIN_VISIBLE) continue;
    return {
      rect: { top: r.top, left: r.left, width: r.width, height: r.height },
      body: anchor.body,
    };
  }
  return null;
}

const rectsEqual = (a: Rect, b: Rect) =>
  Math.abs(a.top - b.top) < 0.5 &&
  Math.abs(a.left - b.left) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;

function TourOverlay() {
  const step = useTutorialStore((s) => s.step);
  const next = useTutorialStore((s) => s.next);
  const back = useTutorialStore((s) => s.back);
  const goTo = useTutorialStore((s) => s.goTo);
  const skip = useTutorialStore((s) => s.skip);

  const [target, setTarget] = useState<Target | null>(() => resolveTarget(step));
  // The callout's rendered size — measured after paint so placement can flip
  // and clamp with real numbers. Sized per step (copy length varies).
  const [calloutSize, setCalloutSize] = useState<{ w: number; h: number } | null>(null);
  const calloutRef = useRef<HTMLDivElement>(null);

  // Re-measure now and on anything that can move the anchor: viewport resizes,
  // any scroll (capture — the panes scroll, not the window), and a gentle poll
  // for silent layout shifts. State only changes when the rect actually moved,
  // so the poll doesn't churn renders.
  useEffect(() => {
    const measure = () => {
      const t = resolveTarget(step);
      setTarget((prev) => {
        if (t === null || prev === null) return t;
        return rectsEqual(prev.rect, t.rect) && prev.body === t.body ? prev : t;
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const timer = setInterval(measure, POLL_MS);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      clearInterval(timer);
    };
  }, [step]);

  // A step whose anchor can't be found is skipped, forward only — `next()`
  // finishes the tour off the last step, so this can't loop.
  useEffect(() => {
    if (target === null) next();
  }, [target, next]);

  // Measure the callout once its copy for this step has rendered.
  useLayoutEffect(() => {
    setCalloutSize(null);
  }, [step, target?.body]);
  useLayoutEffect(() => {
    if (calloutSize !== null) return;
    const el = calloutRef.current;
    if (el) setCalloutSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, [calloutSize]);

  // Keep keyboard focus on the callout as steps change, so arrow keys and the
  // screen-reader context follow the tour.
  useLayoutEffect(() => {
    calloutRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        skip();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
        return;
      }
      // Enter/Space advance unless aimed at one of the callout's buttons
      // (which handle their own activation).
      if ((e.key === "Enter" || e.key === " ") && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        next();
        return;
      }
      // Minimal focus trap: Tab cycles through the callout's controls.
      if (e.key === "Tab") {
        const callout = calloutRef.current;
        if (!callout) return;
        const focusables = Array.from(callout.querySelectorAll<HTMLElement>("button"));
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const current = document.activeElement;
        if (e.shiftKey && (current === first || current === callout)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && current === last) {
          e.preventDefault();
          first.focus();
        } else if (!callout.contains(current)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [next, back, skip]);

  // Clicks anywhere on the scrim (hole included) advance; the callout stops
  // propagation so its own buttons don't double-fire.
  const onLayerClick = useCallback(() => next(), [next]);

  if (target === null) return null;

  const def = TOUR_STEPS[step]!;
  const hole: Rect = {
    top: target.rect.top - HOLE_PAD,
    left: target.rect.left - HOLE_PAD,
    width: target.rect.width + HOLE_PAD * 2,
    height: target.rect.height + HOLE_PAD * 2,
  };
  const winner = TOUR_STEPS[step]!.anchors.find((a) => a.body === target.body) ?? def.anchors[0]!;
  const layout = calloutSize ? placeCallout(hole, winner.place, calloutSize) : null;
  const isLast = step === TOUR_STEPS.length - 1;

  return createPortal(
    <div className={styles.layer} onClick={onLayerClick}>
      {/* The spotlight: an accent-ringed hole whose oversized shadow is the
          scrim. Inline position; CSS transitions make it glide between steps. */}
      <div
        className={styles.hole}
        aria-hidden
        style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
      />
      <div
        ref={calloutRef}
        className={styles.callout}
        role="dialog"
        aria-modal="true"
        aria-label={`Tour step ${step + 1} of ${TOUR_STEPS.length}: ${def.title}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={
          layout
            ? { top: layout.top, left: layout.left, width: CALLOUT_WIDTH }
            : // First paint of a step: park it invisibly to measure its size.
              { top: 0, left: 0, width: CALLOUT_WIDTH, visibility: "hidden" }
        }
      >
        {layout ? (
          <span
            className={styles.arrow}
            data-side={layout.side}
            style={
              layout.side === "top" || layout.side === "bottom"
                ? { left: layout.arrow }
                : { top: layout.arrow }
            }
            aria-hidden
          />
        ) : null}
        <div className={styles.header}>
          <span className={styles.title}>{def.title}</span>
          <button type="button" className={styles.skip} onClick={skip}>
            Skip tour
          </button>
        </div>
        <p className={styles.body}>{target.body ?? def.body}</p>
        <div className={styles.footer}>
          <div
            className={styles.dots}
            role="group"
            aria-label={`Step ${step + 1} of ${TOUR_STEPS.length}`}
          >
            {TOUR_STEPS.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className={styles.dot}
                data-active={i === step ? "" : undefined}
                aria-label={`Go to step ${i + 1}`}
                aria-current={i === step ? "step" : undefined}
                onClick={() => goTo(i)}
              />
            ))}
          </div>
          <div className={styles.nav}>
            {step > 0 ? (
              <Button variant="ghost" size="sm" onClick={back}>
                Back
              </Button>
            ) : null}
            <Button variant="primary" size="sm" onClick={next}>
              {isLast ? "Finish" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface CalloutLayout {
  top: number;
  left: number;
  /** The side of the anchor the callout ended up on (drives the arrow). */
  side: TourSide;
  /** Arrow offset along the callout's anchor-facing edge, in px. */
  arrow: number;
}

/** Whether a callout of `size` fits on `side` of `hole` within the viewport. */
function fits(hole: Rect, side: TourSide, size: { w: number; h: number }): boolean {
  switch (side) {
    case "bottom":
      return hole.top + hole.height + GAP + size.h <= window.innerHeight - EDGE;
    case "top":
      return hole.top - GAP - size.h >= EDGE;
    case "right":
      return hole.left + hole.width + GAP + size.w <= window.innerWidth - EDGE;
    case "left":
      return hole.left - GAP - size.w >= EDGE;
  }
}

const OPPOSITE: Record<TourSide, TourSide> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/**
 * Pick the callout's side and position. Tries the step's preferred side, then
 * its opposite, then the rest; whatever wins is clamped to the viewport. If
 * nothing fits (a huge anchor on a tiny screen), the callout sits *inside*
 * the spotlight near its bottom edge — still visibly tied to the target.
 */
function placeCallout(hole: Rect, prefer: TourSide, size: { w: number; h: number }): CalloutLayout {
  const order: TourSide[] = [prefer, OPPOSITE[prefer], "bottom", "top", "right", "left"];
  const side = order.find((s) => fits(hole, s, size));

  const cx = hole.left + hole.width / 2;
  const cy = hole.top + hole.height / 2;
  const clampX = (x: number) => Math.min(Math.max(x, EDGE), window.innerWidth - size.w - EDGE);
  const clampY = (y: number) => Math.min(Math.max(y, EDGE), window.innerHeight - size.h - EDGE);

  if (side === "bottom" || side === "top") {
    const left = clampX(cx - size.w / 2);
    const top = side === "bottom" ? hole.top + hole.height + GAP : hole.top - GAP - size.h;
    // The arrow tracks the anchor's centre even when the box is clamped.
    const arrow = Math.min(Math.max(cx - left, 18), size.w - 18);
    return { top, left, side, arrow };
  }
  if (side === "right" || side === "left") {
    const top = clampY(cy - size.h / 2);
    const left = side === "right" ? hole.left + hole.width + GAP : hole.left - GAP - size.w;
    const arrow = Math.min(Math.max(cy - top, 18), size.h - 18);
    return { top, left, side, arrow };
  }
  // Nothing fits outside — nest inside the spotlight, bottom-centred, no arrow
  // side that makes sense so keep "bottom" (the arrow lands off the anchor's
  // edge and is clipped by the clamp anyway).
  return {
    top: clampY(hole.top + hole.height - size.h - GAP),
    left: clampX(cx - size.w / 2),
    side: "bottom",
    arrow: size.w / 2,
  };
}
