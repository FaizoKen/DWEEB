/**
 * Account control for the action bar (top-left).
 *
 * One compact icon that reflects the Discord auth state:
 *   - Signed out → a log-in icon; clicking starts the Discord login redirect.
 *   - Signed in  → the user's avatar; clicking opens a popover to pick a server
 *     (only servers the DWEEB bot is already in), add the bot to another server,
 *     refresh the server list and the connected guild's data, or sign out.
 *
 * Replaces the old full-width "Server data" panel — the picker and its loaded
 * data now live behind this single icon to keep the editor clean. Only rendered
 * when a proxy base URL is configured; the caller guards on that.
 */

import { Fragment, useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { usePlanStore } from "@/core/plan/planStore";
import { useManagedMessagesStore } from "@/core/guild/managedMessagesStore";
import { loadLastGuildId } from "@/core/guild/cache";
import {
  clearPendingGuildId,
  loadPendingGuildId,
  savePendingGuildId,
} from "@/core/guild/pendingGuild";
import { botInviteUrl } from "@/core/guild/config";
import { botAddFlow, startBotAddPopup } from "@/core/oauth/flows";
import { subscribePopupResult } from "@/core/oauth/popupFlow";
import { guildIconUrl, isValidGuildId, type AuthUser, type PickerGuild } from "@/core/guild/api";
import { Menu } from "@/ui/Menu";
import {
  CheckCircleIcon,
  ClockIcon,
  LogInIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  SparkleIcon,
  UserIcon,
} from "@/ui/Icon";
import { cn } from "@/lib/cn";
import { ManagedMessagesDialog } from "./ManagedMessagesDialog";
import { CustomBotDialog } from "./CustomBotDialog";
import styles from "./AccountMenu.module.css";

/** Query keys Discord appends to the redirect after a bot add. */
const BOT_ADD_PARAMS = ["code", "guild_id", "permissions", "scope", "state"];

/**
 * The id of the guild the user just added the bot to, read from the invite's
 * redirect (`?guild_id=…`). Null when this load isn't a post-add redirect.
 */
function readJustAddedGuildId(): string | null {
  if (typeof window === "undefined") return null;
  const id = new URLSearchParams(window.location.search).get("guild_id");
  return id && isValidGuildId(id) ? id : null;
}

/** Strip the bot-add redirect params from the URL, preserving path and hash. */
function clearBotAddQuery(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of BOT_ADD_PARAMS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  const query = url.searchParams.toString();
  window.history.replaceState(null, "", `${url.pathname}${query ? `?${query}` : ""}${url.hash}`);
}

export function AccountMenu() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const guilds = useAuthStore((s) => s.guilds);
  const guildsStatus = useAuthStore((s) => s.guildsStatus);
  const initAuth = useAuthStore((s) => s.init);
  const login = useAuthStore((s) => s.login);
  const loadGuilds = useAuthStore((s) => s.loadGuilds);

  // A connected server lights up a presence dot on the avatar so you can tell
  // at a glance one is active without opening the menu.
  const connectedId = useGuildStore((s) => s.guildId);
  const connect = useGuildStore((s) => s.connect);
  const guildStatus = useGuildStore((s) => s.status);
  const connectedGuild = guilds.find((g) => g.id === connectedId) ?? null;

  // True while the post–sign-in auto-select is about to connect to a server but
  // hasn't yet, so the spinner spans that gap instead of briefly baring a
  // server-less avatar before the connected-server data begins loading.
  const pendingConnect =
    status === "authed" &&
    guildsStatus === "ready" &&
    !connectedId &&
    guilds.some((g) => g.bot_present);

  // Everything that must land before the account icon is meaningful: the
  // session, the server list, and the connected server's data. While any of it
  // is in flight we hold one full spinner rather than an interim icon.
  const busy =
    status === "unknown" ||
    status === "loading" ||
    guildsStatus === "loading" ||
    guildStatus === "loading" ||
    pendingConnect;

  // Latch the first full resolution. Afterwards a background refresh updates the
  // data behind the existing icon instead of collapsing the trigger (and any
  // open menu) back into a spinner — the full loader is a first-load affordance.
  const settledRef = useRef(false);
  if (!busy) settledRef.current = true;
  const showLoader = busy && !settledRef.current;

  // The "Managed messages" dialog — opened from the panel's action row, and
  // rendered as a sibling so it outlives the popover. Its open state lives in
  // a global store so other surfaces (the Send confirm's "Free a slot"
  // hand-off when every permanent slot is taken) can summon it too.
  const managedGuildId = useManagedMessagesStore((s) => s.guildId);
  const managedGuildName = useManagedMessagesStore((s) => s.guildName);
  const openManaged = useManagedMessagesStore((s) => s.open);
  const closeManaged = useManagedMessagesStore((s) => s.close);

  // The "Custom bot" dialog — register the server's own Discord app so the
  // DWEEB dispatcher serves its interactions. Only opened from this menu, so
  // plain local state is enough (no cross-feature opener needed).
  const [customBotGuildId, setCustomBotGuildId] = useState<string | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  // One-shot guard so the post–sign-in auto-select runs once, not on every
  // manual "Refresh". Re-armed on sign-out so a later sign-in repeats it.
  const autoRan = useRef(false);
  // Whether *this* page load arrived straight from a bot-add redirect. Drives
  // the "sign in to finish" auto-login below; reset by a full reload, so it only
  // fires on the genuine return from Discord, never on a random signed-out load.
  const arrivedFromBotAdd = useRef(readJustAddedGuildId() !== null);
  // One-shot guard for that auto-login redirect.
  const loginKicked = useRef(false);

  // Resolve the session once on mount.
  useEffect(() => {
    void initAuth();
  }, [initAuth]);

  // Load the connected server's plan as soon as it connects (not only when the
  // menu opens). Besides lighting up the tier badge, this is what auto-applies an
  // existing subscriber's floating premium (e.g. a RoleLogic sub) to the server —
  // so it lands automatically, without opening any menu.
  const loadPlan = usePlanStore((s) => s.load);
  useEffect(() => {
    if (connectedId) void loadPlan(connectedId);
  }, [connectedId, loadPlan]);

  // A bot-add popup ("Add to another server" / "Re-add the bot") reports the
  // chosen server back here over a same-origin channel. Connect to it and refresh
  // the picker so its data and the new `bot_present` flag fill in — the same
  // outcome as the old post-add redirect, but without leaving the page. Parked as
  // a pending id too, so a reload mid-connect still lands on it. Reads the stores
  // live so the one-shot subscription never goes stale.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(
    () =>
      subscribePopupResult(botAddFlow, (r) => {
        if ("error" in r) return;
        savePendingGuildId(r.guildId);
        void useGuildStore.getState().connect(r.guildId);
        void useAuthStore.getState().loadGuilds(true);
      }),
    [],
  );

  // Park the just-added guild id (survives the sign-in redirect) and tidy the
  // redirect params out of the address bar. Runs before the picker logic below.
  useEffect(() => {
    const justAdded = readJustAddedGuildId();
    if (justAdded) savePendingGuildId(justAdded);
    clearBotAddQuery();
  }, []);

  // Pick a server automatically once the session resolves.
  //   1. A server the user just added the bot to (pending id) → connect to it.
  //      If they're signed out, start sign-in first; the pending id survives the
  //      redirect and connects on return.
  //   2. Otherwise reconnect to the last server, or the first available one.
  //   3. No server has the bot → open the menu so the add prompt is front
  //      and centre.
  useEffect(() => {
    if (status === "unknown" || status === "loading") return;

    const pending = loadPendingGuildId();

    if (status === "anon") {
      autoRan.current = false;
      // Came back from adding the bot but signed out — sign-in is required to
      // load it. Kick off login once; the pending id is parked for the return.
      if (pending && arrivedFromBotAdd.current && !loginKicked.current) {
        loginKicked.current = true;
        login();
      }
      return;
    }

    // status === "authed"
    if (autoRan.current) return;

    // Just-added server: connect straight by id — it may not be flagged
    // `bot_present` in the picker yet (proxy cache), and authorization only
    // needs that it's a server the user manages, which it is.
    if (pending) {
      autoRan.current = true;
      clearPendingGuildId();
      void connect(pending);
      void loadGuilds(); // refresh the picker so the new server fills in
      return;
    }

    // Wait for the picker list before the last/first-server logic.
    if (guildsStatus !== "ready") return;
    autoRan.current = true;

    // Already on a server (restored from cache) — that one *is* the last server.
    if (connectedId) return;

    const botGuilds = guilds.filter((g) => g.bot_present);
    if (botGuilds.length === 0) {
      triggerRef.current?.click();
      return;
    }
    const lastId = loadLastGuildId();
    const target = botGuilds.find((g) => g.id === lastId) ?? botGuilds[0];
    if (target) void connect(target.id);
  }, [status, guildsStatus, connectedId, guilds, connect, loadGuilds, login]);

  // Still loading something — hold a single breathing skeleton (no icon) so the
  // trigger resolves straight to its final icon in one smooth step, with no
  // intermediate login/avatar icon flashing in between.
  if (showLoader) {
    return (
      <button
        type="button"
        className={cn(styles.trigger, styles.loading)}
        disabled
        aria-label="Loading…"
        aria-busy="true"
      >
        <span className={styles.skeleton} aria-hidden="true" />
      </button>
    );
  }

  // Signed out — the icon *is* the login button.
  if (status === "anon") {
    return (
      <button
        type="button"
        className={styles.trigger}
        onClick={login}
        title="Sign in with Discord to load server roles, channels, and emoji"
        aria-label="Sign in with Discord"
      >
        <LogInIcon size={22} className={styles.reveal} />
      </button>
    );
  }

  // Signed in — the avatar opens the account/server popover.
  return (
    <>
      <Menu
        align="start"
        trigger={
          <button
            ref={triggerRef}
            type="button"
            className={styles.trigger}
            title={
              connectedGuild
                ? `${user?.name ?? "Account"} — ${connectedGuild.name}`
                : (user?.name ?? "Account")
            }
            aria-label={
              connectedGuild
                ? `Account — connected to ${connectedGuild.name}`
                : "Account and server settings"
            }
          >
            {connectedGuild ? (
              <span className={cn(styles.composite, styles.reveal)}>
                <GuildIcon guild={connectedGuild} className={styles.compositeServer} />
                <Avatar user={user} size={18} className={styles.compositeUser} />
              </span>
            ) : (
              <Avatar user={user} size={28} className={styles.reveal} />
            )}
          </button>
        }
      >
        {(close) => (
          <AccountPanel
            onClose={close}
            onManageMessages={() => {
              close();
              if (connectedId) openManaged(connectedId, connectedGuild?.name);
            }}
            onManageCustomBot={() => {
              close();
              if (connectedId) setCustomBotGuildId(connectedId);
            }}
          />
        )}
      </Menu>
      {managedGuildId ? (
        <ManagedMessagesDialog
          guildId={managedGuildId}
          guildName={managedGuildName ?? guilds.find((g) => g.id === managedGuildId)?.name}
          onClose={closeManaged}
        />
      ) : null}
      {customBotGuildId ? (
        <CustomBotDialog
          guildId={customBotGuildId}
          guildName={guilds.find((g) => g.id === customBotGuildId)?.name}
          onClose={() => setCustomBotGuildId(null)}
        />
      ) : null}
    </>
  );
}

