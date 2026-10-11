/**
 * The destination picker — choose which channel the message posts to. Shared by
 * the Activity bar and the web builder's action bar.
 *
 * This is the deliberately-slimmed cousin of the Send dialog's
 * `GuildWebhookPicker`. There, picking a channel has to resolve/create a
 * webhook, juggle custom-bot identities, and offer webhook upkeep. Here none of
 * that surfaces: all the UI does is pick a channel id — a searchable,
 * category-grouped list — and the caller handles the rest (the Activity's
 * proxy reuses-or-mints a webhook server-side at post time; the web bar records
 * the intent and the Send flow resolves the webhook when it opens).
 *
 * On the web bar it also picks a **thread or forum post** inside a channel
 * (`threads` prop): a channel's threads nest under it the way Discord's sidebar
 * shows them — expand any channel with its chevron, and picking a forum opens
 * its posts straight away, since a forum message always lives in a post. The
 * Activity doesn't pass `threads`: its room shares a channel and nothing else.
 *
 * The panel is portalled to `<body>` with `position: fixed` (mirroring `ui/Menu`)
 * so it floats above the editor pane's `overflow: hidden` instead of being
 * clipped by it.
 */

import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGuildStore } from "@/core/guild/guildStore";
import type { GuildChannel } from "@/core/guild/types";
import type { ChannelThread } from "@/core/guild/api";
import { ChunkErrorBoundary } from "@/ui/ChunkErrorBoundary";
import {
  ChannelTypeIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SearchIcon,
  ThreadIcon,
} from "@/ui/Icon";
import styles from "./ChannelPicker.module.css";

/** Channel types the Activity can post into: text, announcement, forum, and
 *  media — the same set the web app's picker offers. A forum/media destination
 *  starts a NEW post there, so the post confirm requires a title for it (the
 *  message's `thread_name`, which the proxy re-guards server-side). */
const POSTABLE_CHANNEL_TYPES = new Set([0, 5, 15, 16]);
/** Only show the search box once the list is long enough to need it. */
const SEARCH_THRESHOLD = 8;
/** Forum and media channels: every message lives in a post. */
const FORUM_TYPES = new Set([15, 16]);

// The thread rows load on demand — only once a channel is expanded — so the
// boot path (this picker sits in the toolbar) carries none of their code.
const ChannelThreadRows = lazy(() =>
  import("./ChannelThreadRows").then((m) => ({ default: m.ChannelThreadRows })),
);
const ThreadNameResolver = lazy(() =>
  import("./ChannelThreadRows").then((m) => ({ default: m.ThreadNameResolver })),
);

/** A thread picked inside the selected channel (see `sendTargetStore`). */
export interface PickedThread {
  id: string;
  name: string | null;
}

/** Thread picking, for the surfaces that support it (the web bar). */
export interface ChannelPickerThreads {
  /** The server whose channels are listed — threads load from it. */
  guildId: string;
  /** The picked thread inside `selectedId`, or null for the channel itself. */
  selected: PickedThread | null;
  /** A channel (thread null) or one of its threads was picked. */
  onSelect: (channelId: string, thread: PickedThread | null) => void;
}

interface ChannelGroup {
  id: string | null;
  name: string | null;
  position: number;
  channels: GuildChannel[];
}

/** Group webhook-hostable channels by category, ordered the way Discord shows
 *  them (uncategorised first, then by each category's position). */
function groupChannels(
  channels: GuildChannel[],
  categoryById: (id: string) => GuildChannel | undefined,
): ChannelGroup[] {
  const byParent = new Map<string | null, GuildChannel[]>();
  for (const c of channels) {
    const key = c.parentId ?? null;
    const arr = byParent.get(key);
    if (arr) arr.push(c);
    else byParent.set(key, [c]);
  }
  const groups: ChannelGroup[] = [...byParent.entries()].map(([parentId, list]) => {
    const cat = parentId ? categoryById(parentId) : undefined;
    return {
      id: parentId,
      name: cat?.name ?? null,
      position: parentId == null ? -1 : (cat?.position ?? 0),
      channels: list
        .slice()
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    };
  });
  groups.sort((a, b) => a.position - b.position);
  return groups;
}

