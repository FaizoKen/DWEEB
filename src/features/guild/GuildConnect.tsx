/**
 * Server-data panel (Discord-login gated).
 *
 * Flow:
 *   1. Not signed in → "Sign in with Discord" (full-page redirect to the proxy).
 *   2. Signed in → a picker of the user's manageable servers. Servers the bot is
 *      already in load immediately; for the rest we show an "add the bot" link.
 *   3. A loaded server shows its emoji, colored role chips, and channel names —
 *      proof the data arrived, and the same data the live preview uses to
 *      resolve `<@&id>` / `<#id>` mentions to real names.
 *
 * Only rendered when a proxy base URL is configured; the caller guards on that.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { botInviteUrl } from "@/core/guild/config";
import type { GuildChannel, GuildEmoji, GuildRole } from "@/core/guild/types";
import type { PickerGuild } from "@/core/guild/api";
import { Button } from "@/ui/Button";
import { HashIcon } from "@/ui/Icon";
import { cn } from "@/lib/cn";
import styles from "./GuildConnect.module.css";

/** Discord emoji CDN URL for a custom emoji id. */
function emojiUrl(emoji: GuildEmoji): string {
  const ext = emoji.animated ? "gif" : "webp";
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}?size=32&quality=lossless`;
}

/** Packed role color → `r, g, b` triplet for CSS, or null for "no color". */
function roleRgb(color: number): string | null {
  if (!color) return null;
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `${r}, ${g}, ${b}`;
}

export function GuildConnect() {
  const authStatus = useAuthStore((s) => s.status);
  const initAuth = useAuthStore((s) => s.init);

  // Resolve the session once on mount.
  useEffect(() => {
    void initAuth();
  }, [initAuth]);

  return (
    <section className={styles.panel} aria-label="Discord server data">
      <header className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleText}>Server data</span>
          <StatusBadge />
        </div>
        <p className={styles.subtitle}>
          Sign in with Discord to load a server's roles, channels, and emoji so
          mentions resolve to real names in the preview.
        </p>
      </header>

      {authStatus === "unknown" || authStatus === "loading" ? (
        <p className={styles.hint}>Checking sign-in…</p>
      ) : authStatus === "anon" ? (
        <SignIn />
      ) : (
        <SignedIn />
      )}
    </section>
  );
}

function StatusBadge() {
  const authStatus = useAuthStore((s) => s.status);
  const connected = useGuildStore((s) => Boolean(s.data));
  const loading = useGuildStore((s) => s.status === "loading");

  if (authStatus === "loading" || authStatus === "unknown") {
    return <span className={cn(styles.badge, styles.badgeIdle)}>…</span>;
  }
  if (authStatus === "anon") {
    return <span className={cn(styles.badge, styles.badgeIdle)}>Signed out</span>;
  }
  if (loading) {
    return <span className={cn(styles.badge, styles.badgeLoading)}>Loading</span>;
  }
  if (connected) {
    return <span className={cn(styles.badge, styles.badgeOk)}>Loaded</span>;
  }
  return <span className={cn(styles.badge, styles.badgeOk)}>Signed in</span>;
}

function SignIn() {
  const login = useAuthStore((s) => s.login);
  return (
    <div className={styles.signIn}>
      <Button variant="primary" size="sm" onClick={login}>
        Sign in with Discord
      </Button>
      <p className={styles.hint}>
        We request read-only access to your account and your server list, and only
        load data for servers you manage. Your login never touches the page.
      </p>
    </div>
  );
}

function SignedIn() {
  const user = useAuthStore((s) => s.user);
  const guilds = useAuthStore((s) => s.guilds);
  const guildsStatus = useAuthStore((s) => s.guildsStatus);
  const guildsError = useAuthStore((s) => s.guildsError);
  const loadGuilds = useAuthStore((s) => s.loadGuilds);
  const logout = useAuthStore((s) => s.logout);

  const connectedId = useGuildStore((s) => s.guildId);
  const connect = useGuildStore((s) => s.connect);

  const [selectedId, setSelectedId] = useState(connectedId);

  // Keep the picker in sync if a guild gets connected from cache on load.
  useEffect(() => {
    if (connectedId && !selectedId) setSelectedId(connectedId);
  }, [connectedId, selectedId]);

  const selected = guilds.find((g) => g.id === selectedId) ?? null;

  const onPick = (id: string) => {
    setSelectedId(id);
    const g = guilds.find((x) => x.id === id);
    if (id && g?.bot_present) void connect(id);
  };

  return (
    <div className={styles.signedIn}>
      <div className={styles.userRow}>
        <Avatar user={user} />
        <span className={styles.userName}>{user?.name ?? "Signed in"}</span>
        <button type="button" className={styles.linkBtn} onClick={() => void logout()}>
          Sign out
        </button>
      </div>

      {guildsStatus === "loading" ? (
        <p className={styles.hint}>Loading your servers…</p>
      ) : guildsStatus === "error" ? (
        <p className={cn(styles.notice, styles.noticeError)} role="alert">
          {guildsError ?? "Couldn't load your servers."}{" "}
          <button type="button" className={styles.linkBtn} onClick={() => void loadGuilds()}>
            Retry
          </button>
        </p>
      ) : guilds.length === 0 ? (
        <NoGuilds onRefresh={() => void loadGuilds()} />
      ) : (
        <>
          <div className={styles.pickerRow}>
            <select
              className={styles.select}
              value={selectedId}
              onChange={(e) => onPick(e.currentTarget.value)}
              aria-label="Choose a server"
            >
              <option value="">Choose a server…</option>
              {[...guilds]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                    {g.bot_present ? "" : " — add bot"}
                  </option>
                ))}
            </select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadGuilds()}
              title="Refresh your server list"
            >
              ↻
            </Button>
          </div>

          {selected && !selected.bot_present ? <AddBot guild={selected} /> : null}

          <ServerData selectedId={selectedId} />
        </>
      )}
    </div>
  );
}

function Avatar({ user }: { user: { name: string; avatar_url: string | null } | null }) {
  if (user?.avatar_url) {
    return <img className={styles.avatar} src={user.avatar_url} alt="" width={24} height={24} />;
  }
  const initial = (user?.name ?? "?").slice(0, 1).toUpperCase();
  return <span className={cn(styles.avatar, styles.avatarFallback)}>{initial}</span>;
}

function NoGuilds({ onRefresh }: { onRefresh: () => void }) {
  const invite = botInviteUrl();
  return (
    <div className={styles.signIn}>
      <p className={styles.hint}>
        No servers you manage were found. Add the DWEEB bot to a server you own or
        manage, then refresh.
      </p>
      <div className={styles.ctaRow}>
        {invite ? (
          <a className={styles.inviteLink} href={invite} target="_blank" rel="noreferrer noopener">
            Add DWEEB to a server
          </a>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

function AddBot({ guild }: { guild: PickerGuild }) {
  const invite = botInviteUrl();
  const loadGuilds = useAuthStore((s) => s.loadGuilds);
  return (
    <div className={cn(styles.notice, styles.noticeWarn)}>
      The DWEEB bot isn't in <strong>{guild.name}</strong> yet.{" "}
      {invite ? (
        <a className={styles.inviteLink} href={invite} target="_blank" rel="noreferrer noopener">
          Add it
        </a>
      ) : (
        "Add the bot"
      )}
      , then{" "}
      <button type="button" className={styles.linkBtn} onClick={() => void loadGuilds()}>
        refresh
      </button>
      .
    </div>
  );
}

/** The loaded roles/channels/emoji for the selected server. */
function ServerData({ selectedId }: { selectedId: string }) {
  const data = useGuildStore((s) => s.data);
  const status = useGuildStore((s) => s.status);
  const error = useGuildStore((s) => s.error);

  if (!selectedId) return null;
  if (status === "loading" && data?.guildId !== selectedId) {
    return <p className={styles.hint}>Loading server data…</p>;
  }
  if (error && (!data || data.guildId !== selectedId)) {
    return (
      <p className={cn(styles.notice, styles.noticeError)} role="alert">
        {error}
      </p>
    );
  }
  if (!data || data.guildId !== selectedId) return null;

  return (
    <div className={styles.loaded}>
      {error ? (
        <p className={cn(styles.notice, styles.noticeWarn)} role="alert">
          Couldn't refresh: {error} Showing cached data.
        </p>
      ) : null}

      <div className={styles.counts}>
        <CountPill n={data.emojis.length} label="emoji" />
        <CountPill n={data.roles.length} label="roles" />
        <CountPill n={data.channels.length} label="channels" />
      </div>

      {data.emojis.length > 0 ? (
        <DataGroup title="Emoji">
          <div className={styles.emojiGrid}>
            {data.emojis.map((e) => (
              <img
                key={e.id}
                className={styles.emoji}
                src={emojiUrl(e)}
                alt={`:${e.name}:`}
                title={`:${e.name}:`}
                loading="lazy"
                decoding="async"
              />
            ))}
          </div>
        </DataGroup>
      ) : null}

      {data.roles.length > 0 ? (
        <DataGroup title="Roles">
          <div className={styles.chipWrap}>
            {[...data.roles]
              .sort((a, b) => b.position - a.position)
              .map((r) => (
                <RoleChip key={r.id} role={r} guildId={data.guildId} />
              ))}
          </div>
        </DataGroup>
      ) : null}

      {data.channels.length > 0 ? (
        <DataGroup title="Channels">
          <div className={styles.chipWrap}>
            {[...data.channels]
              .sort((a, b) => a.position - b.position)
              .map((c) => (
                <ChannelChip key={c.id} channel={c} />
              ))}
          </div>
        </DataGroup>
      ) : null}
    </div>
  );
}

function CountPill({ n, label }: { n: number; label: string }) {
  return (
    <span className={styles.countPill}>
      <strong>{n}</strong> {label}
    </span>
  );
}

function DataGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className={styles.group} open>
      <summary className={styles.groupSummary}>{title}</summary>
      <div className={styles.groupBody}>{children}</div>
    </details>
  );
}

function RoleChip({ role, guildId }: { role: GuildRole; guildId: string }) {
  // @everyone shares the guild id and never carries a color; show it plainly.
  const rgb = role.id === guildId ? null : roleRgb(role.color);
  return (
    <span
      className={cn(styles.chip, rgb && styles.roleChip)}
      style={rgb ? ({ "--role-rgb": rgb } as CSSProperties) : undefined}
      title={`@${role.name}`}
    >
      @{role.name}
    </span>
  );
}

function ChannelChip({ channel }: { channel: GuildChannel }) {
  return (
    <span className={styles.chip} title={`#${channel.name}`}>
      <HashIcon size={11} className={styles.chipIcon} />
      {channel.name}
    </span>
  );
}
