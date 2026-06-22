/**
 * Channel-first destination picker — the effortless path for Send and Restore.
 *
 * The whole point is that the user never thinks about "webhooks". In **Send**
 * they just pick a *channel*; DWEEB reuses its own webhook there or silently
 * creates one, then hands it back through `onPick`. Webhook upkeep (rename /
 * re-avatar / move / delete, and a one-click "purge duplicates") lives behind an
 * "Manage webhooks" disclosure for the rare time it's wanted.
 *
 * In **Restore** the exact webhook that posted a message matters (a wrong one
 * 404s), so that mode keeps an explicit, selectable webhook list instead — with
 * the channel from a pasted message link floated to the top.
 *
 * Only renders when the connected server's webhooks can be enumerated (the
 * shared bot holds Manage Webhooks and so does the signed-in user).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useGuildStore } from "@/core/guild/guildStore";
import {
  loadHistory,
  useGuildWebhooks,
  useGuildWebhooksStore,
  webhookAvatarUrl,
} from "@/core/webhook";
import {
  createCustomBotWebhook,
  createGuildWebhook,
  deleteGuildWebhook,
  isAuthError,
  modifyGuildWebhook,
  type CustomBotItem,
  type GuildWebhook,
  type WebhookEdit,
} from "@/core/guild/api";
import { useGuildCustomBots } from "@/core/guild/useGuildCustomBots";
import {
  botInviteUrl,
  navigateWebhookPopup,
  openWebhookPopup,
  redirectToWebhookOAuth,
  watchWebhookPopup,
} from "@/core/guild/config";
import { useAuthStore } from "@/core/auth/authStore";
import type { GuildChannel } from "@/core/guild/types";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { IconButton } from "@/ui/IconButton";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HashIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
} from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import styles from "./GuildWebhookPicker.module.css";

/** Channel types that can host a webhook: text, announcement, forum, media. */
const WEBHOOK_CHANNEL_TYPES = new Set([0, 5, 15, 16]);
/** Show a search box only once the list is long enough to need it. */
const SEARCH_THRESHOLD = 8;
/** Default name for a webhook DWEEB creates on the user's behalf. */
const AUTO_WEBHOOK_NAME = "DWEEB";
/** Cap an uploaded avatar so the base64 stays under the proxy's data-URI limit. */
const MAX_AVATAR_BYTES = 800_000;

type EditChannel = { id: string; name: string; type: number };

/** Who a created/reused webhook posts as in the channel-first flow: DWEEB's own
 *  app, or one of the server's registered custom bots. */
type Identity = { kind: "dweeb" } | { kind: "bot"; applicationId: string; name: string };

/**
 * Is this one of DWEEB's webhooks? Two flavours both count: the OAuth
 * `webhook.incoming` ones are *owned* by the app (`application_id`), while the
 * ones DWEEB's bot creates via REST carry no app id but list the bot as their
 * `creator` (a bot's user id equals its application id). Recognising the latter
 * is what lets the channel-first flow reuse them instead of piling up
 * duplicates.
 */
function isDweebWebhook(w: GuildWebhook, dweebAppId: string): boolean {
  if (!dweebAppId) return false;
  return w.application_id === dweebAppId || w.creator?.id === dweebAppId;
}

/**
 * Owner chip for a listed webhook. DWEEB (either flavour) and a server's own
 * registered custom bot both get an accented chip — they're the webhooks whose
 * components route back to DWEEB. `customBotName` returns the bot's name when
 * the owning app id is one registered for this server (empty string for a
 * registered-but-unnamed app), else `undefined`; any other app is a generic
 * "Bot", and a person/follower webhook is "Others".
 */
function ownerChip(
  w: GuildWebhook,
  dweebAppId: string,
  customBotName: (appId: string) => string | undefined,
): { text: string; kind: string } {
  if (isDweebWebhook(w, dweebAppId)) return { text: "DWEEB", kind: "dweeb" };
  if (w.application_id) {
    const name = customBotName(w.application_id);
    if (name !== undefined) return { text: name || "Custom bot", kind: "custombot" };
    return { text: "Bot", kind: "bot" };
  }
  return { text: "Others", kind: "user" };
}

/** Read an image File into a `data:` URI, rejecting oversize / non-images. */
function fileToDataUri(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("Choose an image file."));
  if (file.size > MAX_AVATAR_BYTES)
    return Promise.reject(new Error("Image is too large — keep it under 800 KB."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read that image."));
    reader.readAsDataURL(file);
  });
}

/**
 * Rank a webhook for "which to keep" when purging duplicates — lower is kept.
 * Never drop the one the user has selected; prefer app-owned (its components
 * route somewhere) over a person's webhook; the caller tie-breaks on id (oldest)
 * so the result is deterministic.
 */
