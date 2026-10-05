/**
 * Where a post goes, as the core placeholders see it.
 *
 * Send now, a new scheduled post and a schedule save all render the message's
 * `{server}` / `{channel}` / `{server_icon}`… tokens before it leaves, and they
 * used to build that context three different ways: the schedule paths left
 * out the server icon and the channel's category (so `avatar_url:
 * {server_icon}` was stored literally, a value Discord refuses at fire time),
 * and every path took names from what the panel knew when it last rendered —
 * undefined for a webhook verified moments earlier, so `{server}` went out as
 * "this server". One builder, fed the ids this very post resolved, fixes all
 * three.
 */

import { guildIconUrl } from "@/core/guild/api";
import type { PlaceholderContext } from "@/core/plugins/placeholders";

interface GuildLike {
  id: string;
  name: string;
  icon?: string | null;
}

interface ChannelLike {
  name: string;
  parentId?: string | null;
}

/**
 * The core placeholder context for one post: the destination's ids as this post
 * resolved them, names saved on the webhook's own entry or else looked up by
 * those ids, the server's icon from the signed-in server list, and the
 * channel's category from the connected server's channels.
 */
export function destinationPlaceholderContext(
  dest: { guildId?: string; channelId?: string; guildName?: string; channelName?: string },
  guilds: readonly GuildLike[],
  channelById: Readonly<Record<string, ChannelLike | undefined>> | undefined,
): PlaceholderContext {
  const guild = dest.guildId ? guilds.find((g) => g.id === dest.guildId) : undefined;
  const channel = dest.channelId ? channelById?.[dest.channelId] : undefined;
  const parentId = channel?.parentId;
  return {
    serverId: dest.guildId,
    serverName: dest.guildName ?? guild?.name,
    serverIcon: guild ? (guildIconUrl(guild.id, guild.icon ?? null) ?? undefined) : undefined,
    channelId: dest.channelId,
    channelName: dest.channelName ?? channel?.name,
    channelCategory: parentId ? channelById?.[parentId]?.name : undefined,
  };
}

/** The server refuses a scheduled post's destination label past 200 characters. */
const MAX_DEST_LABEL_CHARS = 200;

/**
 * A scheduled post's display-only destination, `#channel · Server` — trimmed to
 * the server's limit, counted in characters as the server counts them. Two
 * 100-character names used to fail the whole schedule with "Destination label
 * is too long."
 */
export function scheduleDestLabel(guildName?: string, channelName?: string): string | undefined {
  const label = channelName && guildName ? `#${channelName} · ${guildName}` : guildName;
  if (!label) return undefined;
  const chars = Array.from(label);
  if (chars.length <= MAX_DEST_LABEL_CHARS) return label;
  return `${chars.slice(0, MAX_DEST_LABEL_CHARS - 1).join("")}…`;
}