export function ChannelPicker({
  selectedId,
  onSelect,
  shared = false,
  disabled = false,
  threads,
}: {
  /** The channel the next post goes to, or null when none is chosen yet. */
  selectedId: string | null;
  /** A channel was picked — close the panel and re-point publishing at it. */
  onSelect: (channelId: string) => void;
  /** On a server launch the destination is synced across the collaboration room,
   *  so show a "shared with everyone here" affordance and make picking a channel
   *  re-point the whole room (the store broadcasts it). Off on a DM launch, where
   *  each composer keeps their own destination. */
  shared?: boolean;
  /** Read-only: show the destination but don't let the user change it. Used for
   *  an edit-only collaborator (no Manage Webhooks) on a server launch — moving a
   *  shared destination is a posting decision, which they don't hold. */
  disabled?: boolean;
  /** Also pick threads / forum posts inside a channel. */
  threads?: ChannelPickerThreads;
}) {
  const data = useGuildStore((s) => s.data);
  const loading = useGuildStore((s) => s.status === "loading" && !s.data);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = selectedId ? data?.channelById[selectedId] : undefined;
  const label = selected?.name ?? (selectedId ? "this channel" : "Pick a channel");
  // Channels whose threads are showing. The selected one opens with the panel,
  // so its threads (and the picked one) are in view straight away.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const pickedThread = threads && selectedId ? threads.selected : null;
  // A thread picked elsewhere (a restored message) may arrive without its
  // name; `ThreadNameResolver` (below) looks it up and records it.
  const threadLabel = pickedThread
    ? (pickedThread.name ?? (FORUM_TYPES.has(selected?.type ?? -1) ? "a post" : "a thread"))
    : null;
  const [resolverFailed, setResolverFailed] = useState(false);
  // A server launch seeds `selectedId` (the launching channel) before its name is
  // known — the guild's channel list is still loading. Rather than flash the
  // generic "this channel" and then swap to the real name, hold a small skeleton
  // in the label's place until it resolves.
  const nameLoading = loading && !!selectedId && !selected;

  // On a server launch the destination is room-wide, so spell that out in the
  // trigger's tooltip — picking a channel moves it for everyone, not just you.
  // When read-only (an edit-only collaborator) explain why it can't be changed.
  const triggerTitle = disabled
    ? `Posting to #${label} — only people who can post here can change the channel`
    : selected
      ? `Posting to #${label}${threadLabel ? ` › ${threadLabel}` : ""}${shared ? " — shared with everyone in this room" : ""} · click to change`
      : `Choose a channel to post to${shared ? " (shared with everyone in this room)" : ""}`;

  // Postable channels, plus the current selection even if its type isn't
  // normally listed (e.g. launched from a voice channel) so the default never
  // vanishes from its own picker.
  const channels = useMemo(
    () =>
      (data?.channels ?? []).filter(
        (c) => POSTABLE_CHANNEL_TYPES.has(c.type) || c.id === selectedId,
      ),
    [data, selectedId],
  );

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    // An expanded channel stays listed while searching, so a search can find
    // one of its threads by name.
    const matched = q
      ? channels.filter((c) => c.name.toLowerCase().includes(q) || expanded.has(c.id))
      : channels;
    return groupChannels(matched, (id) => data?.channelById[id]);
  }, [channels, data, q, expanded]);
  const hasCategories = groups.some((g) => g.id != null);

  // Measure the trigger and place the panel below it, clamped to the viewport.
  const place = () => {
    const r = wrapperRef.current?.getBoundingClientRect();
    if (!r) return;
    const margin = 8;
    const width = Math.min(Math.max(r.width, 260), window.innerWidth - margin * 2);
    let left = r.left;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    setPos({ left, top: r.bottom + 6, width });
  };

  useEffect(() => {
    if (open && threads && selectedId) {
      setExpanded((prev) => (prev.has(selectedId) ? prev : new Set(prev).add(selectedId)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open: a later collapse by the user must stick
  }, [open]);

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Focus the search box on open so the user can type-to-filter immediately.
  useLayoutEffect(() => {
    if (open && channels.length > SEARCH_THRESHOLD) searchRef.current?.focus();
  }, [open, channels.length]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const pick = (id: string) => {
    if (!threads) {
      onSelect(id);
      close();
      return;
    }
    threads.onSelect(id, null);
    // A forum's message always lives in a post, so picking the forum is half
    // a pick: keep the panel open on its posts ("New post" now selected).
    const channel = data?.channelById[id];
    if (channel && FORUM_TYPES.has(channel.type)) {
      setExpanded((prev) => new Set(prev).add(id));
      return;
    }
    close();
  };
  const pickThread = (channelId: string, thread: ChannelThread | null) => {
    threads?.onSelect(channelId, thread ? { id: thread.id, name: thread.name } : null);
    close();
  };
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      {threads && selectedId && pickedThread && !pickedThread.name && !resolverFailed ? (
        <ChunkErrorBoundary onDismiss={() => setResolverFailed(true)}>
          <Suspense fallback={null}>
            <ThreadNameResolver
              guildId={threads.guildId}
              channelId={selectedId}
              threadId={pickedThread.id}
              onName={(name) => threads.onSelect(selectedId, { id: pickedThread.id, name })}
            />
          </Suspense>
        </ChunkErrorBoundary>
      ) : null}
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={triggerTitle}
      >
        {threadLabel ? (
          <ThreadIcon size={16} />
        ) : (
          <ChannelTypeIcon type={selected?.type ?? 0} size={16} />
        )}
        {nameLoading ? (
          <span className={styles.triggerNameSkeleton} aria-hidden="true" />
        ) : threadLabel ? (
          <span className={styles.triggerName}>
            {label}
            <span className={styles.triggerSep} aria-hidden="true">
              {" › "}
            </span>
            <span className={styles.triggerThread}>{threadLabel}</span>
          </span>
        ) : (
          <span className={styles.triggerName}>{label}</span>
        )}
        <ChevronDownIcon size={14} className={styles.chevron} />
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="listbox"
              className={styles.panel}
              style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width }}
            >
              {channels.length > SEARCH_THRESHOLD ? (
                <div className={styles.search}>
                  <SearchIcon size={14} className={styles.searchIcon} />
                  <input
                    ref={searchRef}
                    className={styles.searchInput}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search channels…"
                    aria-label="Search channels"
                  />
                </div>
              ) : null}

              {loading ? (
                <p className={styles.note}>Loading channels…</p>
              ) : channels.length === 0 ? (
                <p className={styles.note}>No channels here can receive a post.</p>
              ) : groups.length === 0 ? (
                <p className={styles.note}>No channels match that search.</p>
              ) : (
                <ul className={styles.list}>
                  {groups.map((g) => (
                    <li key={g.id ?? ""} className={styles.group}>
                      {g.name != null || (g.id == null && hasCategories) ? (
                        <div className={styles.groupName}>{g.name ?? "No category"}</div>
                      ) : null}
                      <ul className={styles.groupChannels}>
                        {g.channels.map((c) => {
                          const isSelected = c.id === selectedId;
                          // With a thread picked, the thread row carries the
                          // check; its channel only reads as "the one".
                          // A forum's own pick reads as its "New post" row.
                          const forumWithPosts = threads != null && FORUM_TYPES.has(c.type);
                          const asParent = isSelected && (pickedThread != null || forumWithPosts);
                          const active = isSelected && !asParent;
                          const showThreads = threads != null && expanded.has(c.id);
                          const kind = FORUM_TYPES.has(c.type) ? "posts" : "threads";
                          return (
                            <li key={c.id}>
                              <div className={styles.rowLine}>
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={active}
                                  className={styles.row}
                                  data-active={active ? "" : undefined}
                                  data-parent={asParent ? "" : undefined}
                                  onClick={() => pick(c.id)}
                                >
                                  <ChannelTypeIcon
                                    type={c.type}
                                    size={15}
                                    className={styles.rowHash}
                                  />
                                  <span className={styles.rowName}>{c.name}</span>
                                  {active ? (
                                    <CheckCircleIcon size={15} className={styles.check} />
                                  ) : null}
                                </button>
                                {threads ? (
                                  <button
                                    type="button"
                                    className={styles.expand}
                                    aria-expanded={showThreads}
                                    aria-label={`${showThreads ? "Hide" : "Show"} ${kind} in #${c.name}`}
                                    title={`${showThreads ? "Hide" : "Show"} ${kind}`}
                                    onClick={() => toggleExpanded(c.id)}
                                  >
                                    {showThreads ? (
                                      <ChevronDownIcon size={14} />
                                    ) : (
                                      <ChevronRightIcon size={14} />
                                    )}
                                  </button>
                                ) : null}
                              </div>
                              {threads && showThreads ? (
                                <ChunkErrorBoundary onDismiss={() => toggleExpanded(c.id)}>
                                  <Suspense
                                    fallback={<p className={styles.threadNote}>Loading…</p>}
                                  >
                                    <ChannelThreadRows
                                      guildId={threads.guildId}
                                      channel={c}
                                      selectedThreadId={
                                        isSelected ? (pickedThread?.id ?? null) : undefined
                                      }
                                      query={q}
                                      onPick={(t) => pickThread(c.id, t)}
                                    />
                                  </Suspense>
                                </ChunkErrorBoundary>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
