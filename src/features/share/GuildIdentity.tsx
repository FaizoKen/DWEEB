/**
 * Compact "which server" chip — a guild's icon + name, for the floating action
 * bars in Send / Restore so the destination server stays visible next to the
 * primary button.
 *
 * Resolves the icon (and a nicer name) from the signed-in user's guild list by
 * id; falls back to a provided name (e.g. the one saved on a pasted webhook,
 * whose server may not be in that list) and an initial-letter glyph when there's
 * no icon. Renders nothing when neither a guild nor a fallback name is known, so
 * the bar collapses to just the button on the signed-out / paste-only path.
 */

import { useAuthStore } from "@/core/auth/authStore";
import { guildIconUrl } from "@/core/guild/api";
import { cn } from "@/lib/cn";
import styles from "./GuildIdentity.module.css";

export function GuildIdentity({
  guildId,
  fallbackName,
  label = "Posting to",
}: {
  /** The destination server's id — resolves icon + name from the guild list. */
  guildId?: string | null;
  /** Name to show when the id isn't in the guild list (e.g. a pasted webhook). */
  fallbackName?: string;
  /** Short prefix shown above the name. "Posting to" (Send) / "Server" (Restore). */
  label?: string;
}) {
  const guilds = useAuthStore((s) => s.guilds);
  const guild = guildId ? guilds.find((g) => g.id === guildId) : undefined;
  const name = guild?.name ?? fallbackName;
  if (!name) return null;

  // Discord's CDN only serves power-of-two sizes — 64 stays crisp on retina for
  // the 24px chip (36 would 400 as an invalid resource).
  const iconUrl = guild ? guildIconUrl(guild.id, guild.icon, 64) : null;
  return (
    <div className={styles.identity} title={`${label} ${name}`}>
      {iconUrl ? (
        <img className={styles.icon} src={iconUrl} alt="" width={24} height={24} loading="lazy" />
      ) : (
        <span className={cn(styles.icon, styles.iconFallback)} aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        <span className={styles.name}>{name}</span>
      </span>
    </div>
  );
}
