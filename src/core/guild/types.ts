/**
 * Guild mapping data — the roles, channels, and custom emojis the builder reads
 * from a Discord server through the proxy (`server/`).
 *
 * These shapes mirror the trimmed structs the Rust proxy emits
 * (`server/src/discord.rs`): we deliberately keep only the fields the editor and
 * preview actually use. Anything the proxy adds later is ignored on decode, so
 * the two can evolve independently as long as these fields stay present.
 */

/** A guild role. `color` is Discord's packed integer (`0` means "no color"). */
export interface GuildRole {
  id: string;
  name: string;
  /** Packed RGB integer; `0` renders with Discord's default mention color. */
  color: number;
  /** Higher sits higher in the role list — used to order the role picker. */
  position: number;
  mentionable: boolean;
}

/** A guild channel. `type` is Discord's numeric channel type (0 text, 2 voice…). */
export interface GuildChannel {
  id: string;
  name: string;
  /** Discord channel `type`: 0 text, 2 voice, 4 category, 5 announcement, … */
  type: number;
  position: number;
  /** Parent category id, when the channel lives under one. */
  parentId: string | null;
}

/** A custom guild emoji. `id` + `name` + `animated` rebuild a `<:name:id>` token. */
export interface GuildEmoji {
  id: string;
  name: string;
  animated: boolean;
  /** False when the emoji is unavailable (e.g. lost boost tier). */
  available: boolean;
}

/**
 * One guild's fully-indexed mapping data. The arrays drive list UIs (pickers,
 * the connect panel); the `*ById` records give O(1) lookups for the preview,
 * which resolves a snowflake to a name on every mention render.
 */
export interface GuildData {
  guildId: string;
  roles: GuildRole[];
  channels: GuildChannel[];
  emojis: GuildEmoji[];
  roleById: Record<string, GuildRole>;
  channelById: Record<string, GuildChannel>;
  emojiById: Record<string, GuildEmoji>;
  /** Epoch ms the data was fetched — drives the client-side staleness check. */
  fetchedAt: number;
}
