/**
 * The Activity's destination *server* picker — shown only on a DM / group-DM
 * launch, where the Activity has no guild of its own.
 *
 * A DM can't host a webhook, so there's nothing to post into the DM itself.
 * Instead the user picks one of the servers they manage (the store pre-filters to
 * those where the DWEEB bot is present and they hold Manage Webhooks — the gate
 * the post enforces), and the existing `ChannelPicker` then chooses a channel
 * within it. Picking a server also loads that guild's data, so the preview starts
 * resolving its mentions/emoji.
 *
 * Mirrors `ChannelPicker`: a portalled, JS-positioned panel so it floats above
 * the editor pane's `overflow: hidden` instead of being clipped by it.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { guildIconUrl, type PickerGuild } from "@/core/guild/api";
import { CheckCircleIcon, ChevronDownIcon, CompassIcon, SearchIcon } from "@/ui/Icon";
import channelStyles from "./ChannelPicker.module.css";
import styles from "./GuildPicker.module.css";

/** Only show the search box once the list is long enough to need it. */
const SEARCH_THRESHOLD = 8;

export function GuildPicker({
  guilds,
  loading,
  selectedId,
  onSelect,
}: {
  /** The user's postable servers (already filtered by the store). */
  guilds: PickerGuild[];
  /** True while that list is still loading. */
  loading: boolean;
  /** The chosen destination server, or null before one is picked. */
  selectedId: string | null;
  /** A server was picked — close the panel and re-point publishing at it. */
  onSelect: (guildId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = selectedId ? guilds.find((g) => g.id === selectedId) : undefined;
  const label = selected?.name ?? "Pick a server";

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? guilds.filter((g) => g.name.toLowerCase().includes(q)) : guilds),
    [guilds, q],
  );

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
    if (open && guilds.length > SEARCH_THRESHOLD) searchRef.current?.focus();
  }, [open, guilds.length]);

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={wrapperRef} className={channelStyles.wrapper}>
      <button
        type="button"
        className={channelStyles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          selected ? `Posting to ${selected.name} — click to change` : "Choose a server to post to"
        }
      >
        {selected ? <ServerGlyph guild={selected} size={18} /> : <CompassIcon size={16} />}
        <span className={channelStyles.triggerName}>{label}</span>
        <ChevronDownIcon size={14} className={channelStyles.chevron} />
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="listbox"
              className={channelStyles.panel}
              style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width }}
            >
              {guilds.length > SEARCH_THRESHOLD ? (
                <div className={channelStyles.search}>
                  <SearchIcon size={14} className={channelStyles.searchIcon} />
                  <input
                    ref={searchRef}
                    className={channelStyles.searchInput}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search servers…"
                    aria-label="Search servers"
                  />
                </div>
              ) : null}

              {loading ? (
                <p className={channelStyles.note}>Loading your servers…</p>
              ) : guilds.length === 0 ? (
                <p className={channelStyles.note}>
                  No servers you can post to. Add DWEEB to a server where you have Manage Webhooks,
                  then relaunch.
                </p>
              ) : filtered.length === 0 ? (
                <p className={channelStyles.note}>No servers match that search.</p>
              ) : (
                <ul className={channelStyles.list}>
                  {filtered.map((g) => {
                    const active = g.id === selectedId;
                    return (
                      <li key={g.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={channelStyles.row}
                          data-active={active ? "" : undefined}
                          onClick={() => pick(g.id)}
                        >
                          <ServerGlyph guild={g} size={20} />
                          <span className={channelStyles.rowName}>{g.name}</span>
                          {active ? (
                            <CheckCircleIcon size={15} className={channelStyles.check} />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** A server's icon — the real one when set (Discord's CDN is CSP-allowed inside
 *  the iframe), else a coloured initial bubble so nothing depends on a fetch. */
function ServerGlyph({ guild, size }: { guild: PickerGuild; size: number }) {
  const url = guildIconUrl(guild.id, guild.icon, 64);
  if (url) {
    return (
      <img
        className={styles.icon}
        style={{ width: size, height: size }}
        src={url}
        alt=""
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      className={styles.initial}
      style={{ width: size, height: size, background: colorFor(guild.id) }}
      aria-hidden="true"
    >
      {(guild.name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** A stable, pleasant colour per server id (matches the presence avatars). */
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}deg 55% 45%)`;
}
