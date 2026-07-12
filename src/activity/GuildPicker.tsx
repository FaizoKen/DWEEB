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
import { useScrollActiveIntoView } from "@/lib/useScrollActiveIntoView";
import { CheckCircleIcon, ChevronDownIcon, CompassIcon, PlusIcon, SearchIcon } from "@/ui/Icon";
import channelStyles from "@/features/guild/ChannelPicker.module.css";
import styles from "./GuildPicker.module.css";

/** Only show the search box once the list is long enough to need it. */
const SEARCH_THRESHOLD = 8;

export function GuildPicker({
  guilds,
  loading,
  selectedId,
  onSelect,
  onAddServer,
  compact = false,
}: {
  /** The user's postable servers (already filtered by the store). */
  guilds: PickerGuild[];
  /** True while that list is still loading. */
  loading: boolean;
  /** The chosen destination server, or null before one is picked. */
  selectedId: string | null;
  /** A server was picked — close the panel and re-point publishing at it. */
  onSelect: (guildId: string) => void;
  /** Open Discord's "Add DWEEB to a server" flow. When provided the panel shows a
   *  persistent "Add a server" action (pinned below the list, and the whole of an
   *  empty state) so a user with no postable server yet — or one wanting a new
   *  destination — can add the bot without leaving the picker. The list refreshes
   *  itself when they return (the bar re-fetches on focus), so the panel is left
   *  open on click to let the new server pop in. */
  onAddServer?: () => void;
  /** Collapse the trigger to just the server icon plus its dropdown arrow once a
   *  server is picked (dropping the name) — used by the bar's left server
   *  indicator. Before one's picked it still shows the "Pick a server" label so
   *  it stays discoverable. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Centre the already-picked server in the list each time the panel opens, so
  // it's visible rather than buried below the fold. The panel mounts a render
  // after `open` (its position is measured in an effect), which the hook waits
  // out; re-arming on `open` makes it fire again on every reopen.
  const listRef = useRef<HTMLUListElement>(null);
  const activeRowRef = useRef<HTMLLIElement>(null);
  useScrollActiveIntoView(listRef, activeRowRef, [open]);

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

  // In compact mode a picked server shows as just its icon + dropdown arrow; the
  // name returns whenever nothing's chosen yet, so "Pick a server" stays clear.
  const collapsed = compact && selected != null;

  return (
    <div ref={wrapperRef} className={channelStyles.wrapper}>
      <button
        type="button"
        className={channelStyles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={collapsed ? `Posting to ${selected.name} — click to change` : undefined}
        title={
          selected ? `Posting to ${selected.name} — click to change` : "Choose a server to post to"
        }
      >
        {selected ? <ServerGlyph guild={selected} size={28} /> : <CompassIcon size={18} />}
        {collapsed ? null : <span className={channelStyles.triggerName}>{label}</span>}
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
                // With the "Add a server" action below, the note just explains the
                // requirement — the button (plus the bar's refresh-on-return) is the
                // action, so no "then relaunch" step. Without it, keep the old hint.
                <p className={channelStyles.note}>
                  {onAddServer
                    ? "You're not in a server you can post to yet — add DWEEB to one where you have the “Manage Webhooks” permission:"
                    : "No servers you can post to. Add DWEEB to a server where you have Manage Webhooks, then relaunch."}
                </p>
              ) : filtered.length === 0 ? (
                <p className={channelStyles.note}>No servers match that search.</p>
              ) : (
                <ul className={`${channelStyles.list} ${styles.guildList}`} ref={listRef}>
                  {filtered.map((g) => {
                    const active = g.id === selectedId;
                    return (
                      <li key={g.id} ref={active ? activeRowRef : undefined}>
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

              {/* Persistent "Add a server" action, pinned below the list. Opens
                  Discord's add-bot flow (no pre-selected guild) so the user can add
                  DWEEB to a new server without leaving the picker. The panel stays
                  open on click so the freshly added server can pop into the list
                  once the bar's refresh-on-return lands (see ActivityBar). */}
              {onAddServer ? (
                <button type="button" className={styles.addServer} onClick={onAddServer}>
                  <span className={styles.addServerIcon} aria-hidden="true">
                    <PlusIcon size={16} />
                  </span>
                  <span className={styles.addServerLabel}>Add a server</span>
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** A server's icon — the real one when set (Discord's CDN is CSP-allowed inside
 *  the iframe), else a coloured initial bubble so nothing depends on a fetch.
 *  Exported for the bar's static (non-picker) server badge on a guild launch. */
export function ServerGlyph({ guild, size }: { guild: PickerGuild; size: number }) {
  const url = guildIconUrl(guild.id, guild.icon, 64);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  // The same glyph slot can be re-pointed at a different server (the bar badge and
  // compact picker trigger reuse one instance), so reset the load state when the
  // icon URL changes — otherwise the new icon would inherit the old one's "loaded"
  // and skip its skeleton.
  const lastUrl = useRef(url);
  if (lastUrl.current !== url) {
    lastUrl.current = url;
    setLoaded(false);
    setErrored(false);
  }

  // Real icon, when the guild has one and it hasn't failed to load. A breathing
  // skeleton fills the slot until the image paints, so the icon fades in over it
  // rather than popping in against an empty gap.
  if (url && !errored) {
    return (
      <span className={styles.iconSlot} style={{ width: size, height: size }} aria-hidden="true">
        {!loaded && <span className={styles.iconSkeleton} />}
        <img
          className={styles.icon}
          style={{ width: size, height: size, opacity: loaded ? 1 : 0 }}
          src={url}
          alt=""
          aria-hidden="true"
          // A cached icon can already be complete before React wires onLoad, so
          // confirm on mount too — otherwise its skeleton would never clear.
          ref={(el) => {
            if (el?.complete && el.naturalWidth > 0) setLoaded(true);
          }}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      </span>
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

/** The standalone breathing placeholder for a server glyph, sized like {@link
 *  ServerGlyph}. Shown in the bar's server badge while a guild launch's meta is
 *  still being fetched — before there's even an icon URL to load — so the slot
 *  holds a skeleton instead of an empty gap. */
export function ServerGlyphSkeleton({ size }: { size: number }) {
  return (
    <span
      className={styles.glyphSkeleton}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/** A stable, pleasant colour per server id (matches the presence avatars). */
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}deg 55% 45%)`;
}
