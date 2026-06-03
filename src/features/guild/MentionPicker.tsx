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

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useGuildStore } from "@/core/guild/guildStore";
import { EmojiIcon, HashIcon, MentionIcon } from "@/ui/Icon";
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

  const channels = useMemo(() => {
    if (!data) return [];
    return data.channels
      .filter((c) => !query || c.name.toLowerCase().includes(query))
      .sort((a, b) => a.position - b.position)
      .slice(0, MAX_ROWS);
  }, [data, query]);

  const showEveryone = !query || "everyone".includes(query);
  const showHere = !query || "here".includes(query);

  return (
    <div className={styles.panel}>
      {data ? (
        <input
          className={styles.search}
          placeholder="Search roles & channels…"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          aria-label="Search roles and channels"
          autoFocus
        />
      ) : null}

      <div className={styles.list}>
        {showEveryone ? (
          <Row onClick={() => onPick("@everyone")}>
            <MentionIcon size={14} className={styles.rowIcon} />@everyone
          </Row>
        ) : null}
        {showHere ? (
          <Row onClick={() => onPick("@here")}>
            <MentionIcon size={14} className={styles.rowIcon} />@here
          </Row>
        ) : null}

        {roles.length > 0 ? <GroupLabel>Roles</GroupLabel> : null}
        {roles.map((r) => (
          <Row key={r.id} onClick={() => onPick(`<@&${r.id}>`)}>
            <span className={styles.dot} style={roleColorStyle(r.color)} aria-hidden="true" />
            <span className={styles.rowLabel}>@{r.name}</span>
          </Row>
        ))}

        {channels.length > 0 ? <GroupLabel>Channels</GroupLabel> : null}
        {channels.map((c) => (
          <Row key={c.id} onClick={() => onPick(`<#${c.id}>`)}>
            <HashIcon size={13} className={styles.rowIcon} />
            <span className={styles.rowLabel}>{c.name}</span>
          </Row>
        ))}

        <GroupLabel>By ID</GroupLabel>
        <Row onClick={() => onPick("<@USER_ID>", "USER_ID")}>
          <MentionIcon size={14} className={styles.rowIcon} />
          User mention…
        </Row>
        {!data ? (
          <>
            <Row onClick={() => onPick("<@&ROLE_ID>", "ROLE_ID")}>
              <MentionIcon size={14} className={styles.rowIcon} />
              Role mention…
            </Row>
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

export function GuildEmojiPanel({ onPick }: { onPick: Pick }) {
  const data = useGuildStore((s) => s.data);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const emojis = useMemo(() => {
    if (!data) return [];
    return data.emojis
      .filter((e) => e.available && (!query || e.name.toLowerCase().includes(query)))
      .slice(0, 200);
  }, [data, query]);

  if (!data || data.emojis.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.list}>
          <p className={styles.note}>
            {data ? "This server has no custom emoji." : "Connect a server to pick its emoji."}
          </p>
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
        placeholder="Search emoji…"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        aria-label="Search emoji"
        autoFocus
      />
      <div className={styles.emojiGrid}>
        {emojis.map((e) => (
          <button
            key={e.id}
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
        {emojis.length === 0 ? <p className={styles.note}>No matches.</p> : null}
      </div>
    </div>
  );
}
