/**
 * Template Gallery — the app's full-screen landing screen.
 *
 * Opens on every visit (see `App`) so a user always starts from a deliberate
 * choice instead of a cold editor. It blends three sources into one
 * app-store-style grid:
 *
 *  - **Continue** — a pinned card for the auto-saved draft, so returning users
 *    resume their last message in one click.
 *  - **Saved** — the user's named, stashed messages (a dedicated category), so
 *    reusable messages are reachable without digging through the Saved menu.
 *  - **Templates** — the curated starting points, browsable by category.
 *
 * Every card carries a **live, faithful thumbnail** — the real `Preview`
 * renderer scaled down and made `inert`, so what you see is exactly what you'll
 * get. Search spans name / description / tags. Interactive templates are tagged
 * "Bot needed" and name the plugin they pair with.
 *
 * Picking a template or saved message replaces the editor wholesale (fresh ids,
 * undoable) and closes the gallery; "Continue" just closes it (the editor
 * already holds the draft). Rendered into a portal so it overlays the whole app.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useMessageStore } from "@/core/state/messageStore";
import { useSavedMessagesStore } from "@/core/state/savedMessagesStore";
import { recordOrigin, usePostedMessagesStore } from "@/core/state/postedMessagesStore";
import { alignConnectedGuild } from "@/core/guild/originGuild";
import { loadDraftMessage } from "@/core/state/draftStorage";
import { attachEditorFields } from "@/core/serialization/normalize";
import {
  TEMPLATE_CATEGORIES,
  TEMPLATES,
  type MessageTemplate,
  type TemplateCategory,
} from "@/data/presets";
import type { WebhookMessage } from "@/core/schema/types";
import { collectSearchText } from "@/core/schema/traversal";
import { getPlugins, isPluginRegistryConfigured } from "@/core/plugins/registry";
import { useSendNudgeStore } from "@/core/state/sendNudgeStore";
import { Preview } from "@/features/preview/Preview";
import { Button } from "@/ui/Button";
import { Modal } from "@/ui/Modal";
import { CloseIcon, PlusIcon, PuzzleIcon, SearchIcon, SparkleIcon, TrashIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { useTemplateGalleryStore } from "./templateGalleryStore";
import { useTemplateSetupStore } from "./templateSetupStore";
import styles from "./TemplateGallery.module.css";

/** Pseudo-categories that sit ahead of the template categories in the chip row. */
const SAVED_FILTER = "Saved" as const;
const POSTED_FILTER = "Posted" as const;
type Filter = "All" | typeof POSTED_FILTER | typeof SAVED_FILTER | TemplateCategory;

const ACCENT_BLURPLE = 0x5865f2;
const ACCENT_TEAL = 0x1abc9c;
const ACCENT_GREEN = 0x3ba55d;

/** How many posted cards surface in the "All" view before the rest are left to
 *  the dedicated "Posted" chip — keeps templates from being buried for someone
 *  who sends a lot. */
const POSTED_IN_ALL = 6;

/** One renderable card — a continue draft, a posted message, a saved message,
 *  or a template. */
interface CardData {
  kind: "continue" | "posted" | "saved" | "template";
  key: string;
  emoji: string;
  name: string;
  description: string;
  message: WebhookMessage;
  accent?: number;
  /** Template only — drives the category chip + the search haystack. */
  category?: TemplateCategory;
  requiresBot?: boolean;
  pairsWith?: string;
  /** Continue / saved only — "last edited" stamp shown as a relative time. */
  savedAt?: number;
  /** Continue / saved only — the small pill shown in place of a category. */
  badge?: string;
  /** Posted only — the home server, used to bucket posted cards under per-server
   *  section headers. `guildId` is the stable group key; `guildName` is the
   *  label. Either can be absent on older records / non-guild webhooks. */
  guildId?: string;
  guildName?: string;
  onPick: () => void;
  /** Saved only — remove this entry; drives the card's delete affordance. */
  onDelete?: () => void;
  /** Lowercased text pulled from the message body (content, labels, …) so the
   *  card is findable by what the message says, not just its name. Precomputed
   *  when the card is built so search stays cheap per keystroke. */
  searchText?: string;
}

