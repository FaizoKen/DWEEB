/**
 * Posted-message link banner.
 *
 * When the editor is linked to a message that's already live on Discord —
 * loaded via Restore, reopened from the "Start a message" gallery, or
 * re-targeted right after a successful send — the toolbar's primary action
 * becomes "Update" and the next post PATCHes that message in place instead of
 * posting a new one (see {@link RestoredOrigin}). That binding is otherwise
 * invisible: the only signal was the button label, and the only way out was the
 * Send panel's local "Send as new" toggle, which doesn't actually drop the link.
 *
 * This banner makes the link visible and reversible: it shows whenever a link
 * is set and offers **Detach** ({@link clearRestoreOrigin}) so the next post is
 * a fresh send. Detaching loses the stored webhook + message id, so it's a
 * forgiving action — a short Undo window re-links ({@link setRestoreOrigin}) if
 * it was a slip.
 *
 * It also absorbs the origin-guild mismatch warning. A reloaded message
 * remembers the server it was posted to; when that differs from the editor's
 * connected guild, the preview resolves `<@&role>` / `<#channel>` / `<:emoji:>`
 * against the wrong server and shows placeholder names — so the message looks
 * broken when it isn't. Reloading from the gallery already auto-switches the
 * connected guild when the user belongs to the origin server (see
 * {@link alignConnectedGuild}); this covers what's left (not a member, or
 * manually switched away). On a mismatch the banner escalates to a warning tone,
 * explains it, and offers "Switch server" when possible. The update itself never
 * rides on the connected guild — only on the stored webhook URL.
 */

import { useEffect, useState } from "react";
import { useMessageStore, type RestoredOrigin } from "@/core/state/messageStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { isProxyConfigured } from "@/core/guild/config";
import { alignConnectedGuild } from "@/core/guild/originGuild";
import { Callout } from "@/features/share/Callout";
import { Button } from "@/ui/Button";
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
    const connectedName = authGuilds.find((g) => g.id === connectedGuildId)?.name;
    // A reactive read of membership — the "Switch" affordance appears once the
    // guild list loads, even if the banner rendered before it did.
    const isMember = originGuildId != null && authGuilds.some((g) => g.id === originGuildId);

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

    if (mismatch) {
      const originName = origin.guildName ?? "another server";
      return (
        <div className={styles.wrap}>
          <Callout
            tone="warning"
            role="note"
            title={<>Updating a message posted to {originName}</>}
            actions={
              <>
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
              </>
            }
          >
            {connectedGuildId ? (
              <>
                You&rsquo;re connected to <strong>{connectedName ?? "a different server"}</strong>,
                so its @mentions, #channels and custom emoji below may show placeholder names.
              </>
            ) : (
              <>
                No server is connected, so @mentions, #channels and custom emoji below may show
                placeholder names.
              </>
            )}
            {isMember ? null : " The update still posts to the original message."}
          </Callout>
        </div>
      );
    }

    // Linked, no mismatch — a calm, neutral indicator plus the way out.
    return (
      <div className={styles.wrap}>
        <Callout
          tone="info"
          role="note"
          title={
            origin.guildName ? (
              <>Updating a message in {origin.guildName}</>
            ) : (
              <>Updating a message</>
            )
          }
          actions={detachButton}
        >
          Your next post edits this message in place instead of creating a new one.
        </Callout>
      </div>
    );
  }

  // ── Just detached: confirm it and offer a one-click re-link ───────────────
  if (detached) {
    return (
      <div className={styles.wrap}>
        <Callout
          tone="info"
          role="note"
          title={<>Detached from the posted message</>}
          actions={
            <Button variant="secondary" size="sm" onClick={handleUndo}>
              Undo
            </Button>
          }
        >
          Your next post will create a new message.
        </Callout>
      </div>
    );
  }

  return null;
}
