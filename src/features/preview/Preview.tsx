/**
 * Preview pane.
 *
 * Renders a fake Discord channel "frame" around the user's message so the
 * webhook output is shown in its real visual context. Subscribes only to
 * the message slice of the store so unrelated state (selection, modals)
 * doesn't trigger preview re-renders.
 */

import { useMessageStore, selectMessage } from "@/core/state/messageStore";
import { ComponentRenderer } from "./renderers/ComponentRenderer";
import styles from "./Preview.module.css";

export function Preview() {
  const message = useMessageStore(selectMessage);
  const displayName = message.username || "Webhook";
  const avatar = message.avatar_url;

  return (
    <div className={styles.surface} data-preview-root>
      <div className={styles.scroll}>
        <article className={styles.message} aria-label="Message preview">
          <div className={styles.avatar}>
            {avatar ? (
              <img src={avatar} alt="" loading="lazy" />
            ) : (
              <div className={styles.avatarFallback} aria-hidden="true">
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <div className={styles.body}>
            <header className={styles.header}>
              <span className={styles.name}>{displayName}</span>
              <span className={styles.badge}>APP</span>
              <time className={styles.time}>Today at {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
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
  );
}
