/**
 * Compact "which server" chip — a guild's icon + name, for the floating action
 * bars in Send / Restore so the destination server stays visible next to the
 * primary button.
 *
 * Resolves the icon (and a nicer name) from the signed-in user's guild list by
 * id — or, while that list is still loading (two round-trips into every visit),
 * from the connected server's cached identity, so the real icon is there on the
 * first frame instead of popping in. Falls back to a provided name (e.g. the one
 * saved on a pasted webhook, whose server may not be in that list) and an
 * initial-letter glyph when there's no icon. Renders nothing when neither a
 * guild nor a fallback name is known, so the bar collapses to just the button on
 * the signed-out / paste-only path.
 */

import { useMemo } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import { guildIconUrl } from "@/core/guild/api";
import { resolveGuildIdentity, type GuildIdentityInfo } from "@/core/guild/identityCache";
import { cn } from "@/lib/cn";
import styles from "./GuildIdentity.module.css";

/**
 * A server's display identity (name + icon), live list first and last-known
 * identity second. Shared with the surfaces that decide whether they know the
 * server at all — the Message directory swaps its generic glyph for the real
 * server icon on this.
 */
export function useGuildIdentity(guildId?: string | null): GuildIdentityInfo | null {
  const guilds = useAuthStore((s) => s.guilds);
  return useMemo(() => resolveGuildIdentity(guildId, guilds), [guildId, guilds]);
}

export function GuildIdentity({
  guildId,
  fallbackName,
  label = "Posting to",
  compact = false,
}: {
  /** The destination server's id — resolves icon + name from the guild list. */
  guildId?: string | null;
  /** Name to show when the id isn't in the guild list (e.g. a pasted webhook). */
  fallbackName?: string;
  /** Short prefix shown above the name. "Posting to" (Send) / "Server" (Restore). */
  label?: string;
  /** Render just the icon, with the server name available to assistive tech and
   * in the native tooltip. Useful where the surrounding UI already names the
   * destination and space is deliberately tight. */
  compact?: boolean;
}) {
  const guild = useGuildIdentity(guildId);
  const name = guild?.name ?? fallbackName;
  if (!name) return null;

  // Discord's CDN only serves power-of-two sizes — 64 stays crisp on retina for
  // the 24px chip (36 would 400 as an invalid resource).
  const iconUrl = guild ? guildIconUrl(guild.id, guild.icon, 64) : null;
  const Root = compact ? "span" : "div";
  return (
    <Root
      className={styles.identity}
      data-compact={compact ? "" : undefined}
      title={`${label} ${name}`}
      role={compact ? "img" : undefined}
      aria-label={compact ? `${label}: ${name}` : undefined}
    >
      {iconUrl ? (
        <img className={styles.icon} src={iconUrl} alt="" width={24} height={24} loading="lazy" />
      ) : (
        <span className={cn(styles.icon, styles.iconFallback)} aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      {!compact ? (
        <span className={styles.text}>
          <span className={styles.label}>{label}</span>
          <span className={styles.name}>{name}</span>
        </span>
      ) : null}
    </Root>
  );
}
