/**
 * Origin-guild mismatch warning.
 *
 * When the editor is linked to a live message (loaded via Restore, reopened
 * from the "Message directory" gallery, or re-targeted right after a send),
 * the action bar already shows the whole story: the destination chip points at
 * the message's channel and the primary action reads "Update", with "New" for
 * a separate copy — and re-pointing the chip flips the primary back to "Send".
 * So the old always-on "Updating a message … [Detach]" info bar is gone; the
 * bar carries that state now.
 *
 * What remains is the one situation that still needs a banner: an
 * origin-guild mismatch. A reloaded message remembers the server it was posted
 * to; when that differs from the editor's connected guild, the preview
 * resolves `<@&role>` / `<#channel>` / `<:emoji:>` against the wrong server
 * and shows placeholder names — so the message looks broken when it isn't.
 * Reloading from the gallery already auto-switches the connected guild when
 * the user belongs to the origin server (see {@link alignConnectedGuild});
 * this covers what's left (not a member, or manually switched away),
 * explaining the mismatch and offering "Switch server". The update itself
 * never rides on the connected guild — only on the stored webhook URL.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { isProxyConfigured } from "@/core/guild/config";
import { alignConnectedGuild } from "@/core/guild/originGuild";
import { Button } from "@/ui/Button";
import { AlertTriangleIcon } from "@/ui/Icon";
import { cn } from "@/lib/cn";
import styles from "./PostedMessageBanner.module.css";

export function PostedMessageBanner() {
  const origin = useMessageStore((s) => s.restoredFrom);
  const connectedGuildId = useGuildStore((s) => s.guildId);
  const authGuilds = useAuthStore((s) => s.guilds);

  if (!origin) return null;

  const originGuildId = origin.guildId;
  // Only meaningful when we know the message's home server, the proxy can
  // resolve names at all, and that server differs from the connected one.
  const mismatch =
    originGuildId != null && isProxyConfigured() && originGuildId !== connectedGuildId;
  if (!mismatch) return null;

  const originName = origin.guildName ?? "another server";
  const connectedName = authGuilds.find((g) => g.id === connectedGuildId)?.name;
  // A reactive read of membership — the "Switch" affordance appears once the
  // guild list loads, even if the banner rendered before it did.
  const isMember = authGuilds.some((g) => g.id === originGuildId);

  return (
    <div className={cn(styles.bar, styles.warn)} role="note">
      <AlertTriangleIcon size={16} className={styles.icon} />
      <div className={styles.text}>
        <span className={styles.title}>Updating a message posted to {originName}</span>
        <span className={styles.detail}>
          {connectedGuildId ? (
            <>
              You&rsquo;re connected to <strong>{connectedName ?? "a different server"}</strong>, so
              its @mentions, #channels and custom emoji below may show placeholder names.
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
      {isMember ? (
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={() => alignConnectedGuild(originGuildId)}>
            Switch server
          </Button>
        </div>
      ) : null}
    </div>
  );
}
