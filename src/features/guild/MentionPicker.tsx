/**
 * Guild-aware token pickers for the markdown toolbar.
 *
 * These panels live inside the toolbar's dropdown `Menu`. When a server is
 * connected they let the user search and insert a *real* role/channel mention
 * (`<@&id>` / `<#id>`) or custom emoji (`<:name:id>`) — turning the loaded
 * mapping data into one-click inserts. With no server connected they fall back
 * to the by-ID placeholders, so the toolbar keeps working offline.
 *
 * `onPick(snippet, selectToken?)` hands the chosen token back to the toolbar,
 * which inserts it at the caret and closes the menu.
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { useEmojiStore } from "@/core/guild/emojiStore";
import { EmojiIcon, HashIcon, MentionIcon } from "@/ui/Icon";
import { GUILD_NAV_ITEMS } from "@/ui/guildNav";
import styles from "./MentionPicker.module.css";

type Pick = (snippet: string, selectToken?: string) => void;

/** Cap rendered rows so a huge server can't render thousands of nodes at once. */
const MAX_ROWS = 60;

function roleColorStyle(color: number): CSSProperties | undefined {
  if (!color) return undefined;
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return { background: `rgb(${r}, ${g}, ${b})` };
}

function Row({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" className={styles.row} onClick={onClick}>
      {children}
    </button>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <div className={styles.groupLabel}>{children}</div>;
}

/**
 * Role / user mention picker. Lists `@everyone`, `@here`, and the server's real
 * roles, plus a user-by-ID escape hatch (users can't be enumerated). Channels
 * live in their own `GuildChannelPanel` so each dropdown stays focused.
 */
export function GuildMentionPanel({ onPick }: { onPick: Pick }) {
  const data = useGuildStore((s) => s.data);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const roles = useMemo(() => {
    if (!data) return [];
    return data.roles
      .filter((r) => r.id !== data.guildId && (!query || r.name.toLowerCase().includes(query)))
      .sort((a, b) => b.position - a.position)
      .slice(0, MAX_ROWS);
  }, [data, query]);

  const showEveryone = !query || "everyone".includes(query);
  const showHere = !query || "here".includes(query);

  return (
    <div className={styles.panel}>
      {data ? (
        <input
          className={styles.search}
          placeholder="Search roles…"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          aria-label="Search roles"
          autoFocus
        />
      ) : null}

      <div className={styles.list}>
        {showEveryone ? (
          <Row onClick={() => onPick("@everyone")}>
            <MentionIcon size={14} className={styles.rowIcon} />
            @everyone
          </Row>
        ) : null}
        {showHere ? (
          <Row onClick={() => onPick("@here")}>
            <MentionIcon size={14} className={styles.rowIcon} />
            @here
          </Row>
        ) : null}

        {roles.length > 0 ? <GroupLabel>Roles</GroupLabel> : null}
        {roles.map((r) => (
          <Row key={r.id} onClick={() => onPick(`<@&${r.id}>`)}>
            <span className={styles.dot} style={roleColorStyle(r.color)} aria-hidden="true" />
            <span className={styles.rowLabel}>@{r.name}</span>
          </Row>
        ))}

        <GroupLabel>By ID</GroupLabel>
        <Row onClick={() => onPick("<@USER_ID>", "USER_ID")}>
          <MentionIcon size={14} className={styles.rowIcon} />
          User mention…
        </Row>
        {!data ? (
          <Row onClick={() => onPick("<@&ROLE_ID>", "ROLE_ID")}>
            <MentionIcon size={14} className={styles.rowIcon} />
            Role mention…
          </Row>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Channel mention picker. Lists the server's real channels and Discord's
 * built-in server-navigation links (`<id:…>`: Browse Channels, Channels &
 * Roles, …), with a channel-by-ID escape hatch when no server is connected.
 */
export function GuildChannelPanel({ onPick }: { onPick: Pick }) {
  const data = useGuildStore((s) => s.data);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const channels = useMemo(() => {
    if (!data) return [];
    return data.channels
      .filter((c) => !query || c.name.toLowerCase().includes(query))
      .sort((a, b) => a.position - b.position)
      .slice(0, MAX_ROWS);
  }, [data, query]);

  const navItems = useMemo(
    () => GUILD_NAV_ITEMS.filter((item) => !query || item.label.toLowerCase().includes(query)),
    [query],
  );

  return (
    <div className={styles.panel}>
      {data ? (
        <input
          className={styles.search}
          placeholder="Search channels…"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          aria-label="Search channels"
          autoFocus
        />
      ) : null}

      <div className={styles.list}>
        {channels.length > 0 ? <GroupLabel>Channels</GroupLabel> : null}
        {channels.map((c) => (
          <Row key={c.id} onClick={() => onPick(`<#${c.id}>`)}>
            <HashIcon size={13} className={styles.rowIcon} />
            <span className={styles.rowLabel}>{c.name}</span>
          </Row>
        ))}

        {navItems.length > 0 ? <GroupLabel>Server</GroupLabel> : null}
        {navItems.map((item) => (
          <Row key={item.type} onClick={() => onPick(item.snippet)}>
            <item.Icon size={14} className={styles.rowIcon} />
            <span className={styles.rowLabel}>{item.label}</span>
          </Row>
        ))}

        {!data ? (
          <>
            <GroupLabel>By ID</GroupLabel>
            <Row onClick={() => onPick("<#CHANNEL_ID>", "CHANNEL_ID")}>
              <HashIcon size={13} className={styles.rowIcon} />
              Channel mention…
            </Row>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Cap emoji rendered per server so a huge server can't flood the grid. */
const MAX_EMOJI_PER_GUILD = 200;

export function GuildEmojiPanel({ onPick }: { onPick: Pick }) {
  const connectedId = useGuildStore((s) => s.guildId);
  const connectedData = useGuildStore((s) => s.data);
  const guilds = useAuthStore((s) => s.guilds);
  const byGuild = useEmojiStore((s) => s.byGuild);
  const loading = useEmojiStore((s) => s.status === "loading");
  const seed = useEmojiStore((s) => s.seed);
  const loadFor = useEmojiStore((s) => s.loadFor);

  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  // Every server the bot is in is fair game: a webhook can render custom emoji
  // from any server it shares. (The connected one is always included even if its
  // `bot_present` flag hasn't refreshed yet.)
  const botGuilds = useMemo(
    () => guilds.filter((g) => g.bot_present || g.id === connectedId),
    [guilds, connectedId],
  );

  // Seed the connected server's already-loaded emoji, then fetch the rest.
  useEffect(() => {
    if (connectedId && connectedData?.guildId === connectedId) {
      seed(connectedId, connectedData.emojis);
    }
    if (botGuilds.length > 0) void loadFor(botGuilds.map((g) => g.id));
  }, [connectedId, connectedData, botGuilds, seed, loadFor]);

  // One group per server, connected first then alphabetical; empty groups drop.
  const groups = useMemo(() => {
    const ordered = [...botGuilds].sort((a, b) => {
      if (a.id === connectedId) return -1;
      if (b.id === connectedId) return 1;
      return a.name.localeCompare(b.name);
    });
    return ordered
      .map((g) => ({
        id: g.id,
        name: g.name,
        emojis: (byGuild[g.id] ?? [])
          .filter((e) => e.available && (!query || e.name.toLowerCase().includes(query)))
          .slice(0, MAX_EMOJI_PER_GUILD),
      }))
      .filter((g) => g.emojis.length > 0);
  }, [botGuilds, byGuild, connectedId, query]);

  const loadedAny = botGuilds.some((g) => (byGuild[g.id] ?? []).length > 0);

  // Not signed in / no bot servers — keep the by-ID escape hatch.
  if (botGuilds.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.list}>
          <p className={styles.note}>Connect a server to pick its emoji.</p>
          <Row onClick={() => onPick("<:name:000000000000000000>", "name")}>
            <EmojiIcon size={14} className={styles.rowIcon} />
            Custom emoji by ID…
          </Row>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <input
        className={styles.search}
        placeholder="Search emoji across your servers…"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        aria-label="Search emoji"
        autoFocus
      />
      <div className={styles.emojiScroll}>
        {groups.map((group) => (
          <div key={group.id} className={styles.emojiGroup}>
            <GroupLabel>{group.name}</GroupLabel>
            <div className={styles.emojiGrid}>
              {group.emojis.map((e) => (
                <button
                  key={`${group.id}:${e.id}`}
                  type="button"
                  className={styles.emojiBtn}
                  title={`:${e.name}:`}
                  onClick={() => onPick(`<${e.animated ? "a" : ""}:${e.name}:${e.id}>`)}
                >
                  <img
                    className={styles.emojiImg}
                    src={`https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "webp"}?size=32&quality=lossless`}
                    alt={`:${e.name}:`}
                    loading="lazy"
                    decoding="async"
                  />
                </button>
              ))}
            </div>
          </div>
        ))}

        {groups.length === 0 ? (
          <p className={styles.note}>
            {loading && !loadedAny
              ? "Loading emoji…"
              : query
                ? "No matches."
                : "No custom emoji found in your servers."}
          </p>
        ) : loading ? (
          <p className={styles.note}>Loading more…</p>
        ) : null}

        <Row onClick={() => onPick("<:name:000000000000000000>", "name")}>
          <EmojiIcon size={14} className={styles.rowIcon} />
          Custom emoji by ID…
        </Row>
      </div>
    </div>
  );
}
