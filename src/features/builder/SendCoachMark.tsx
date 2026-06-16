/**
 * Send coach-mark.
 *
 * After guided template setup closes, the user is back in the editor and needs
 * to know where to post — without being pressured to. Rather than a toast that
 * flashes by (or a pulse that's easy to miss), this paints a one-time spotlight:
 * the editor section dims behind a hole punched around its Send button, with a
 * ring on the button and a callout below it noting they can review or edit first
 * and Send when they're ready.
 *
 * It's triggered by `sendNudgeStore`'s monotonic token (each bump replays it),
 * locates the button by id (`#builder-send-action`) and snapshots its rect plus
 * the editor section's (`.app-shell__pane--builder`) to position the overlay.
 * The dim is scoped to the editor pane — the preview never fades — and the
 * callout is clamped to that pane so it never spills past it. The dim catches
 * clicks on the editor (so a stray click dismisses the hint rather than falling
 * through and editing something), while a clip-path hole over the Send button
 * removes it from both the paint and the hit-testing — so it stays crisp and
 * clicking Send still posts. Any click/scroll/Escape (or a timeout) dismisses
 * the hint. Mounted by `App` as a peer overlay.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useSendNudgeStore } from "@/core/state/sendNudgeStore";
import styles from "./SendCoachMark.module.css";

/** An on-screen box, in viewport coordinates. */
interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SEND_BUTTON_ID = "builder-send-action";
const EDITOR_PANE_SELECTOR = ".app-shell__pane--builder";
const CALLOUT_WIDTH = 244;
const GAP = 12;
/** Min gap kept between the callout and the editor section's edges. */
const EDGE = 8;
/** How far the dim's spotlight hole extends beyond the Send button. */
const HOLE_PAD = 6;
/** Fallback dismissal so the hint never lingers if the user walks away. */
const AUTO_DISMISS_MS = 11_000;

export function SendCoachMark() {
  const token = useSendNudgeStore((s) => s.token);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  // The editor section's box: scopes the dim and clamps the callout to it.
  const [pane, setPane] = useState<Rect | null>(null);

  // Activate on each nudge: find the Send button and snapshot its rect, plus the
  // editor section's. A missing button (shouldn't happen — the action bar is
  // always mounted) just no-ops, so the flow degrades to "no hint" rather than
  // throwing. A missing pane falls back to a callout with no dim, clamped to the
  // viewport.
  useEffect(() => {
    if (token === 0) return;
    const el = document.getElementById(SEND_BUTTON_ID);
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ top: r.top, left: r.left, width: r.width, height: r.height });
    const p = document.querySelector(EDITOR_PANE_SELECTOR)?.getBoundingClientRect();
    setPane(p ? { top: p.top, left: p.left, width: p.width, height: p.height } : null);
  }, [token]);

  const dismiss = useCallback(() => {
    setAnchor(null);
    setPane(null);
  }, []);

  // While shown, dismiss on any interaction or layout shift. Listeners attach on
  // the next frame so the very click that opened the hint (the modal's "Review
  // in editor") doesn't immediately close it.
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    const raf = requestAnimationFrame(() => {
      window.addEventListener("click", dismiss, true);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("scroll", dismiss, true);
      window.addEventListener("resize", dismiss);
    });
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("click", dismiss, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      clearTimeout(timer);
    };
  }, [anchor, dismiss]);

  if (!anchor) return null;

  // Place the callout under the button, pointing up. It's clamped to the editor
  // section (so it never spills past it) when we have that box, else the
  // viewport. The arrow tracks the button's centre even when the box is clamped.
  const boundLeft = pane ? pane.left : 0;
  const boundRight = pane ? pane.left + pane.width : window.innerWidth;
  const centerX = anchor.left + anchor.width / 2;
  const minLeft = boundLeft + EDGE;
  const maxLeft = Math.max(minLeft, boundRight - CALLOUT_WIDTH - EDGE);
  const left = Math.min(Math.max(centerX - CALLOUT_WIDTH / 2, minLeft), maxLeft);
  const top = anchor.top + anchor.height + GAP;
  const arrowLeft = Math.min(Math.max(centerX - left, 18), CALLOUT_WIDTH - 18);

  // The dim's spotlight hole over the Send button, in the scrim's own
  // coordinates. An even-odd clip of the pane rect minus this hole leaves the
  // button untouched in both paint and pointer hit-testing.
  const holeX = pane ? anchor.left - pane.left - HOLE_PAD : 0;
  const holeY = pane ? anchor.top - pane.top - HOLE_PAD : 0;
  const holeW = anchor.width + HOLE_PAD * 2;
  const holeH = anchor.height + HOLE_PAD * 2;
  const holeClip = pane
    ? `path(evenodd, "M0 0H${pane.width}V${pane.height}H0Z M${holeX} ${holeY}H${holeX + holeW}V${holeY + holeH}H${holeX}Z")`
    : undefined;

  return createPortal(
    <>
      {pane ? (
        // Dim + blur the editor section, with a clip-path hole over the Send
        // button so it stays crisp and clickable. Catches clicks on the dim so
        // they dismiss the hint instead of falling through to the editor. Sits
        // below the mobile preview sheet (see CSS z-index) so that sheet, which
        // overlays the full-width builder on mobile, is never blurred — only the
        // editor peeking above it is.
        <div
          className={styles.scrim}
          aria-hidden
          onClick={dismiss}
          style={{
            top: pane.top,
            left: pane.left,
            width: pane.width,
            height: pane.height,
            clipPath: holeClip,
            WebkitClipPath: holeClip,
          }}
        />
      ) : null}
      <div className={styles.layer}>
        <div
          className={styles.ring}
          aria-hidden
          style={{
            top: anchor.top - 4,
            left: anchor.left - 4,
            width: anchor.width + 8,
            height: anchor.height + 8,
          }}
        />
        <div className={styles.callout} role="status" style={{ top, left, width: CALLOUT_WIDTH }}>
          <span className={styles.arrow} style={{ left: arrowLeft }} aria-hidden />
          <span className={styles.title}>Your message is ready</span>
          <span className={styles.text}>
            Review or edit it as needed, then <strong>Send</strong> whenever you're ready to post.
          </span>
        </div>
      </div>
    </>,
    document.body,
  );
}