function keepRank(w: GuildWebhook, activeId: string | null): number {
  let r = 0;
  if (activeId && w.id === activeId) r -= 1000;
  if (w.application_id) r -= 100;
  return r;
}

/**
 * Find redundant webhooks: those sharing a (case-insensitive) name *and*
 * channel with another. Keeps the best per group (see {@link keepRank}); every
 * other member is a deletion candidate.
 */
function findDuplicates(
  usable: GuildWebhook[],
  activeId: string | null,
): { toDelete: GuildWebhook[]; groups: number } {
  const groups = new Map<string, GuildWebhook[]>();
  for (const w of usable) {
    const key = `${(w.name ?? "").trim().toLowerCase()} ${w.channel_id ?? ""}`;
    const list = groups.get(key);
    if (list) list.push(w);
    else groups.set(key, [w]);
  }
  const toDelete: GuildWebhook[] = [];
  let dupGroups = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    dupGroups++;
    const sorted = [...list].sort(
      (a, b) => keepRank(a, activeId) - keepRank(b, activeId) || a.id.localeCompare(b.id),
    );
    for (let i = 1; i < sorted.length; i++) toDelete.push(sorted[i]!);
  }
  return { toDelete, groups: dupGroups };
}

export function GuildWebhookPicker({
  mode,
  activeId,
  onPick,
  matchChannelId,
}: {
  /** Send is channel-first (auto webhook); Restore selects an exact webhook. */
  mode: "send" | "restore";
  /** Webhook id of the URL currently in the host field — its row/channel lights up. */
  activeId: string | null;
  /** A webhook was chosen (resolved from a channel, or an explicit selection). */
  onPick: (webhook: GuildWebhook) => void;
  /** Restore: channel parsed from a pasted message link — its webhooks float to
   *  the top and are tagged, so the right one is obvious. */
  matchChannelId?: string | null;
}) {
  const { active, connectedId, status, webhooks, dweebAppId, error, canReinvite, reload } =
    useGuildWebhooks();
  const removeLocal = useGuildWebhooksStore((s) => s.removeLocal);
  const [query, setQuery] = useState("");
  // Per-row management state (Manage disclosure / Restore rows).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  // The channel whose webhook is being resolved/created right now (Send).
  const [resolvingChannel, setResolvingChannel] = useState<string | null>(null);

  // Scroll the already-selected destination into view when the picker opens, so
  // it's obvious which one is active rather than hidden below the fold (the list
  // opens scrolled to the top). `listRef` is the scrollable list, `activeRowRef`
  // the selected row inside it — both wired up in whichever mode renders.
  const listRef = useRef<HTMLUListElement>(null);
  const activeRowRef = useRef<HTMLLIElement>(null);

  const guildData = useGuildStore((s) => s.data);
  const channelsLoaded = guildData?.guildId === connectedId;
  const channelName = (id: string | null): string | undefined =>
    id && channelsLoaded ? guildData?.channelById[id]?.name : undefined;
  const webhookChannels: GuildChannel[] = useMemo(
    () =>
      (channelsLoaded ? guildData!.channels : [])
        .filter((c) => WEBHOOK_CHANNEL_TYPES.has(c.type))
        .slice()
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [channelsLoaded, guildData],
  );
  const editableChannels: EditChannel[] = webhookChannels;

  // Discord hands a webhook's execute token only to the app that OWNS it, so the
  // shared bot's guild-webhook read returns `url: null` for any webhook created
  // under a custom bot (or another app). DWEEB *did* hold those tokens at
  // creation time and saved them to this browser's webhook history, so recover
  // the execute URL from there by id. Without this, custom-bot webhooks never
  // pass the `usable` filter below — so they don't show, can't be reused, and
  // every channel pick mints another OAuth duplicate. Webhooks created in a
  // different browser stay unrecoverable (their token never reached this device).
  const recovered = useMemo(() => {
    const urlById = new Map(loadHistory().map((e) => [e.id, e.url] as const));
    return webhooks.map((w) =>
      w.url || !urlById.has(w.id) ? w : { ...w, url: urlById.get(w.id)! },
    );
  }, [webhooks]);

  // Only webhooks we can actually post through (incoming, token recoverable).
  const usable = useMemo(() => recovered.filter((w) => w.type === 1 && !!w.url), [recovered]);
  const dup = useMemo(() => findDuplicates(usable, activeId), [usable, activeId]);
  // Which channel the currently-selected webhook posts to (lights up its row).
  const activeChannelId = useMemo(
    () => usable.find((w) => w.id === activeId)?.channel_id ?? null,
    [usable, activeId],
  );

  // On open, centre the selected row in its list so the user sees what's already
  // chosen. Runs once, the moment the active row and its scroll container are
  // both mounted (channel/webhook data can arrive after mount). Scrolls only the
  // list itself — never the surrounding dialog.
  const scrolledToSelectionRef = useRef(false);
  useEffect(() => {
    if (scrolledToSelectionRef.current) return;
    const list = listRef.current;
    const row = activeRowRef.current;
    if (!list || !row) return;
    scrolledToSelectionRef.current = true;
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    // Centre the row in the list's viewport; the browser clamps the result, so a
    // short (non-scrolling) list stays exactly where it is.
    list.scrollTop += rr.top - lr.top - (lr.height - rr.height) / 2;
  }, [activeChannelId, activeId, status]);

  // Registered custom bots for this server. Their webhooks route components back
  // to DWEEB too, so the user can post under one (the preferred identity) and we
  // mark / prioritise its webhooks. Labeling uses every registered app id; only
  // bots with a stored secret can mint a fresh webhook (one-click OAuth).
  const { bots: customBots } = useGuildCustomBots();
  const secretBots = useMemo(() => customBots.filter((b) => b.has_secret), [customBots]);
  // Name for a webhook's owning app when it's a registered custom bot, else
  // undefined — drives the owner chip's "custom bot" flavour.
  const customBotName = (appId: string): string | undefined =>
    customBots.find((b) => b.application_id === appId)?.name;

  // "Post as" selection (Send): defaults to the first custom bot once they load
  // (posting under your own bot is the nicer outcome), else DWEEB. We seed it
  // automatically only until the user picks — and snap back to DWEEB if the
  // chosen bot is unregistered / loses its secret.
  const [identity, setIdentity] = useState<Identity>({ kind: "dweeb" });
  const identityTouched = useRef(false);
  useEffect(() => {
    if (
      identity.kind === "bot" &&
      !secretBots.some((b) => b.application_id === identity.applicationId)
    ) {
      setIdentity({ kind: "dweeb" });
      return;
    }
    if (!identityTouched.current && identity.kind === "dweeb" && secretBots.length > 0) {
      const b = secretBots[0]!;
      setIdentity({ kind: "bot", applicationId: b.application_id, name: b.name });
    }
  }, [secretBots, identity]);

  // Collapsed category sections (Send). Keyed by category id ("" for the
  // no-category group); empty set = all expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Group the webhook-hostable channels by their category, ordered by the
  // category's position (uncategorised first), each group's channels by theirs.
  const channelGroups = useMemo(() => {
    const byParent = new Map<string | null, GuildChannel[]>();
    for (const c of webhookChannels) {
      const key = c.parentId ?? null;
      const arr = byParent.get(key);
      if (arr) arr.push(c);
      else byParent.set(key, [c]);
    }
    const groups = [...byParent.entries()].map(([parentId, channels]) => {
      const cat = parentId ? guildData?.channelById[parentId] : undefined;
      return {
        id: parentId,
        name: cat?.name ?? null,
        // Uncategorised floats to the top; real categories keep Discord's order.
        position: parentId == null ? -1 : (cat?.position ?? 0),
        channels: channels
          .slice()
          .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
      };
    });
    groups.sort((a, b) => a.position - b.position);
    return groups;
  }, [webhookChannels, guildData]);

  if (!active) return null;

  const titleText = mode === "send" ? "Post to a channel" : "Your server’s webhooks";
  const header = (
    <div className={styles.head}>
      <span className={styles.title}>{titleText}</span>
      <button
        type="button"
        className={styles.refresh}
        onClick={reload}
        disabled={status === "loading"}
        title="Reload from Discord"
      >
        <RefreshIcon size={13} />
      </button>
    </div>
  );

  if (status === "loading" && usable.length === 0) {
    return (
      <section className={styles.picker} aria-label="Destination">
        {header}
        <p className={styles.note}>Loading this server…</p>
      </section>
    );
  }

  if (status === "denied") {
    // Don't vanish silently — say why the channel picker is hidden. When the
    // miss is the *bot's* permission we can offer a one-click re-add; otherwise
    // it's the server's call, and pasting a webhook URL below still works.
    return (
      <section className={styles.picker} aria-label="Destination">
        {header}
        <p className={styles.note}>
          Channel picking is hidden here — the DWEEB bot needs the <strong>Manage Webhooks</strong>{" "}
          permission in this server to set up webhooks for you.{" "}
          {canReinvite ? (
            <a
              className={styles.link}
              href={botInviteUrl(connectedId)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Re-add the bot ↗
            </a>
          ) : (
            "Ask a server admin to grant it, or paste a webhook URL below."
          )}
        </p>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className={styles.picker} aria-label="Destination">
        {header}
        <p className={styles.note}>{error ?? "Couldn’t load this server."}</p>
      </section>
    );
  }

  const fail = (e: unknown) => {
    if (isAuthError(e)) {
      useAuthStore.getState().markSignedOut();
    } else {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  // The best existing webhook to reuse in a channel for the chosen identity, so
  // we don't pile up duplicates. DWEEB: app-owned first (components route back),
  // then one literally named "DWEEB", then oldest. A custom bot: any webhook
  // owned by that app, preferring one named after the bot, then oldest.
  const reusableInChannel = (channelId: string, id: Identity): GuildWebhook | null => {
    if (id.kind === "bot") {
      const mine = usable.filter(
        (w) => w.channel_id === channelId && w.application_id === id.applicationId,
      );
      if (mine.length === 0) return null;
      const want = id.name.trim().toLowerCase();
      mine.sort((a, b) => {
        const an = (a.name ?? "").trim().toLowerCase() === want ? 0 : 1;
        const bn = (b.name ?? "").trim().toLowerCase() === want ? 0 : 1;
        return an - bn || a.id.localeCompare(b.id);
      });
      return mine[0]!;
    }
    const mine = usable.filter((w) => w.channel_id === channelId && isDweebWebhook(w, dweebAppId));
    if (mine.length === 0) return null;
    mine.sort((a, b) => {
      const aApp = a.application_id === dweebAppId ? 0 : 1;
      const bApp = b.application_id === dweebAppId ? 0 : 1;
      if (aApp !== bApp) return aApp - bApp;
      const an = (a.name ?? "").trim().toLowerCase() === "dweeb" ? 0 : 1;
      const bn = (b.name ?? "").trim().toLowerCase() === "dweeb" ? 0 : 1;
      return an - bn || a.id.localeCompare(b.id);
    });
    return mine[0]!;
  };

  // The channel-first action: hand back a webhook for this channel under the
  // chosen identity. Reuse one if it exists; otherwise DWEEB mints one silently
  // (no permission step), while a custom bot routes through Discord's OAuth
  // webhook flow — which picks the channel itself. That runs in a popup so the
  // in-progress message survives; its result returns through the app's webhook
  // handler (App → Send panel), the same path as DWEEB's own OAuth flow. Only a
  // blocked popup falls back to navigating the page away.
  const onPickChannel = async (channelId: string) => {
    setActionError(null);
    const existing = reusableInChannel(channelId, identity);
    if (existing) {
      onPick(existing);
      return;
    }
    setResolvingChannel(channelId);
    try {
      if (identity.kind === "bot") {
        // Open the popup synchronously (still inside the click) so the blocker
        // doesn't catch it once we await the proxy for the authorize URL.
        const popup = openWebhookPopup();
        let url: string;
        try {
          url = await createCustomBotWebhook(connectedId, identity.applicationId);
        } catch (e) {
          popup?.close();
          throw e;
        }
        if (popup) {
          navigateWebhookPopup(popup, url);
          watchWebhookPopup(popup);
        } else {
          redirectToWebhookOAuth(url);
        }
        return;
      }
      const created = await createGuildWebhook(connectedId, channelId, AUTO_WEBHOOK_NAME);
      useGuildWebhooksStore.getState().upsertLocal(created);
      onPick(created);
    } catch (e) {
      fail(e);
    } finally {
      setResolvingChannel(null);
    }
  };

  const onSaveEdit = async (id: string, changes: WebhookEdit) => {
    setActingId(id);
    setActionError(null);
    try {
      const updated = await modifyGuildWebhook(connectedId, id, changes);
      useGuildWebhooksStore.getState().upsertLocal(updated);
      setEditingId(null);
      pushToast("Webhook updated.", "success");
    } catch (e) {
      fail(e);
    } finally {
      setActingId(null);
    }
  };

  const onDelete = async (id: string) => {
    setActingId(id);
    setActionError(null);
    try {
      await deleteGuildWebhook(connectedId, id);
      removeLocal(id);
      setConfirmDeleteId(null);
      pushToast("Webhook deleted.", "success");
    } catch (e) {
      fail(e);
    } finally {
      setActingId(null);
    }
  };

  const onPurge = async () => {
    setPurgeBusy(true);
    setActionError(null);
    let ok = 0;
    for (const w of dup.toDelete) {
      try {
        await deleteGuildWebhook(connectedId, w.id);
        removeLocal(w.id);
        ok++;
      } catch (e) {
        if (isAuthError(e)) {
          fail(e);
          break;
        }
      }
    }
    setPurgeBusy(false);
    setPurgeOpen(false);
    pushToast(
      ok === dup.toDelete.length
        ? `Purged ${ok} duplicate webhook${ok === 1 ? "" : "s"}.`
        : `Purged ${ok}/${dup.toDelete.length}.`,
      ok ? "success" : "info",
    );
  };

  /* ── Restore: explicit webhook selection ─────────────────────────────── */
  if (mode === "restore") {
    const list = usable
      .filter((w) => {
        const q = query.trim().toLowerCase();
        if (!q) return true;
        const cn = channelName(w.channel_id)?.toLowerCase() ?? "";
        return (w.name ?? "").toLowerCase().includes(q) || cn.includes(q);
      })
      .sort((a, b) => {
        if (matchChannelId) {
          const am = a.channel_id === matchChannelId ? 0 : 1;
          const bm = b.channel_id === matchChannelId ? 0 : 1;
          if (am !== bm) return am - bm;
        }
        return (
          (channelName(a.channel_id) ?? "").localeCompare(channelName(b.channel_id) ?? "") ||
          (a.name ?? "").localeCompare(b.name ?? "")
        );
      });

    return (
      <section className={styles.picker} aria-label="Server webhooks">
        {header}
        {usable.length === 0 ? (
          <p className={styles.note}>No webhooks in this server to restore from.</p>
        ) : null}
        {usable.length > SEARCH_THRESHOLD ? <SearchBox value={query} onChange={setQuery} /> : null}
        {list.length > 0 ? (
          <ul className={styles.list} ref={listRef}>
            {list.map((w) => (
              <li key={w.id} ref={w.id === activeId ? activeRowRef : undefined}>
                <button
                  type="button"
                  className={cn(styles.row, styles.rowSolo, w.id === activeId && styles.rowActive)}
                  onClick={() => onPick(w)}
                >
                  <img
                    className={styles.avatar}
                    src={webhookAvatarUrl(w.id, w.avatar, 40)}
                    alt=""
                    width={32}
                    height={32}
                    loading="lazy"
                  />
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>
                      {w.name || "(unnamed)"}
                      <OwnerChip w={w} dweebAppId={dweebAppId} customBotName={customBotName} />
                      {matchChannelId != null && w.channel_id === matchChannelId ? (
                        <span className={styles.matchChip}>this channel</span>
                      ) : null}
                    </span>
                    <span className={styles.rowDest}>
                      <HashIcon size={11} />
                      {channelName(w.channel_id) ?? w.channel_id ?? "unknown channel"}
                    </span>
                  </span>
                  {w.id === activeId ? (
                    <CheckCircleIcon size={16} className={styles.check} />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : usable.length > 0 ? (
          <p className={styles.note}>Nothing matches that search.</p>
        ) : null}
      </section>
    );
  }

  /* ── Send: channel-first ─────────────────────────────────────────────── */
  const q = query.trim().toLowerCase();
  // While searching, narrow each category to its matches and drop empty ones.
  const filteredGroups = q
    ? channelGroups
        .map((g) => ({
          ...g,
          channels: g.channels.filter((c) => c.name.toLowerCase().includes(q)),
        }))
        .filter((g) => g.channels.length > 0)
    : channelGroups;
  // Headers only matter once there's a real category; with just the no-category
  // group it stays a flat list (matches small servers' expectations).
  const hasCategories = filteredGroups.some((g) => g.id != null);
  const selectorVisible = secretBots.length > 0;
  const groupKey = (id: string | null) => id ?? "";
  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className={styles.picker} aria-label="Destination">
      {header}
      <p className={styles.note}>
        Choose where your message should go. DWEEB handles the technical setup behind the scenes —
        there's nothing to copy or configure.
      </p>

      {selectorVisible ? (
        <PostAsSelector
          identity={identity}
          bots={secretBots}
          onSelect={(id) => {
            identityTouched.current = true;
            setIdentity(id);
          }}
        />
      ) : null}

      {webhookChannels.length === 0 ? (
        <p className={styles.note}>
          {channelsLoaded
            ? "No channels here can host a webhook."
            : "Connect to this server so its channels load."}
        </p>
      ) : null}

      {webhookChannels.length > 0 ? (
        <SearchBox value={query} onChange={setQuery} placeholder="Search channels…" />
      ) : null}

      {actionError ? <p className={styles.error}>{actionError}</p> : null}

      {filteredGroups.length > 0 ? (
        <ul className={cn(styles.list, styles.channelPanel)} ref={listRef}>
          {filteredGroups.map((g) => {
            const key = groupKey(g.id);
            // Searching force-expands so a match is never hidden in a collapsed
            // section.
            const isCollapsed = !q && collapsed.has(key);
            const showHeader = g.name != null || (g.id == null && hasCategories);
            return (
              <li key={key} className={styles.catGroup}>
                {showHeader ? (
                  <button
                    type="button"
                    className={styles.catHeader}
                    onClick={() => toggleCollapsed(key)}
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? (
                      <ChevronRightIcon size={13} className={styles.catChevron} />
                    ) : (
                      <ChevronDownIcon size={13} className={styles.catChevron} />
                    )}
                    <span className={styles.catName}>{g.name ?? "No category"}</span>
                    <span className={styles.catCount}>{g.channels.length}</span>
                  </button>
                ) : null}
                {!isCollapsed ? (
                  <ul className={styles.catChannels}>
                    {g.channels.map((c) => (
                      <li key={c.id} ref={c.id === activeChannelId ? activeRowRef : undefined}>
                        <ChannelRow
                          channel={c}
                          active={c.id === activeChannelId}
                          busy={resolvingChannel === c.id}
                          reuse={reusableInChannel(c.id, identity)}
                          identity={identity}
                          selectorVisible={selectorVisible}
                          onPick={() => void onPickChannel(c.id)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : webhookChannels.length > 0 ? (
        <p className={styles.note}>No channels match that search.</p>
      ) : null}

      {/* Advanced: tidy up the webhooks DWEEB created — rename / move / delete,
          and purge duplicates. Most users never need to open this. */}
      {usable.length > 0 ? (
        <details className={styles.manage}>
          <summary className={styles.manageSummary}>
            Manage webhooks ({usable.length})
            {dup.toDelete.length > 0 ? (
              <span className={styles.manageDupTag}>{dup.toDelete.length} duplicate</span>
            ) : null}
          </summary>
          <div className={styles.manageBody}>
            {dup.toDelete.length > 0 ? (
              purgeOpen ? (
                <div className={styles.purge}>
                  <div className={styles.purgeHead}>
                    <AlertTriangleIcon size={15} className={styles.purgeIcon} />
                    <span>
                      Delete {dup.toDelete.length} duplicate webhook
                      {dup.toDelete.length === 1 ? "" : "s"}? Keeps the best in each of {dup.groups}{" "}
                      group{dup.groups === 1 ? "" : "s"} (your selected one, then bot-owned, then
                      the oldest).
                    </span>
                  </div>
                  <ul className={styles.purgeList}>
                    {dup.toDelete.map((w) => (
                      <li key={w.id} className={styles.purgeItem}>
                        <span className={styles.purgeName}>{w.name || "(unnamed)"}</span>
                        <span className={styles.purgeDest}>
                          <HashIcon size={11} />
                          {channelName(w.channel_id) ?? w.channel_id ?? "?"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className={styles.createActions}>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={purgeBusy}
                      onClick={() => void onPurge()}
                    >
                      {purgeBusy ? "Purging…" : `Delete ${dup.toDelete.length}`}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={purgeBusy}
                      onClick={() => setPurgeOpen(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.purgeToggle}
                  onClick={() => setPurgeOpen(true)}
                >
                  <AlertTriangleIcon size={14} />
                  {dup.toDelete.length} duplicate webhook{dup.toDelete.length === 1 ? "" : "s"} —{" "}
                  <span className={styles.purgeToggleAccent}>Purge</span>
                </button>
              )
            ) : null}

            {actionError ? <p className={styles.error}>{actionError}</p> : null}

            <ul className={styles.list}>
              {usable.map((w) => {
                const busy = actingId === w.id;
                const selected = w.id === activeId;
                return (
                  <li key={w.id} className={styles.rowWrap}>
                    <div className={cn(styles.row, selected && styles.rowActive)}>
                      <button
                        type="button"
                        className={styles.rowMain}
                        onClick={() => onPick(w)}
                        aria-pressed={selected}
                        title="Post through this webhook"
                      >
                        <img
                          className={styles.avatar}
                          src={webhookAvatarUrl(w.id, w.avatar, 40)}
                          alt=""
                          width={32}
                          height={32}
                          loading="lazy"
                        />
                        <span className={styles.rowText}>
                          <span className={styles.rowName}>
                            {w.name || "(unnamed)"}
                            <OwnerChip
                              w={w}
                              dweebAppId={dweebAppId}
                              customBotName={customBotName}
                            />
                          </span>
                          <span className={styles.rowDest}>
                            <HashIcon size={11} />
                            {channelName(w.channel_id) ?? w.channel_id ?? "unknown channel"}
                          </span>
                        </span>
                        {selected ? <CheckCircleIcon size={16} className={styles.check} /> : null}
                      </button>
                      <div className={styles.rowActions}>
                        <IconButton
                          size="sm"
                          label="Rename, change avatar, or move"
                          disabled={busy}
                          onClick={() => {
                            setEditingId((v) => (v === w.id ? null : w.id));
                            setConfirmDeleteId(null);
                            setActionError(null);
                          }}
                        >
                          <PencilIcon size={13} />
                        </IconButton>
                        <IconButton
                          size="sm"
                          variant="danger"
                          label="Delete this webhook"
                          disabled={busy}
                          onClick={() => {
                            setConfirmDeleteId((v) => (v === w.id ? null : w.id));
                            setEditingId(null);
                            setActionError(null);
                          }}
                        >
                          <TrashIcon size={13} />
                        </IconButton>
                      </div>
                    </div>

                    {confirmDeleteId === w.id ? (
                      <div className={styles.confirm}>
                        <span className={styles.confirmText}>
                          Delete <strong>{w.name || "this webhook"}</strong>? Anything posting
                          through its URL stops working — this can’t be undone.
                        </span>
                        <div className={styles.createActions}>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            onClick={() => void onDelete(w.id)}
                          >
                            {busy ? "Deleting…" : "Delete"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {editingId === w.id ? (
                      <EditRow
                        webhook={w}
                        channels={editableChannels}
                        busy={busy}
                        onCancel={() => setEditingId(null)}
                        onSave={(changes) => void onSaveEdit(w.id, changes)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </details>
      ) : null}
    </section>
  );
}

/* ── Small bits ─────────────────────────────────────────────────────────── */

function SearchBox({
  value,
  onChange,
  placeholder = "Search by name or channel…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className={styles.search}>
      <SearchIcon size={14} className={styles.searchIcon} />
      <input
        className={styles.searchInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="Search"
      />
    </div>
  );
}

function OwnerChip({
  w,
  dweebAppId,
  customBotName,
}: {
  w: GuildWebhook;
  dweebAppId: string;
  customBotName: (appId: string) => string | undefined;
}) {
  const chip = ownerChip(w, dweebAppId, customBotName);
  return <span className={cn(styles.chip, styles[`chip_${chip.kind}`])}>{chip.text}</span>;
}

/* ── "Post as" identity selector (Send) ─────────────────────────────────── */

/**
 * Choose whether a picked channel's webhook is created/reused under DWEEB or one
 * of the server's registered custom bots. Only shown when at least one custom
 * bot with a stored secret exists (so "create under it" is one click).
 */
function PostAsSelector({
  identity,
  bots,
  onSelect,
}: {
  identity: Identity;
  bots: CustomBotItem[];
  onSelect: (id: Identity) => void;
}) {
  return (
    <div className={styles.postAs}>
      <span className={styles.postAsLabel}>Post as</span>
      <div className={styles.postAsPills}>
        <button
          type="button"
          className={cn(styles.postAsPill, identity.kind === "dweeb" && styles.postAsPillActive)}
          aria-pressed={identity.kind === "dweeb"}
          onClick={() => onSelect({ kind: "dweeb" })}
        >
          DWEEB
        </button>
        {bots.map((b) => {
          const selected = identity.kind === "bot" && identity.applicationId === b.application_id;
          return (
            <button
              key={b.application_id}
              type="button"
              className={cn(styles.postAsPill, selected && styles.postAsPillActive)}
              aria-pressed={selected}
              onClick={() =>
                onSelect({ kind: "bot", applicationId: b.application_id, name: b.name })
              }
            >
              {b.name || "Custom bot"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Channel row (Send) ─────────────────────────────────────────────────── */

/**
 * One channel in the channel-first list. The right edge reflects what clicking
 * will do under the chosen identity: reuse an existing webhook (check + an
 * identity chip when a selector is shown), or — for a custom bot with no webhook
 * here yet — open Discord to create one. DWEEB with no webhook here creates one
 * silently, so it needs no affordance.
 */
function ChannelRow({
  channel: c,
  active,
  busy,
  reuse,
  identity,
  selectorVisible,
  onPick,
}: {
  channel: GuildChannel;
  active: boolean;
  busy: boolean;
  reuse: GuildWebhook | null;
  identity: Identity;
  selectorVisible: boolean;
  onPick: () => void;
}) {
  // What the row's check + highlight mean is relative to the chosen "Post as"
  // identity. With the selector shown they mark a channel where picking will
  // *reuse* an existing webhook of THAT identity (paired with the identity
  // chip) — i.e. `reuse != null`. The active channel (where the loaded webhook
  // posts) must not leak a check across identities: a #channel holding a DWEEB
  // webhook is not "ready" while posting as a custom bot, so it offers "create
  // as …" instead of looking done. Without the selector there's a single
  // identity, so the loaded webhook's channel is unambiguously the active one
  // (original single-identity behaviour).
  const reusableHere = reuse != null;
  const isActive = selectorVisible ? active && reusableHere : active;
  const showCheck = selectorVisible ? reusableHere : active;
  return (
    <button
      type="button"
      className={cn(styles.channelRow, isActive && styles.rowActive)}
      disabled={busy}
      onClick={onPick}
    >
      <span className={styles.channelHash} aria-hidden>
        <HashIcon size={15} />
      </span>
      <span className={styles.channelName}>{c.name}</span>
      {busy ? (
        <span className={styles.channelStatus}>
          {identity.kind === "bot" ? "Opening Discord…" : "Setting up…"}
        </span>
      ) : (
        <>
          {selectorVisible && reuse ? (
            <span
              className={cn(
                styles.chip,
                identity.kind === "bot" ? styles.chip_custombot : styles.chip_dweeb,
              )}
            >
              {identity.kind === "bot" ? identity.name || "Custom bot" : "DWEEB"}
            </span>
          ) : null}
          {showCheck ? (
            <CheckCircleIcon size={16} className={styles.check} />
          ) : identity.kind === "bot" ? (
            <span className={styles.createAs}>
              <PlusIcon size={12} />
              create as {identity.name || "your bot"}
            </span>
          ) : null}
        </>
      )}
    </button>
  );
}

/* ── Avatar picker (edit form) ──────────────────────────────────────────── */

function AvatarField({
  draft,
  setDraft,
  currentUrl,
}: {
  /** undefined = leave as-is · null = clear · string = new data URI. */
  draft: string | null | undefined;
  setDraft: (v: string | null | undefined) => void;
  currentUrl: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);

  const preview =
    typeof draft === "string" ? draft : draft === null ? webhookAvatarUrl("0", null) : currentUrl;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setDraft(await fileToDataUri(file));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't read that image.");
    }
  };

  return (
    <div className={styles.avatarField}>
      {preview ? (
        <img className={styles.avatarPreview} src={preview} alt="" width={40} height={40} />
      ) : (
        <span className={styles.avatarPreviewEmpty} aria-hidden="true" />
      )}
      <div className={styles.avatarBtns}>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button type="button" className={styles.linkBtn} onClick={() => inputRef.current?.click()}>
          {typeof draft === "string" ? "Change image" : "Upload image"}
        </button>
        {typeof draft === "string" ? (
          <button type="button" className={styles.linkBtn} onClick={() => setDraft(undefined)}>
            Undo
          </button>
        ) : draft === null ? (
          <button type="button" className={styles.linkBtn} onClick={() => setDraft(undefined)}>
            Keep current
          </button>
        ) : (
          <button type="button" className={styles.linkBtn} onClick={() => setDraft(null)}>
            Remove picture
          </button>
        )}
      </div>
      {err ? <span className={styles.avatarError}>{err}</span> : null}
    </div>
  );
}

/* ── Inline edit (rename / move / re-avatar) ────────────────────────────── */

function EditRow({
  webhook: w,
  channels,
  busy,
  onCancel,
  onSave,
}: {
  webhook: GuildWebhook;
  channels: EditChannel[];
  busy: boolean;
  onCancel: () => void;
  onSave: (changes: WebhookEdit) => void;
}) {
  const [name, setName] = useState(w.name ?? "");
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [channelId, setChannelId] = useState(w.channel_id ?? "");

  const submit = () => {
    const changes: WebhookEdit = {};
    const trimmed = name.trim();
    if (trimmed && trimmed !== (w.name ?? "")) changes.name = trimmed;
    if (avatar !== undefined) changes.avatar = avatar;
    if (channelId && channelId !== (w.channel_id ?? "")) changes.channelId = channelId;
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }
    onSave(changes);
  };

  return (
    <div className={styles.createForm}>
      <div className={styles.createGrid}>
        <Field label="Name">
          {(id) => (
            <TextInput
              id={id}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="Webhook name"
            />
          )}
        </Field>
        <Field label="Channel">
          {(id) => (
            <select
              id={id}
              className={styles.select}
              value={channelId}
              onChange={(e) => setChannelId(e.currentTarget.value)}
            >
              {!channels.some((c) => c.id === channelId) ? (
                <option value={channelId}>(current channel)</option>
              ) : null}
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <AvatarField
        draft={avatar}
        setDraft={setAvatar}
        currentUrl={webhookAvatarUrl(w.id, w.avatar, 64)}
      />
      <div className={styles.createActions}>
        <Button size="sm" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