/** Lowercased search haystack for one card — its metadata plus the message body. */
function haystack(c: CardData): string {
  return [c.name, c.description, c.category, c.pairsWith, c.badge, c.searchText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Compact "2m ago" / "yesterday" / "Mar 4" stamp for continue/saved cards. */
function formatRelative(savedAt: number): string {
  const minutes = Math.round((Date.now() - savedAt) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TemplateGallery() {
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const replaceMessageFromRestore = useMessageStore((s) => s.replaceMessageFromRestore);
  const clearAll = useMessageStore((s) => s.clearAll);
  const closeGallery = useTemplateGalleryStore((s) => s.closeGallery);
  const savedEntries = useSavedMessagesStore((s) => s.entries);
  const removeEntry = useSavedMessagesStore((s) => s.remove);
  const postedEntries = usePostedMessagesStore((s) => s.entries);
  const removePosted = usePostedMessagesStore((s) => s.remove);

  const [query, setQuery] = useState("");
  // Seeded once from the store so callers can deep-link straight to "Saved";
  // the gallery is remounted on each open, so this initialiser re-runs fresh.
  const [filter, setFilter] = useState<Filter>(
    () => useTemplateGalleryStore.getState().initialFilter,
  );
  const [pendingDelete, setPendingDelete] = useState<{
    kind: "saved" | "posted";
    id: string;
    name: string;
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
      if (e.key === "Escape") closeGallery();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeGallery]);

  // The auto-saved draft, hydrated once on open. Present only for a returning
  // user who has edited (or applied a template) before — a true first visit has
  // none, so the Continue card simply doesn't appear.
  const draft = useMemo(() => loadDraftMessage(), []);

  // Saved messages, re-hydrated to editable form for their thumbnails. Skips any
  // entry whose payload won't parse (an older/corrupt record) rather than throw.
  const savedMessages = useMemo(
    () =>
      savedEntries.flatMap((e) => {
        try {
          return [{ entry: e, message: attachEditorFields(e.payload) }];
        } catch {
          return [];
        }
      }),
    [savedEntries],
  );

  const continueCard: CardData | null = useMemo(
    () =>
      draft
        ? {
            kind: "continue",
            key: "__continue",
            emoji: "📝",
            name: "Continue where you left off",
            description: "Pick up your last message right where you left it.",
            message: draft.message,
            accent: ACCENT_BLURPLE,
            savedAt: draft.savedAt,
            badge: "Recent",
            searchText: collectSearchText(draft.message),
            // The editor already holds this draft (store bootstrap) — just close.
            onPick: () => closeGallery(),
          }
        : null,
    [draft, closeGallery],
  );

  const savedCards: CardData[] = useMemo(
    () =>
      savedMessages.map(({ entry, message }) => ({
        kind: "saved",
        key: entry.id,
        emoji: "🔖",
        name: entry.name,
        description: "One of your saved messages.",
        message,
        accent: ACCENT_TEAL,
        savedAt: entry.savedAt,
        badge: "Saved",
        searchText: collectSearchText(message),
        onPick: () => {
          replaceMessage(message);
          closeGallery();
          pushToast(`Loaded "${entry.name}"`, "success");
        },
        onDelete: () => setPendingDelete({ kind: "saved", id: entry.id, name: entry.name }),
      })),
    [savedMessages, replaceMessage, closeGallery],
  );

  // Posted messages, re-hydrated for their thumbnails (same skip-on-corrupt
  // guard as saved). Each carries the origin that lets a reload default the Send
  // panel to "Update existing", so editing then re-sending updates the live
  // message in place — no manual webhook + message-id paste.
  const postedMessages = useMemo(
    () =>
      postedEntries.flatMap((e) => {
        try {
          return [{ entry: e, message: attachEditorFields(e.payload) }];
        } catch {
          return [];
        }
      }),
    [postedEntries],
  );

  const postedCards: CardData[] = useMemo(
    () =>
      postedMessages.map(({ entry, message }) => {
        const where = entry.channelName
          ? `#${entry.channelName}${entry.guildName ? ` · ${entry.guildName}` : ""}`
          : entry.guildName;
        return {
          kind: "posted",
          key: entry.id,
          emoji: "📤",
          name: entry.channelName ? `#${entry.channelName}` : "Posted message",
          description: where
            ? `Posted to ${where}. Reload to edit and update it in place.`
            : "A message you posted. Reload to edit and update it in place.",
          message,
          accent: ACCENT_GREEN,
          savedAt: entry.postedAt,
          badge: "Posted",
          guildId: entry.guildId,
          guildName: entry.guildName,
          searchText: collectSearchText(message),
          onPick: () => {
            // Restore content *and* origin — the Send panel reads the origin and
            // flips to "Update existing" with the webhook + message id prefilled.
            replaceMessageFromRestore(message, recordOrigin(entry));
            // Re-align the connected guild to where this message lives, when the
            // user belongs to that server, so the preview's mentions/channels/
            // emoji resolve to the right names instead of placeholders. The
            // switch is visible (the guild selector updates) and never changes
            // where an update lands. When they aren't a member, the editor's
            // mismatch banner explains the placeholder names instead.
            alignConnectedGuild(entry.guildId);
            closeGallery();
            pushToast("Loaded your posted message — edits will update the original.", "success");
          },
          onDelete: () =>
            setPendingDelete({ kind: "posted", id: entry.id, name: where ?? "this message" }),
        };
      }),
    [postedMessages, replaceMessageFromRestore, closeGallery],
  );

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
        searchText: collectSearchText(t.message),
        onPick: () => {
          replaceMessage(t.message);
          closeGallery();
          // An interactive template ships one or more buttons/menus that still
          // need their paired plugin wired. Hand straight to the guided setup
          // checklist instead of dropping the user in a cold editor to hunt for
          // each component — but only when at least one declared slot resolves
          // to an available plugin.
          const canSetup =
            isPluginRegistryConfigured() &&
            !!t.pluginSlots?.length &&
            t.pluginSlots.some((slot) => getPlugins().some((p) => p.id === slot.pluginId));
          if (canSetup) {
            useTemplateSetupStore.getState().begin(t.id);
          } else {
            // Nothing to wire — skip straight to the editor and point the user at
            // Send with the same coach-mark (and raise the mobile preview), so a
            // static template lands the same place an interactive one finishes.
            useSendNudgeStore.getState().nudge();
          }
        },
      })),
    [replaceMessage, closeGallery],
  );

  // Chip row: All, then Posted and Saved (each only when there are any), then
  // the template categories that actually have entries.
  const filters: Filter[] = useMemo(
    () => [
      "All",
      ...(postedCards.length ? [POSTED_FILTER] : []),
      ...(savedCards.length ? [SAVED_FILTER] : []),
      ...TEMPLATE_CATEGORIES.filter((c) => templateCards.some((t) => t.category === c)),
    ],
    [postedCards.length, savedCards.length, templateCards],
  );

  // If the active filter disappears (e.g. last saved message removed), fall back
  // to All so the grid never looks empty for a stale reason.
  useEffect(() => {
    if (!filters.includes(filter)) setFilter("All");
  }, [filters, filter]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base: CardData[];
    if (filter === POSTED_FILTER) {
      base = postedCards;
    } else if (filter === SAVED_FILTER) {
      base = savedCards;
    } else if (filter === "All") {
      base = q
        ? // A search from All spans every starting point — the messages you've
          // posted and saved included, not just templates — so nothing is hidden
          // behind a chip or the posted cap.
          [...(continueCard ? [continueCard] : []), ...postedCards, ...savedCards, ...templateCards]
        : // Idle: recent activity first — the draft, then a capped slice of posted
          // messages (so they don't bury the templates) — then the curated
          // templates. Saved messages keep to their own chip, like a library.
          [
            ...(continueCard ? [continueCard] : []),
            ...postedCards.slice(0, POSTED_IN_ALL),
            ...templateCards,
          ];
    } else {
      base = templateCards.filter((c) => c.category === filter);
    }
    return q ? base.filter((c) => haystack(c).includes(q)) : base;
  }, [filter, query, continueCard, postedCards, savedCards, templateCards]);

  // On the dedicated Posted tab (idle, not searching), bucket the cards under
  // per-server headers — "where did I post this" is how sent messages are
  // actually remembered. Only when 2+ distinct servers are present; a single
  // header would just be noise, so we fall back to the flat grid. Records with
  // no resolved server collect under one "Other servers" bucket rather than
  // vanishing. Map insertion order keeps sections newest-post-first (shown is
  // already newest-first), matching the flat view's ordering.
  const postedSections = useMemo(() => {
    if (filter !== POSTED_FILTER || query.trim()) return null;
    const groups = new Map<string, { key: string; name: string; cards: CardData[] }>();
    for (const c of shown) {
      const key = c.guildId ?? c.guildName ?? "__unknown";
      let group = groups.get(key);
      if (!group) {
        group = { key, name: c.guildName ?? "Other servers", cards: [] };
        groups.set(key, group);
      }
      group.cards.push(c);
    }
    if (groups.size < 2) return null;
    return [...groups.values()];
  }, [filter, query, shown]);

  const startBlank = () => {
    clearAll();
    closeGallery();
    pushToast("Started a blank message", "info");
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "posted") {
      removePosted(pendingDelete.id);
      pushToast("Removed from your posted messages", "info");
    } else {
      removeEntry(pendingDelete.id);
      pushToast(`Deleted "${pendingDelete.name}"`, "info");
    }
    setPendingDelete(null);
  };

  return createPortal(
    <>
      <div
        className={styles.backdrop}
        role="dialog"
        aria-modal="true"
        aria-label="Start a message"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeGallery();
        }}
      >
        <div className={styles.panel}>
          <header className={styles.header}>
            <div className={styles.headingRow}>
              <div className={styles.heading}>
                <h2 className={styles.title}>
                  <span className={styles.titleSpark} aria-hidden>
                    <SparkleIcon size={17} />
                  </span>
                  Start a message
                </h2>
                <p className={styles.subtitle}>
                  Continue your last message, reuse a saved one, or pick a template — everything is
                  fully editable.
                </p>
              </div>
              <button
                type="button"
                className={styles.close}
                onClick={closeGallery}
                aria-label="Close template gallery"
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
                    postedCards.length || savedCards.length || continueCard
                      ? "Search your messages & templates…"
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

              <div className={styles.chips} role="group" aria-label="Filter templates by category">
                {filters.map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={filter === f}
                    className={[
                      styles.chip,
                      // The Saved/Posted pseudo-categories carry their own tints
                      // (teal / green) so a user's own messages stand out from the
                      // curated template categories.
                      f === SAVED_FILTER ? styles.chipSaved : "",
                      f === POSTED_FILTER ? styles.chipPosted : "",
                      filter === f ? styles.chipActive : "",
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
            {shown.length === 0 ? (
              <div className={styles.empty}>
                <SearchIcon size={28} aria-hidden />
                <p className={styles.emptyTitle}>No matches for “{query.trim()}”.</p>
                <button
                  type="button"
                  className={styles.emptyReset}
                  onClick={() => {
                    setQuery("");
                    setFilter("All");
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : postedSections ? (
              <div className={styles.sections}>
                {postedSections.map((section) => (
                  <section key={section.key} className={styles.section}>
                    <div className={styles.sectionHeader}>
                      <span className={styles.sectionName}>{section.name}</span>
                      <span className={styles.sectionCount}>{section.cards.length}</span>
                    </div>
                    <div className={styles.grid}>
                      {section.cards.map((c) => (
                        <GalleryCard key={c.key} card={c} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className={styles.grid}>
                {shown.map((c) => (
                  <GalleryCard key={c.key} card={c} />
                ))}
              </div>
            )}
          </div>

          <footer className={styles.footer}>
            <span className={styles.footerHint}>
              {shown.length} {shown.length === 1 ? "result" : "results"} · reopen this any time from
              the toolbar
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
          pendingDelete?.kind === "posted" ? "Remove posted message?" : "Delete saved message?"
        }
        size="sm"
        // The gallery overlay sits at --app-z-tooltip; lift the confirm above it
        // so it (and its scrim) land on top rather than behind the gallery.
        backdropStyle={{ zIndex: "calc(var(--app-z-tooltip) + 10)" }}
      >
        <div className={styles.confirmBody}>
          <p className={styles.confirmText}>
            {pendingDelete?.kind === "posted" ? (
              <>
                Remove <strong>{pendingDelete?.name}</strong> from this list? It only forgets the
                local shortcut — the message stays live on Discord, and you can still edit it via
                Restore.
              </>
            ) : (
              <>
                Permanently delete <strong>"{pendingDelete?.name}"</strong>? This can't be undone.
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
              {pendingDelete?.kind === "posted" ? "Remove" : "Delete"}
            </Button>
          </div>
        </div>
      </Modal>
    </>,
    document.body,
  );
}

function GalleryCard({ card }: { card: CardData }) {
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // Only the card itself activates on Enter/Space — keys aimed at the inner
      // delete button (a real <button>) must not also trigger a load.
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        card.onPick();
      }
    },
    [card],
  );

  // The card holds a Preview whose tree contains its own <button>s, so the card
  // is a div-with-role rather than a real <button> (nested buttons are invalid).
  const accent =
    card.accent !== undefined
      ? `#${card.accent.toString(16).padStart(6, "0")}`
      : "var(--app-accent)";

  const isTemplate = card.kind === "template";

  return (
    <div
      className={styles.card}
      data-kind={card.kind}
      role="button"
      tabIndex={0}
      onClick={card.onPick}
      onKeyDown={onKeyDown}
      aria-label={isTemplate ? `Start from the ${card.name} template` : `${card.name}`}
      style={{ "--card-accent": accent } as CSSProperties}
    >
      <div className={styles.cardPreview}>
        <TemplateThumbnail message={card.message} />
        <div className={styles.cardFade} aria-hidden />
        {card.onDelete ? (
          <button
            type="button"
            className={styles.cardDelete}
            onClick={(e) => {
              e.stopPropagation();
              card.onDelete?.();
            }}
            aria-label={
              card.kind === "posted"
                ? `Remove posted message "${card.name}"`
                : `Delete saved message "${card.name}"`
            }
            title={card.kind === "posted" ? "Remove from posted messages" : "Delete saved message"}
          >
            <TrashIcon size={15} />
          </button>
        ) : null}
        {card.requiresBot ? (
          <span
            className={styles.botBadge}
            title="Includes interactive components — needs a bot/app webhook"
          >
            Interactive
          </span>
        ) : null}
        <div className={styles.cardHover} aria-hidden>
          <span className={styles.useBtn}>
            {card.kind === "continue"
              ? "Continue →"
              : card.kind === "posted"
                ? "Edit & update →"
                : card.kind === "saved"
                  ? "Load message →"
                  : "Use this template →"}
          </span>
        </div>
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <span className={styles.cardEmoji} aria-hidden>
            {card.emoji}
          </span>
          <span className={styles.cardName}>{card.name}</span>
        </div>
        <p className={styles.cardDesc}>{card.description}</p>
        <div className={styles.cardMeta}>
          {isTemplate ? (
            <>
              <span className={styles.cardCategory}>{card.category}</span>
              {card.pairsWith ? (
                <span
                  className={styles.cardPlugin}
                  title={`Pairs with the ${card.pairsWith} plugin`}
                >
                  <PuzzleIcon size={12} aria-hidden />
                  {card.pairsWith}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span className={styles.cardCategory}>{card.badge}</span>
              {card.savedAt !== undefined ? (
                <span className={styles.cardTime}>{formatRelative(card.savedAt)}</span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A faithful, read-only thumbnail of a message. Renders the real `Preview` at
 * "double" size and scales it to 0.5, clipping to the card window — the same
 * trick as the mobile `MiniPreview`. The inner tree is `inert` so none of the
 * rendered buttons/avatars can steal focus or a tap; the card is the single
 * interactive target. Memoized on the (stable) message so typing in search
 * doesn't re-render every visible preview tree.
 */
const TemplateThumbnail = memo(function TemplateThumbnail({
  message,
}: {
  message: WebhookMessage;
}) {
  const makeInert = useCallback((el: HTMLDivElement | null) => {
    if (el) el.inert = true;
  }, []);
  return (
    <div className={styles.thumbViewport}>
      <div className={styles.thumbStage} ref={makeInert}>
        <Preview message={message} />
      </div>
    </div>
  );
});
