/**
 * The Activity's destination picker — choose which channel the message posts to.
 *
 * This is the deliberately-slimmed cousin of the web app's `GuildWebhookPicker`.
 * There, picking a channel has to resolve/create a webhook, juggle custom-bot
 * identities, and offer webhook upkeep. In the Activity none of that surfaces:
 * the proxy's `POST /api/activity/post` reuses-or-mints a DWEEB webhook in
 * whatever channel it's handed, server-side. So all the UI has to do is pick a
 * channel id — a searchable, category-grouped list, defaulting to the launching
 * channel — and the bar handles the rest.
 *
 * The panel is portalled to `<body>` with `position: fixed` (mirroring `ui/Menu`)
 * so it floats above the editor pane's `overflow: hidden` instead of being
 * clipped by it.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGuildStore } from "@/core/guild/guildStore";
import type { GuildChannel } from "@/core/guild/types";
import { ChannelTypeIcon, CheckCircleIcon, ChevronDownIcon, SearchIcon } from "@/ui/Icon";
import styles from "./ChannelPicker.module.css";

/** Channel types that can host a webhook: text, announcement, forum, media —
 *  the same set the web app's picker offers. */
const WEBHOOK_CHANNEL_TYPES = new Set([0, 5, 15, 16]);
/** Only show the search box once the list is long enough to need it. */
const SEARCH_THRESHOLD = 8;

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

  // On a server launch the destination is room-wide, so spell that out in the
  // trigger's tooltip — picking a channel moves it for everyone, not just you.
  // When read-only (an edit-only collaborator) explain why it can't be changed.
  const triggerTitle = disabled
    ? `Posting to #${label} — only people who can post here can change the channel`
    : selected
      ? `Posting to #${label}${shared ? " — shared with everyone in this room" : ""} · click to change`
      : `Choose a channel to post to${shared ? " (shared with everyone in this room)" : ""}`;

  // Webhook-hostable channels, plus the current selection even if its type isn't
  // normally listed (e.g. launched from a voice channel) so the default never
  // vanishes from its own picker.
  const channels = useMemo(
    () =>
      (data?.channels ?? []).filter(
        (c) => WEBHOOK_CHANNEL_TYPES.has(c.type) || c.id === selectedId,
      ),
    [data, selectedId],
  );

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const matched = q ? channels.filter((c) => c.name.toLowerCase().includes(q)) : channels;
    return groupChannels(matched, (id) => data?.channelById[id]);
  }, [channels, data, q]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus the search box on open so the user can type-to-filter immediately.
  useLayoutEffect(() => {
    if (open && channels.length > SEARCH_THRESHOLD) searchRef.current?.focus();
  }, [open, channels.length]);

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={triggerTitle}
      >
        <ChannelTypeIcon type={selected?.type ?? 0} size={16} />
        <span className={styles.triggerName}>{label}</span>
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
                          const active = c.id === selectedId;
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={active}
                                className={styles.row}
                                data-active={active ? "" : undefined}
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
