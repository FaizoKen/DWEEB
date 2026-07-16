/**
 * The Message directory's shared card layer — everything below the chips:
 * the card model, the memoized card (live lazy-mounted thumbnail, delete /
 * never-expire affordances), the load-more sentinel, and the precomputed-
 * search plumbing.
 *
 * Two surfaces render this deck: the web app's full-screen `TemplateGallery`
 * and the embedded Activity's `ActivityGallery`. Both stay fast on a large
 * (Plus/Pro) shelf the same way — cards mount in pages, thumbnails mount on
 * approach (shared IntersectionObserver via `onceVisible`), search haystacks
 * are precomputed, and the cards' `content-visibility: auto` (see the CSS
 * module) lets off-screen ones skip layout & paint.
 *
 * Styling deliberately stays in `TemplateGallery.module.css` so the two
 * surfaces can't drift apart visually.
 */

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { onceVisible } from "@/lib/onceVisible";
import type { WebhookMessage } from "@/core/schema/types";
import { collectSearchText } from "@/core/schema/traversal";
import type { TemplateCategory } from "@/data/presets";
import { Preview } from "@/features/preview/Preview";
import { PuzzleIcon, TrashIcon } from "@/ui/Icon";
import styles from "./TemplateGallery.module.css";

/** One renderable card — a posted message, a saved message, an upcoming
 *  scheduled post, or a template. */
export interface CardData {
  kind: "posted" | "saved" | "scheduled" | "template";
  key: string;
  emoji: string;
  name: string;
  description: string;
  /** Absent on a scheduled card whose payload hasn't loaded (or has no
   *  message) — the card then shows a placeholder in place of the thumbnail. */
  message?: WebhookMessage;
  /** Scheduled only — the preview payload is still being fetched. */
  previewPending?: boolean;
  accent?: number;
  /** Template only — drives the category chip + the search haystack. */
  category?: TemplateCategory;
  requiresBot?: boolean;
  pairsWith?: string;
  /** Saved / posted only — "last edited" stamp shown as a relative time. */
  savedAt?: number;
  /** Overrides the relative-time stamp with a literal meta string (scheduled
   *  cards show their fire time in the schedule's own timezone). */
  metaText?: string;
  /** Saved / posted only — the small pill shown in place of a category. */
  badge?: string;
  /** True when this card came from the connected server's shared library. */
  storedInServerLibrary?: boolean;
  onPick: () => void;
  /** Remove this entry from its list (local store or server library). */
  onDelete?: () => void;
  /** Extra status pills after the badge — the library's derived labels
   *  ("Buttons expired"). */
  tags?: { text: string; tone: "ok" | "warn" | "info" }[];
  /** Posted only — the never-expire toggle chip at the preview's top-left.
   *  One control carries both the status and the action: "off" is a
   *  hover-revealed "+ Never expire" (claims a slot on tap, no confirm), while
   *  "on"/"paused" are always-visible status chips. On a mouse the chip flips to
   *  a red "- Never expire" on hover; on touch it shows a persistent "✕". Either
   *  way `run` opens a confirm before freeing (touch has no hover cue, so a bare
   *  tap must never silently remove the slot). */
  pin?: { state: "on" | "off" | "paused"; busy: boolean; title: string; run: () => void };
  /** Lowercased search haystack: the card's metadata plus text pulled from the
   *  message body (content, labels, …), so the card is findable by what the
   *  message says, not just its name. Fully precomputed when the card is built —
   *  a keystroke costs one `includes` per card, never a re-join. */
  search: string;
}

