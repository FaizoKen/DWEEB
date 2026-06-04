/**
 * Live mini preview.
 *
 * A scaled-down, real-time thumbnail of the message that floats in the mobile
 * FAB corner. It renders the actual {@link Preview} so the thumbnail always
 * matches the full render exactly, then shrinks it with a CSS transform.
 *
 * The whole inner tree is made `inert` so the avatar/username/component buttons
 * inside it can never steal a tap or a tab stop — the card itself is the single
 * interactive target, opening the full preview sheet on press. `inert` is set
 * imperatively because React 18's JSX types don't expose it yet.
 *
 * This only ever mounts on mobile (see `useIsMobileSheet` in App): on desktop
 * the preview is a permanent side column, so a thumbnail would be redundant —
 * and we'd rather not mount a second full <Preview /> tree there.
 *
 * Selecting a component in the builder scrolls the thumbnail to that component,
 * so the corner always frames whatever you're editing — the mobile counterpart
 * to the builder→preview scroll the desktop side column gets for free.
 */

import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { Preview } from "./Preview";
import styles from "./MiniPreview.module.css";

interface MiniPreviewProps {
  /** Opens the full preview sheet. */
  onOpen: () => void;
}

export function MiniPreview({ onOpen }: MiniPreviewProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const selectedId = useMessageStore((s) => s.selectedId);

  // Space/Enter activate the card the way they would a real <button>; it's a
  // div (not a button) because its rendered message contains its own buttons,
  // and nesting interactive elements is invalid.
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen();
      }
    },
    [onOpen],
  );

  // Stable ref so `inert` is set once on mount rather than on every render.
  const makeInert = useCallback((el: HTMLDivElement | null) => {
    if (el) el.inert = true;
  }, []);

  // Bring the selected component to the top of the thumbnail. We can't lean on
  // `scrollIntoView` here: the preview is wrapped in a `scale()` transform, and
  // scrollIntoView would also scroll the page to reveal the (off-screen) node.
  // So we drive the scroll container directly, converting the on-screen gap to
  // the container's own un-scaled units via the measured scale factor.
  useEffect(() => {
    if (selectedId == null) return;
    const root = cardRef.current;
    if (!root) return;
    const raf = requestAnimationFrame(() => {
      const scroller = root.querySelector<HTMLElement>("[data-preview-scroll]");
      const target = scroller?.querySelector<HTMLElement>(
        `[data-node-id="${CSS.escape(selectedId)}"]`,
      );
      if (!scroller || !target) return;
      const scRect = scroller.getBoundingClientRect();
      const tRect = target.getBoundingClientRect();
      const scale = scRect.width / scroller.offsetWidth || 1;
      const topMargin = 10; // small on-screen gap above the framed node
      const next = scroller.scrollTop + (tRect.top - scRect.top - topMargin) / scale;
      scroller.scrollTo({ top: Math.max(0, next), behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedId]);

  return (
    <div
      ref={cardRef}
      className={styles.card}
      role="button"
      tabIndex={0}
      aria-label="Open message preview"
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      <div className={styles.viewport}>
        <div className={styles.stage} ref={makeInert}>
          <Preview />
        </div>
      </div>
    </div>
  );
}
