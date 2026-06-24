/**
 * Origin-guild mismatch banner.
 *
 * A reloaded posted message remembers the server it was posted to (its origin
 * guild). When that differs from the editor's currently-connected guild, the
 * preview resolves `<@&role>` / `<#channel>` / `<:emoji:>` against the wrong
 * server and shows placeholder names — so the message looks broken when it
 * isn't. Reloading from the gallery already auto-switches the connected guild
 * when the user belongs to the origin server (see {@link alignConnectedGuild});
 * this banner covers what's left: the user isn't a member (no switch possible),
 * or they manually switched away afterward. It never blocks anything — sends
 * still land via the stored webhook URL regardless of the connected guild.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { isProxyConfigured } from "@/core/guild/config";
import { alignConnectedGuild } from "@/core/guild/originGuild";
import { Callout } from "@/features/share/Callout";
import { Button } from "@/ui/Button";
import styles from "./OriginGuildBanner.module.css";

export function OriginGuildBanner() {
  const origin = useMessageStore((s) => s.restoredFrom);
  const connectedGuildId = useGuildStore((s) => s.guildId);
  const authGuilds = useAuthStore((s) => s.guilds);

  const originGuildId = origin?.guildId;
  // Only meaningful when we know the message's home server, the proxy can
  // resolve names at all, and that server differs from the connected one.
  if (!originGuildId || !isProxyConfigured() || originGuildId === connectedGuildId) return null;

  const originName = origin?.guildName ?? "another server";
  const connectedName = authGuilds.find((g) => g.id === connectedGuildId)?.name;
  // A reactive read of membership — the "Switch" affordance appears once the
  // guild list loads, even if the banner rendered before it did.
  const isMember = authGuilds.some((g) => g.id === originGuildId);

  return (
    <div className={styles.wrap}>
      <Callout
        tone="warning"
        role="note"
        title={<>Showing a message posted to {originName}</>}
        actions={
          isMember ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => alignConnectedGuild(originGuildId)}
            >
              Switch to {originName}
            </Button>
          ) : undefined
        }
      >
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
        {isMember ? null : " Updates still post to the original message."}
      </Callout>
    </div>
  );
}
