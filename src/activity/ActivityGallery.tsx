/**
 * Activity "Message directory" — the embedded surface's version of the web
 * app's full-screen gallery, sharing its card layer (`galleryCards`) and CSS
 * so the two can't drift apart: the same searchable grid of live, faithful
 * thumbnails, mounted in pages so a large (Plus/Pro) shelf opens instantly.
 *
 * Three chips instead of the web's five:
 *  - **Posted** — the target server's shared library history; picking one
 *    re-wires the toolbar to update the live message in place
 *    (`activityStore.loadLibraryEntry`).
 *  - **Server drafts** — the library's saved messages, shared with everyone
 *    who manages this server.
 *  - **Template** — the curated starting points, loaded straight into the
 *    room's shared editor.
 *
 * Deliberately absent: **Browser drafts** (localStorage isn't a surface inside
 * Discord's iframe — nothing local exists here by design), **Scheduled**
 * (creating a schedule lives in the post confirm's "When" choice; the list and
 * cancel/edit stay on the web), and the never-expire slot manager (its API
 * rides the web cookie session, not the Activity's bearer token — the web
 * gallery stays the management surface).
 *
 * Rendered as a full-screen overlay via portal, exactly like the web gallery;
 * mounted only while open (see ActivityBar), so state resets per visit.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useActivityStore } from "@/core/activity/activityStore";
import { useMessageStore } from "@/core/state/messageStore";
import {
  libraryEntryMessage,
  libraryEntrySearchText,
  useLibraryStore,
} from "@/core/library/libraryStore";
import { TEMPLATES, type MessageTemplate } from "@/data/presets";
import { Button } from "@/ui/Button";
import { Modal } from "@/ui/Modal";
import { CloseIcon, PlusIcon, SearchIcon, SparkleIcon, TrashIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import {
  CARD_PAGE_SIZE,
  EAGER_THUMBNAILS,
  GalleryCard,
  LoadMoreSentinel,
  messageSearchText,
  searchHaystack,
  type CardData,
} from "@/features/templates/galleryCards";
import { ServerGlyph } from "./GuildPicker";
import styles from "@/features/templates/TemplateGallery.module.css";

const POSTED_FILTER = "Posted" as const;
const SERVER_DRAFTS_FILTER = "Server drafts" as const;
const TEMPLATE_FILTER = "Template" as const;
type Filter = typeof POSTED_FILTER | typeof SERVER_DRAFTS_FILTER | typeof TEMPLATE_FILTER;

const ACCENT_TEAL = 0x1abc9c;
const ACCENT_GREEN = 0x3ba55d;

export function ActivityGallery({ onClose }: { onClose: () => void }) {
  const targetGuildId = useActivityStore((s) => s.targetGuildId);
  const targetGuildMeta = useActivityStore((s) => s.targetGuildMeta);
  const loadEntry = useActivityStore((s) => s.loadLibraryEntry);
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const clearAll = useMessageStore((s) => s.clearAll);

  const libEntries = useLibraryStore((s) => s.entries);
  const libGuild = useLibraryStore((s) => s.guildId);
  const libPosted = useLibraryStore((s) => s.posted);
  const libDrafts = useLibraryStore((s) => s.drafts);
  const libLoaded = useLibraryStore((s) => s.loaded);
  const removeLibrary = useLibraryStore((s) => s.remove);

  // (Re)load the target server's shelf on open — posts from teammates or the
  // web app should show up without a relaunch.
  useEffect(() => {
    if (targetGuildId) void useLibraryStore.getState().refresh(targetGuildId);
  }, [targetGuildId]);

  const [query, setQuery] = useState("");
  // Filtering runs against the deferred value so typing stays responsive even
  // when a keystroke re-filters (and re-renders) a large deck.
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState<Filter>(POSTED_FILTER);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    guildId: string;
    name: string;
    /** A `posted` history entry (vs a server draft) — the confirm frames it as
     *  pruning the shared history now rather than waiting for it to roll off. */
    posted: boolean;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Focus search on open so a user can start typing immediately.
  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, []);

  // Lock body scroll behind the overlay; restore on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Escape closes the gallery from anywhere within it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The target server's library entries — only when the loaded library actually
  // matches the target (a switch mid-load must not show another server's shelf).
  const serverEntries = useMemo(
    () => (libGuild && libGuild === targetGuildId ? libEntries : []),
    [libGuild, targetGuildId, libEntries],
  );

  const serverName = targetGuildMeta?.name;
  const { postedCards, draftCards } = useMemo(() => {
    const posted: CardData[] = [];
    const drafts: CardData[] = [];
    for (const entry of serverEntries) {
      const message = libraryEntryMessage(entry);
      if (!message) continue;
      const isPosted = entry.label === "posted";
      const displayName =
        entry.title?.trim() || entry.dest_label || (isPosted ? "Posted message" : "Server draft");
      const description = isPosted
        ? `${entry.dest_label ? `Posted to ${entry.dest_label}` : "Posted"} · synced automatically in the ${
            serverName ?? "server"
          } history — load it and edits update the live message in place.`
        : `A saved message in the ${serverName ?? "server"} library, shared with this server's managers.`;
      const card: CardData = {
        kind: isPosted ? "posted" : "saved",
        key: `lib:${entry.id}`,
        emoji: isPosted ? "📤" : "🔖",
        name: displayName,
        description,
        message,
        accent: isPosted ? ACCENT_GREEN : ACCENT_TEAL,
        savedAt: entry.updated_at * 1000,
        badge: isPosted ? "Posted" : "Server draft",
        storedInServerLibrary: true,
        search: searchHaystack(
          displayName,
          description,
          isPosted ? "Posted" : "Server draft",
          libraryEntrySearchText(entry),
        ),
        onPick: () => {
          // loadLibraryEntry loads into the shared editor (collab broadcasts to
          // the room), re-wires Update-in-place for a posted entry, and toasts.
          if (loadEntry(entry)) {
            onClose();
          } else {
            pushToast("This entry couldn't be read — it may predate a server key change.", "error");
          }
        },
        onDelete: () =>
          setPendingDelete({
            id: entry.id,
            guildId: entry.guild_id,
            name: displayName,
            posted: isPosted,
          }),
      };
      (isPosted ? posted : drafts).push(card);
    }
    return { postedCards: posted, draftCards: drafts };
  }, [serverEntries, serverName, loadEntry, onClose]);

  const templateCards: CardData[] = useMemo(
    () =>
      TEMPLATES.map((t: MessageTemplate) => ({
        kind: "template",
        key: t.id,
        emoji: t.emoji,
        name: t.name,
        description: t.description,
        message: t.message,
        accent: t.accent,
        category: t.category,
        requiresBot: t.requiresBot,
        pairsWith: t.pairsWith,
        search: searchHaystack(
          t.name,
          t.description,
          t.category,
          t.pairsWith,
          messageSearchText(t.message),
        ),
        onPick: () => {
          // Straight into the room's shared editor — the Activity has no plugin
          // setup checklist (that guided flow lives on the web), so the template
          // lands ready to edit together and post.
          replaceMessage(t.message);
          onClose();
          pushToast(`Loaded the "${t.name}" template — everything's editable.`, "success");
        },
      })),
    [replaceMessage, onClose],
  );

  // Chips only for tabs that have something to show; Template is always there.
  const filters: Filter[] = useMemo(
    () => [
      ...(postedCards.length ? [POSTED_FILTER] : []),
      ...(draftCards.length ? [SERVER_DRAFTS_FILTER] : []),
      TEMPLATE_FILTER,
    ],
    [postedCards.length, draftCards.length],
  );
  const activeFilter = filters.includes(filter) ? filter : (filters[0] ?? TEMPLATE_FILTER);

  // On a cold open the library hasn't answered yet, so the Posted/Server-drafts
  // chips don't exist *yet* — hold the requested filter until the load settles
  // so the gallery lands on Posted once entries arrive instead of bouncing to
  // Templates on every open.
  const libraryPending = !!targetGuildId && !(libGuild === targetGuildId && libLoaded);
  useEffect(() => {
    if (libraryPending && (filter === POSTED_FILTER || filter === SERVER_DRAFTS_FILTER)) return;
    if (filter !== activeFilter) setFilter(activeFilter);
  }, [activeFilter, filter, libraryPending]);

  const shown = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const base =
      activeFilter === POSTED_FILTER
        ? postedCards
        : activeFilter === SERVER_DRAFTS_FILTER
          ? draftCards
          : templateCards;
    return q ? base.filter((c) => c.search.includes(q)) : base;
  }, [activeFilter, deferredQuery, postedCards, draftCards, templateCards]);

  // The grid mounts in pages — a new tab or search starts back at one page,
  // and the sentinel at the grid's tail reveals the next as the user nears it.
  const [visibleCount, setVisibleCount] = useState(CARD_PAGE_SIZE);
  useEffect(() => {
    setVisibleCount(CARD_PAGE_SIZE);
  }, [activeFilter, deferredQuery]);
  const visibleCards = shown.length > visibleCount ? shown.slice(0, visibleCount) : shown;
  const revealMore = useCallback(() => setVisibleCount((n) => n + CARD_PAGE_SIZE), []);

  const startBlank = () => {
    clearAll();
    onClose();
    pushToast("Started a blank message", "info");
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const { guildId, id } = pendingDelete;
    void removeLibrary(guildId, id).then((ok) => {
      pushToast(
        ok ? "Removed from the server library" : "Couldn't remove it — try again.",
        ok ? "info" : "error",
      );
    });
    setPendingDelete(null);
  };

  return createPortal(
    <>
      <div
        className={styles.backdrop}
        role="dialog"
        aria-modal="true"
        aria-label={serverName ? `Message directory for ${serverName}` : "Message directory"}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.panel}>
          <header className={styles.header}>
            <div className={styles.headingRow}>
              <div className={styles.heading}>
                <h2 className={styles.title}>
                  {targetGuildMeta ? (
                    <span
                      className={styles.titleGlyph}
                      role="img"
                      aria-label={`Discord server: ${targetGuildMeta.name}`}
                      title={`Discord server: ${targetGuildMeta.name}`}
                    >
                      <ServerGlyph guild={targetGuildMeta} size={22} />
                    </span>
                  ) : (
                    <span className={styles.titleSpark} aria-hidden>
                      <SparkleIcon size={17} />
                    </span>
                  )}
                  Message directory
                </h2>
                <p className={styles.subtitle}>
                  Reload a posted message, reuse a saved one, or pick a template — everything is
                  fully editable, together.
                </p>
              </div>
              <button
                type="button"
                className={styles.close}
                onClick={onClose}
                aria-label="Close message directory"
              >
                <CloseIcon size={20} />
              </button>
            </div>

            <div className={styles.controls}>
              <div className={styles.search}>
                <SearchIcon size={16} className={styles.searchIcon} aria-hidden />
                <input
                  ref={searchRef}
                  type="text"
                  name="templateSearch"
                  className={styles.searchInput}
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  placeholder={
                    postedCards.length || draftCards.length
                      ? "Search this server's messages & templates…"
                      : `Search ${TEMPLATES.length} templates…`
                  }
                  aria-label="Search messages and templates"
                />
                {query ? (
                  <button
                    type="button"
                    className={styles.searchClear}
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                    aria-label="Clear search"
                  >
                    <CloseIcon size={14} />
                  </button>
                ) : null}
              </div>

              <div className={styles.chips} role="group" aria-label="Filter by category">
                {filters.map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={activeFilter === f}
                    className={[
                      styles.chip,
                      f === SERVER_DRAFTS_FILTER ? styles.chipSaved : "",
                      f === POSTED_FILTER ? styles.chipPosted : "",
                      activeFilter === f ? styles.chipActive : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </header>

          <div className={styles.body}>
            {/* Per-tab usage read-out, mirroring the web gallery. Shown once the
                shelf has loaded for the target server. */}
            {targetGuildId && libGuild === targetGuildId && libLoaded ? (
              <>
                {activeFilter === POSTED_FILTER ? (
                  <p
                    className={styles.tabMeter}
                    title="Posted messages sync automatically — the newest posts, oldest roll off."
                  >
                    <strong>Posted history:</strong> {libPosted.used}
                    {libPosted.quota != null ? ` / ${libPosted.quota}` : ""}
                  </p>
                ) : null}
                {activeFilter === SERVER_DRAFTS_FILTER ? (
                  <p
                    className={styles.tabMeter}
                    data-over={
                      libDrafts.quota != null && libDrafts.used > libDrafts.quota ? "" : undefined
                    }
                    title={
                      libDrafts.quota != null && libDrafts.used > libDrafts.quota
                        ? "More server drafts than the plan allows — they stay readable, but content can't be changed until you delete down to the limit or upgrade."
                        : "Server drafts are yours to add and remove."
                    }
                  >
                    <strong>Server drafts:</strong> {libDrafts.used}
                    {libDrafts.quota != null ? ` / ${libDrafts.quota}` : ""}
                    {libDrafts.quota != null && libDrafts.used > libDrafts.quota
                      ? " · over limit"
                      : ""}
                  </p>
                ) : null}
              </>
            ) : null}

            {shown.length > 0 ? (
              <div className={styles.grid}>
                {visibleCards.map((c, i) => (
                  <GalleryCard key={c.key} card={c} eagerThumb={i < EAGER_THUMBNAILS} />
                ))}
                {shown.length > visibleCards.length ? (
                  // Keyed on the revealed count so each reveal re-arms a fresh
                  // sentinel for the following page.
                  <LoadMoreSentinel
                    key={visibleCards.length}
                    remaining={shown.length - visibleCards.length}
                    onReveal={revealMore}
                  />
                ) : null}
              </div>
            ) : (
              <div className={styles.empty}>
                <SearchIcon size={28} aria-hidden />
                {query.trim() ? (
                  <>
                    <p className={styles.emptyTitle}>No matches for “{query.trim()}”.</p>
                    <button
                      type="button"
                      className={styles.emptyReset}
                      onClick={() => setQuery("")}
                    >
                      Clear search
                    </button>
                  </>
                ) : libraryPending && activeFilter !== TEMPLATE_FILTER ? (
                  <p className={styles.emptyTitle}>Loading the server library…</p>
                ) : (
                  <p className={styles.emptyTitle}>
                    Nothing here yet — post a message and it lands in this history automatically.
                  </p>
                )}
              </div>
            )}
          </div>

          <footer className={styles.footer}>
            <span className={styles.footerHint}>
              {shown.length} {shown.length === 1 ? "result" : "results"}
            </span>
            <button type="button" className={styles.blankBtn} onClick={startBlank}>
              <PlusIcon size={16} />
              Start from scratch
            </button>
          </footer>
        </div>
      </div>

      <Modal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title={
          pendingDelete?.posted ? "Remove from posted history?" : "Remove from the server library?"
        }
        size="sm"
        // The gallery overlay sits at --app-z-tooltip; lift the confirm above it
        // so it (and its scrim) land on top rather than behind the gallery.
        backdropStyle={{ zIndex: "calc(var(--app-z-tooltip) + 10)" }}
      >
        <div className={styles.confirmBody}>
          <p className={styles.confirmText}>
            {pendingDelete?.posted ? (
              <>
                Remove <strong>{pendingDelete?.name}</strong> from this server's posted history now?
                It won't wait to roll off on its own — every manager loses the entry (the message
                stays live on Discord). This can't be undone.
              </>
            ) : (
              <>
                Remove <strong>{pendingDelete?.name}</strong> from the server library? Everyone
                managing this server loses this entry (a posted message stays live on Discord). This
                can't be undone.
              </>
            )}
          </p>
          <div className={styles.confirmActions}>
            <Button variant="ghost" type="button" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              type="button"
              leadingIcon={<TrashIcon />}
              onClick={confirmDelete}
            >
              Remove
            </Button>
          </div>
        </div>
      </Modal>
    </>,
    document.body,
  );
}
