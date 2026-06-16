/**
 * Preview pane.
 *
 * Renders a fake Discord channel "frame" around the user's message so the
 * webhook output is shown in its real visual context. Subscribes only to
 * the message slice of the store so unrelated state (selection, modals)
 * doesn't trigger preview re-renders.
 *
 * On mobile this pane becomes a bottom sheet (see `app-shell__pane--preview`
 * in global.css). The optional `onClose` is the dismissal handler; `swipeProps`
 * wires the whole sheet for swipe-down-to-dismiss — the handler itself yields
 * to native scrolling whenever the message isn't at its top.
 */

import { useMemo, type HTMLAttributes, type MouseEvent as ReactMouseEvent } from "react";
import { useMessageStore, selectMessage } from "@/core/state/messageStore";
import type { WebhookMessage } from "@/core/schema/types";
import { ComponentRenderer } from "./renderers/ComponentRenderer";
import { PreviewCloseContext } from "./previewCloseContext";
import styles from "./Preview.module.css";

interface PreviewProps {
  /** Dismiss handler — invoked by the mobile swipe-down gesture. */
  onClose?: () => void;
  /** Touch handlers wiring the mobile sheet for swipe-to-dismiss. */
  swipeProps?: HTMLAttributes<HTMLElement>;
  /**
   * Render this message instead of the live editor message. Used by the
   * Template Gallery to show a faithful, read-only thumbnail of each template
   * (the card wraps the preview in an `inert`, scaled stage). Omit it and the
   * preview tracks the editor store as usual.
   */
  message?: WebhookMessage;
}

export function Preview({ onClose, swipeProps, message: messageOverride }: PreviewProps = {}) {
  const storeMessage = useMessageStore(selectMessage);
  const message = messageOverride ?? storeMessage;
  const select = useMessageStore((s) => s.select);
  const displayName = message.username || "Webhook";
  const avatar = message.avatar_url;
  // The "sent at" time stands in for when the message would post; it shouldn't
  // tick (and re-run an Intl formatter) on every keystroke, so freeze it at
  // mount. Preview re-renders on every message edit, so this was pure waste.
  const sentTime = useMemo(
    () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    [],
  );

  // Clicking empty preview space — anywhere that isn't a rendered component
  // (each carries `data-node-id`) or an interactive control like the
  // avatar/username buttons — clears the active selection, so the builder's
  // inline inspector collapses. Read `selectedId` lazily via `getState()`
  // rather than subscribing, so the preview doesn't re-render on selection.
  const clearSelectionOnBackdrop = (e: ReactMouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("[data-node-id], button, a, input, textarea")) return;
    if (useMessageStore.getState().selectedId !== null) select(null);
  };

  const focusMetaField = (field: "username" | "avatar") => {
    // Close the mobile sheet first so the builder is visible. No-op on
    // desktop since the preview pane is always shown there.
    onClose?.();
    // Defer so the sheet has begun closing before we scroll/focus.
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-meta-field="${field}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus({ preventScroll: true });
      el.select();
    });
  };

  return (
    <PreviewCloseContext.Provider value={onClose ?? null}>
      <div className={styles.surface} data-preview-root {...swipeProps}>
        {onClose ? (
          <div className={styles.mobileBar}>
            <span className={styles.grabber} aria-hidden="true" />
          </div>
        ) : null}
        <div className={styles.scroll} data-preview-scroll onClick={clearSelectionOnBackdrop}>
          <article className={styles.message} aria-label="Message preview">
            <button
              type="button"
              className={avatar ? styles.avatar : `${styles.avatar} ${styles.avatarEmpty}`}
              onClick={() => focusMetaField("avatar")}
              aria-label="Edit avatar URL"
              title="Edit avatar URL"
            >
              {avatar ? (
                <img src={avatar} alt="" loading="lazy" />
              ) : (
                <svg
                  className={styles.avatarFallback}
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    fill="currentColor"
                    d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03c-1.5.26-2.93.71-4.27 1.33c-.01 0-.02.01-.03.02c-2.72 4.07-3.47 8.03-3.1 11.95c0 .02.01.04.03.05c1.8 1.32 3.53 2.12 5.24 2.65c.03.01.06 0 .07-.02c.4-.55.76-1.13 1.07-1.74c.02-.04 0-.08-.04-.09c-.57-.22-1.11-.48-1.64-.78c-.04-.02-.04-.08-.01-.11c.11-.08.22-.17.33-.25c.02-.02.05-.02.07-.01c3.44 1.57 7.15 1.57 10.55 0c.02-.01.05-.01.07.01c.11.09.22.17.33.26c.04.03.04.09-.01.11c-.52.31-1.07.56-1.64.78c-.04.01-.05.06-.04.09c.32.61.68 1.19 1.07 1.74c.03.01.06.02.09.01c1.72-.53 3.45-1.33 5.25-2.65c.02-.01.03-.03.03-.05c.44-4.53-.73-8.46-3.1-11.95c-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.83 2.12-1.89 2.12z"
                  />
                </svg>
              )}
            </button>
            <div className={styles.body}>
              <header className={styles.header}>
                <button
                  type="button"
                  className={styles.name}
                  onClick={() => focusMetaField("username")}
                  aria-label="Edit username"
                  title="Edit username"
                >
                  {displayName}
                </button>
                <span className={styles.badge}>APP</span>
                <time className={styles.time}>{sentTime}</time>
              </header>
              <div className={styles.content}>
                {message.components.length === 0 ? (
                  <p className={styles.empty}>This message has no components yet.</p>
                ) : (
                  message.components.map((c) => <ComponentRenderer key={c._id} node={c} />)
                )}
              </div>
            </div>
          </article>
        </div>
      </div>
    </PreviewCloseContext.Provider>
  );
}
