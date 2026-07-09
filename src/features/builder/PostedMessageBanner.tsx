/**
 * Posted-message link indicator.
 *
 * When the editor is linked to a message that's already live on Discord —
 * loaded via Restore, reopened from the "Message directory" gallery, or
 * re-targeted right after a successful send — the toolbar's primary action
 * becomes "Update" and the next post PATCHes that message in place instead of
 * posting a new one (see {@link RestoredOrigin}). That binding is otherwise
 * invisible — the only signal is the button label — and there's no in-editor
 * way to drop it (the Send and Update screens are now separate dialog tabs).
 *
 * This renders a slim bar at the top of the scrolling tree (so it scrolls away
 * with the content rather than pinning to the top) with a real **Detach** button
 * ({@link clearRestoreOrigin}) that flips the toolbar back to "Send". Detaching
 * loses the stored webhook + message id, so it's forgiving — a short Undo window
 * re-links ({@link setRestoreOrigin}) if it was a slip.
 *
 * On an origin-guild mismatch it turns into a warning. A reloaded message
 * remembers the server it was posted to; when that differs from the editor's
 * connected guild, the preview resolves `<@&role>` / `<#channel>` / `<:emoji:>`
 * against the wrong server and shows placeholder names — so the message looks
 * broken when it isn't. Reloading from the gallery already auto-switches the
 * connected guild when the user belongs to the origin server (see
 * {@link alignConnectedGuild}); this covers what's left (not a member, or
 * manually switched away), turning amber, explaining the mismatch, and offering
 * "Switch server". The update itself never rides on the connected guild — only
 * on the stored webhook URL.
 */

import { useEffect, useState } from "react";
import { useMessageStore, type RestoredOrigin } from "@/core/state/messageStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { isProxyConfigured } from "@/core/guild/config";
import { alignConnectedGuild } from "@/core/guild/originGuild";
import { Button } from "@/ui/Button";
import { AlertTriangleIcon, InfoIcon } from "@/ui/Icon";
import { cn } from "@/lib/cn";
import styles from "./PostedMessageBanner.module.css";

/** How long the post-detach "Undo" affordance stays up before fading. */
const UNDO_WINDOW_MS = 8000;

export function PostedMessageBanner() {
  const origin = useMessageStore((s) => s.restoredFrom);
  const clearRestoreOrigin = useMessageStore((s) => s.clearRestoreOrigin);
  const setRestoreOrigin = useMessageStore((s) => s.setRestoreOrigin);
  const connectedGuildId = useGuildStore((s) => s.guildId);
  const authGuilds = useAuthStore((s) => s.guilds);

  // The link just dropped by Detach, kept briefly so the confirmation can offer
  // an Undo. Auto-clears after the window (and on unmount) so it never lingers
  // into a later, unrelated message.
  const [detached, setDetached] = useState<RestoredOrigin | null>(null);
  useEffect(() => {
    if (!detached) return;
    const t = setTimeout(() => setDetached(null), UNDO_WINDOW_MS);
    return () => clearTimeout(t);
  }, [detached]);
  // Any new link (re-attach, a fresh restore, or another send) supersedes a
  // lingering "Detached" note.
  useEffect(() => {
    if (origin) setDetached(null);
  }, [origin]);

  const handleDetach = () => {
    if (!origin) return;
    setDetached(origin);
    clearRestoreOrigin();
  };

  const handleUndo = () => {
    if (!detached) return;
    setRestoreOrigin(detached);
    setDetached(null);
  };

  // ── Linked: the next post updates a live message ──────────────────────────
  if (origin) {
    const originGuildId = origin.guildId;
    // Only meaningful when we know the message's home server, the proxy can
    // resolve names at all, and that server differs from the connected one.
    const mismatch =
      originGuildId != null && isProxyConfigured() && originGuildId !== connectedGuildId;

    const detachButton = (
      <Button
        variant="secondary"
        size="sm"
        onClick={handleDetach}
        title="Stop updating this message — your next post will create a new one"
      >
        Detach
      </Button>
    );

    // Mismatch — amber, with the placeholder-names reason inline and a fix.
    if (mismatch) {
      const originName = origin.guildName ?? "another server";
      const connectedName = authGuilds.find((g) => g.id === connectedGuildId)?.name;
      // A reactive read of membership — the "Switch" affordance appears once the
      // guild list loads, even if the bar rendered before it did.
      const isMember = authGuilds.some((g) => g.id === originGuildId);
      return (
        <div className={cn(styles.bar, styles.warn)} role="note">
          <AlertTriangleIcon size={16} className={styles.icon} />
          <div className={styles.text}>
            <span className={styles.title}>Updating a message posted to {originName}</span>
            <span className={styles.detail}>
              {connectedGuildId ? (
                <>
                  You&rsquo;re connected to <strong>{connectedName ?? "a different server"}</strong>
                  , so its @mentions, #channels and custom emoji below may show placeholder names.
                </>
              ) : (
                <>
                  No server is connected, so @mentions, #channels and custom emoji below may show
                  placeholder names.
                </>
              )}
              {isMember ? null : " The update still posts to the original message."}
            </span>
          </div>
          <div className={styles.actions}>
            {isMember ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => alignConnectedGuild(originGuildId)}
              >
                Switch server
              </Button>
            ) : null}
            {detachButton}
          </div>
        </div>
      );
    }

    // Happy path — one comfortable line plus the way out.
    return (
      <div className={styles.bar} role="note">
        <InfoIcon size={16} className={styles.icon} />
        <span className={styles.title}>
          Updating a message{origin.guildName ? <> in {origin.guildName}</> : <> you posted</>}
        </span>
        <div className={styles.actions}>{detachButton}</div>
      </div>
    );
  }

  // ── Just detached: a confirmation with a one-click re-link ────────────────
  if (detached) {
    return (
      <div className={styles.bar} role="note">
        <InfoIcon size={16} className={styles.icon} />
        <span className={styles.title}>Detached — your next post will create a new message.</span>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={handleUndo}>
            Undo
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