/** Join a card's searchable parts into its one lowercased haystack. */
export function searchHaystack(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/** Message-body search text, cached per (immutable) message object — shared by
 *  the saved / scheduled / template decks so a card-list rebuild never re-walks
 *  a message tree it has already indexed. (Library entries have their own
 *  per-entry cache in the library store.) */
const messageSearchCache = new WeakMap<WebhookMessage, string>();
export function messageSearchText(message: WebhookMessage): string {
  let cached = messageSearchCache.get(message);
  if (cached === undefined) {
    cached = collectSearchText(message);
    messageSearchCache.set(message, cached);
  }
  return cached;
}

/** How many cards mount per page. A Plus/Pro shelf can hold hundreds of
 *  entries; mounting every card at once (each hosts a live preview) makes
 *  opening the gallery a multi-second layout, so the grid grows page by page
 *  as the user scrolls (see the load-more sentinel). */
export const CARD_PAGE_SIZE = 24;
/** The first screenful of thumbnails mounts eagerly so the gallery never opens
 *  onto blank preview windows; everything past it lazy-mounts on approach. */
export const EAGER_THUMBNAILS = 3;

/** Compact "2m ago" / "yesterday" / "Mar 4" stamp for continue/saved cards. */
export function formatRelative(savedAt: number): string {
  const minutes = Math.round((Date.now() - savedAt) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Memoized so a search keystroke or a page reveal only renders the cards it
 *  actually adds or removes — card objects are stable between rebuilds of
 *  their deck. */
export const GalleryCard = memo(function GalleryCard({
  card,
  eagerThumb,
  priorityThumb,
}: {
  card: CardData;
  eagerThumb?: boolean;
  priorityThumb?: boolean;
}) {
  // The card is an article with one full-card primary button and separate
  // management buttons layered above it. This keeps the whole visual card
  // clickable without nesting buttons inside a role="button" container.
  const accent =
    card.accent !== undefined
      ? `#${card.accent.toString(16).padStart(6, "0")}`
      : "var(--app-accent)";

  const isTemplate = card.kind === "template";
  const isScheduled = card.kind === "scheduled";
  const isPosted = card.kind === "posted";
  const isServerLibrary = card.storedInServerLibrary === true;
  const cardLabel = isTemplate
    ? `Start from the ${card.name} template`
    : isScheduled
      ? `${card.name}, scheduled post`
      : isServerLibrary
        ? `${card.name}, saved in the server library`
        : card.name;
  const deleteLabel = isScheduled
    ? `Cancel scheduled post "${card.name}"`
    : isPosted
      ? `Remove "${card.name}" from the posted history`
      : isServerLibrary
        ? `Remove "${card.name}" from the server library`
        : `Delete browser draft "${card.name}"`;
  const deleteTitle = isScheduled
    ? "Cancel scheduled post"
    : isPosted
      ? "Remove from history now"
      : isServerLibrary
        ? "Remove from server library"
        : "Delete browser draft";

  return (
    <article
      className={styles.card}
      data-kind={card.kind}
      data-server-library={isServerLibrary ? "" : undefined}
      style={{ "--card-accent": accent } as CSSProperties}
    >
      <button
        type="button"
        className={styles.cardPrimary}
        onClick={card.onPick}
        aria-label={cardLabel}
      />
      <div className={styles.cardPreview}>
        {card.message ? (
          <TemplateThumbnail
            message={card.message}
            eager={eagerThumb}
            prioritizeMedia={priorityThumb}
          />
        ) : (
          // A scheduled card whose payload is still loading (or has none to
          // preview) — a calm placeholder in place of the live thumbnail.
          <div className={styles.thumbPlaceholder}>
            <span className={styles.thumbPlaceholderIcon} aria-hidden>
              🕒
            </span>
            <span>{card.previewPending ? "Loading preview…" : "Preview unavailable"}</span>
          </div>
        )}
        <div className={styles.cardFade} aria-hidden />
        {card.pin ? (
          // The never-expire toggle, top-left of the preview (delete sits
          // top-right). One chip = state AND action: "off" is a hover-revealed
          // "+ Never expire"; "on"/"paused" stay visible as status. On a mouse
          // the label flips to "- Never expire" on hover; on touch (no hover) a
          // persistent "✕" marks it removable. Either way, tapping a held slot
          // opens a confirm before it frees.
          <button
            type="button"
            className={styles.pinToggle}
            data-state={card.pin.state}
            disabled={card.pin.busy}
            title={card.pin.title}
            aria-pressed={card.pin.state !== "off"}
            onClick={(e) => {
              // A real <button> inside the card's div-with-role — the click
              // must not also load the message into the editor.
              e.stopPropagation();
              card.pin?.run();
            }}
          >
            <span className={styles.pinLabel}>
              {card.pin.state === "on"
                ? "✓ Never expires"
                : card.pin.state === "paused"
                  ? "Never expire · paused"
                  : "+ Never expire"}
            </span>
            {card.pin.state !== "off" ? (
              <>
                <span className={styles.pinLabelHover}>- Never expire</span>
                <span className={styles.pinRemoveGlyph} aria-hidden>
                  ✕
                </span>
              </>
            ) : null}
          </button>
        ) : null}
        {card.onDelete ? (
          <button
            type="button"
            className={styles.cardDelete}
            onClick={(e) => {
              e.stopPropagation();
              card.onDelete?.();
            }}
            aria-label={deleteLabel}
            title={deleteTitle}
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
            {card.kind === "posted"
              ? "Edit & update →"
              : card.kind === "template"
                ? "Use this template →"
                : "Load message →"}
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
              {card.tags?.map((t) => (
                <span key={t.text} className={styles.cardTag} data-tone={t.tone}>
                  {t.text}
                </span>
              ))}
              {card.metaText ? (
                <span className={styles.cardTime}>{card.metaText}</span>
              ) : card.savedAt !== undefined ? (
                <span className={styles.cardTime}>{formatRelative(card.savedAt)}</span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </article>
  );
});

/**
 * Chip-row placeholder for the gallery's one skeleton pass — pill shapes where
 * the real filter chips land once the server-fed shelves have answered (which
 * chips exist at all is a server answer, so real chips can't paint earlier
 * without popping in one by one).
 */
export function GalleryChipsSkeleton() {
  return (
    <>
      {[76, 98, 88].map((width, i) => (
        <span
          key={i}
          className={`${styles.skeletonBlock} ${styles.skeletonChip}`}
          style={{ width }}
          aria-hidden
        />
      ))}
    </>
  );
}

/**
 * Card-grid placeholder for the same skeleton pass — card-shaped blocks in the
 * real grid so the reveal swaps content without reflowing the panel. The
 * count roughly fills one screenful; the grid never scrolls in this state.
 */
export function GalleryGridSkeleton({ cards = 8 }: { cards?: number }) {
  return (
    <div className={styles.grid} role="status" aria-label="Loading your messages…">
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className={styles.skeletonCard} aria-hidden>
          <div className={`${styles.skeletonBlock} ${styles.skeletonThumb}`} />
          <div className={styles.skeletonBody}>
            <div
              className={`${styles.skeletonBlock} ${styles.skeletonLine}`}
              style={{ width: "55%" }}
            />
            <div
              className={`${styles.skeletonBlock} ${styles.skeletonLine}`}
              style={{ width: "85%" }}
            />
            <div
              className={`${styles.skeletonBlock} ${styles.skeletonLine}`}
              style={{ width: "40%" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Full-width row at the grid's tail that reveals the next page of cards —
 * automatically as it scrolls near (via the shared observer), or by click
 * (the keyboard / no-IntersectionObserver fallback). The parent keys it on the
 * revealed count so each reveal re-arms a fresh sentinel.
 */
export function LoadMoreSentinel({
  remaining,
  onReveal,
}: {
  remaining: number;
  onReveal: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return onceVisible(el, onReveal);
  }, [onReveal]);
  return (
    <div ref={ref} className={styles.loadMore}>
      <button type="button" className={styles.loadMoreBtn} onClick={onReveal}>
        Show {Math.min(remaining, CARD_PAGE_SIZE)} more
      </button>
    </div>
  );
}

/**
 * A faithful, read-only thumbnail of a message. Renders the real `Preview` at
 * "double" size and scales it to 0.5, clipping to the card window — the same
 * trick as the mobile `MiniPreview`. The inner tree is `inert` so none of the
 * rendered buttons/avatars can steal focus or a tap; the card is the single
 * interactive target.
 *
 * The Preview is the expensive part of a card, so it only mounts once the card
 * nears the viewport (`eager` skips the wait for the first screenful). Once
 * mounted it stays mounted — scrolling back is instant — and the off-screen
 * cost is handled by the card's `content-visibility: auto`. Memoized on the
 * (stable) message so typing in search doesn't re-render every visible
 * preview tree.
 */
const TemplateThumbnail = memo(function TemplateThumbnail({
  message,
  eager,
  prioritizeMedia,
}: {
  message: WebhookMessage;
  eager?: boolean;
  prioritizeMedia?: boolean;
}) {
  const [live, setLive] = useState(eager === true);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (live) return;
    const el = viewportRef.current;
    if (!el) return;
    return onceVisible(el, () => setLive(true));
  }, [live]);
  const makeInert = useCallback((el: HTMLDivElement | null) => {
    if (el) el.inert = true;
  }, []);
  return (
    <div className={styles.thumbViewport} ref={viewportRef}>
      {live ? (
        <div className={styles.thumbStage} ref={makeInert}>
          <Preview message={message} prioritizeMedia={prioritizeMedia} />
        </div>
      ) : null}
    </div>
  );
});