function AccountPanel({
  onClose,
  onManageMessages,
  onManageCustomBot,
}: {
  onClose: () => void;
  /** Opens the connected server's "Managed messages" dialog (closes the menu first). */
  onManageMessages: () => void;
  /** Opens the connected server's "Custom bot" dialog (closes the menu first). */
  onManageCustomBot: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const guilds = useAuthStore((s) => s.guilds);
  const guildsStatus = useAuthStore((s) => s.guildsStatus);
  const guildsError = useAuthStore((s) => s.guildsError);
  const loadGuilds = useAuthStore((s) => s.loadGuilds);
  const logout = useAuthStore((s) => s.logout);

  const connectedId = useGuildStore((s) => s.guildId);
  const connect = useGuildStore((s) => s.connect);
  const refresh = useGuildStore((s) => s.refresh);

  // The connected server's plan tier, shown on the "Plans" row (premium is
  // per-server). Loaded lazily when the panel opens and whenever the connected
  // server changes; a miss just hides the tier label.
  const plan = usePlanStore((s) => s.plan);
  const loadPlan = usePlanStore((s) => s.load);
  const openPricing = usePlanStore((s) => s.openPricing);
  useEffect(() => {
    if (connectedId) void loadPlan(connectedId);
  }, [loadPlan, connectedId]);

  // Manual refresh: re-pull the picker list *and* the connected guild's data,
  // both with `force` so the proxy bypasses its short-TTL cache and returns live
  // Discord state (new roles/channels/emojis show up immediately). Passive loads
  // keep using the cache; only this explicit action pays the round-trip.
  const onRefresh = () => {
    void loadGuilds(true);
    if (connectedId) void refresh(true);
  };

  // Only servers the bot is already in are pickable here; everything else is
  // funnelled through the single "Add to another server" invite below. The
  // active server is always included even if the proxy hasn't refreshed its
  // `bot_present` flag yet (e.g. a server the bot was just added to).
  const botGuilds = [...guilds]
    .filter((g) => g.bot_present || g.id === connectedId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const invite = botInviteUrl();

  // Switching servers keeps the menu open — the row's meta (roles · channels ·
  // emoji) fills in as the data loads, and the "Managed messages" sub-row
  // moves under the new selection, so the click has visible feedback in place.
  // Clicking the already-connected server again reads as "done" and closes.
  const onPick = (id: string) => {
    if (id !== connectedId) {
      void connect(id);
    } else {
      onClose();
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.userRow}>
        <Avatar user={user} size={32} />
        <span className={styles.userName}>{user?.name ?? "Signed in"}</span>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => {
            onClose();
            void logout();
          }}
        >
          Sign out
        </button>
      </div>

      <div className={styles.sectionLabel}>Servers</div>

      {guildsStatus === "loading" ? (
        <p className={styles.hint}>Loading your servers…</p>
      ) : guildsStatus === "error" ? (
        <p className={styles.error}>
          {guildsError ?? "Couldn't load your servers."}{" "}
          <button type="button" className={styles.linkBtn} onClick={() => void loadGuilds()}>
            Retry
          </button>
        </p>
      ) : botGuilds.length === 0 ? (
        <p className={styles.hint}>
          No servers with the DWEEB bot yet. Add it to a server you manage to load its data.
        </p>
      ) : (
        <ul className={styles.serverList}>
          {botGuilds.map((g) => (
            <Fragment key={g.id}>
              <ServerRow guild={g} active={g.id === connectedId} onPick={() => onPick(g.id)} />
              {/* Connected to the active server's row by a tree line so it's
                  obvious these actions apply to that guild — per-guild slots/bots. */}
              {g.id === connectedId ? (
                <li className={styles.serverSubGroup}>
                  <button
                    type="button"
                    className={styles.serverSubRow}
                    onClick={() => {
                      onClose();
                      openPricing(connectedId ?? "");
                    }}
                  >
                    <SparkleIcon size={14} />
                    <span>
                      Plans
                      {plan ? ` · ${plan.tier.charAt(0).toUpperCase()}${plan.tier.slice(1)}` : ""}
                    </span>
                  </button>
                  <button type="button" className={styles.serverSubRow} onClick={onManageMessages}>
                    <ClockIcon size={14} />
                    <span>Managed messages</span>
                  </button>
                  <button type="button" className={styles.serverSubRow} onClick={onManageCustomBot}>
                    <SettingsIcon size={14} />
                    <span>Custom bot</span>
                  </button>
                </li>
              ) : null}
            </Fragment>
          ))}
        </ul>
      )}

      <div className={styles.actions}>
        {invite ? (
          <a
            className={styles.actionRow}
            href={invite}
            target="_blank"
            rel="noreferrer noopener"
            // Plain click adds the bot in a popup and connects to the chosen
            // server in place; modified clicks keep their native new-tab behaviour
            // (Discord then bounces that tab back with the server selected).
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              startBotAddPopup();
            }}
          >
            <PlusIcon size={16} />
            <span>Add to another server</span>
          </a>
        ) : null}
        <button type="button" className={styles.actionRow} onClick={onRefresh}>
          <RefreshIcon size={16} />
          <span>Refresh</span>
        </button>
      </div>
    </div>
  );
}

function ServerRow({
  guild,
  active,
  onPick,
}: {
  guild: PickerGuild;
  active: boolean;
  onPick: () => void;
}) {
  const status = useGuildStore((s) => s.status);
  const data = useGuildStore((s) => s.data);
  const loading = active && status === "loading" && data?.guildId !== guild.id;
  const loaded = active && data?.guildId === guild.id ? data : null;

  return (
    <li>
      <button
        type="button"
        className={cn(styles.serverRow, active && styles.serverRowActive)}
        onClick={onPick}
      >
        <GuildIcon guild={guild} />
        <span className={styles.serverText}>
          <span className={styles.serverName}>{guild.name}</span>
          {loading ? (
            <span className={styles.serverMeta}>Loading…</span>
          ) : loaded ? (
            <span className={styles.serverMeta}>
              {loaded.roles.length} roles · {loaded.channels.length} channels ·{" "}
              {loaded.emojis.length} emoji
            </span>
          ) : null}
        </span>
        {active ? <CheckCircleIcon size={16} className={styles.check} /> : null}
      </button>
    </li>
  );
}

function GuildIcon({ guild, className }: { guild: PickerGuild; className?: string }) {
  const cls = className ?? styles.guildIcon;
  // A 32px glyph for the list; the shared helper defaults larger, so ask for the
  // size this row actually paints.
  const url = guildIconUrl(guild.id, guild.icon, 32);
  if (url) {
    return <img className={cls} src={url} alt="" loading="lazy" />;
  }
  return (
    <span className={cn(cls, styles.guildIconFallback)} aria-hidden="true">
      {guild.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Avatar({
  user,
  size,
  className,
}: {
  user: AuthUser | null;
  size: number;
  className?: string;
}) {
  if (user?.avatar_url) {
    return (
      <img
        className={cn(styles.avatar, className)}
        src={user.avatar_url}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={cn(styles.avatar, styles.avatarFallback, className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <UserIcon size={Math.round(size * 0.62)} />
    </span>
  );
}
