/**
 * Validation for the rating aggregate that becomes `aggregateRating` in the
 * generated pages' structured data.
 *
 * This lives under `src/core` rather than beside the generator in `scripts/`
 * for one reason: it is the boundary between an HTTP response and a factual
 * claim DWEEB publishes about itself, and the test suite only covers `src/**`.
 * The fetching half — network, env vars, timeouts — stays in
 * `scripts/seo/ratings.ts`, which has nothing to assert about.
 *
 * Every check here fails **closed**: an unparseable, inconsistent, or
 * out-of-range payload resolves to "no rating", which ships a page without
 * stars. That is always preferable to publishing a number we could not verify,
 * because a rating snippet Google judges fabricated is a manual action against
 * the whole domain rather than against one page.
 */

/** Shape of `GET /api/rating` (see `server/src/rating.rs`). */
export interface RatingAggregate {
  /** Mean score, already rounded to one decimal by the server. */
  average: number;
  /** How many people have rated. */
  count: number;
  /** Top of the scale (5). */
  best: number;
  /** Bottom of the scale (1). */
  worst: number;
  /** `distribution[n]` = ratings of score `n + 1`. */
  distribution: number[];
}

/**
 * Fewest ratings before anything is published.
 *
 * Two independent reasons, and the stricter one binds: a mean of a handful of
 * scores is not a measurement anyone should act on, and Google is entitled to
 * treat a thin self-reported rating as spam. Twenty-five is comfortably past
 * the point where one enthusiastic friend moves the headline figure by a tenth.
 *
 * Raising this is always safe. Lowering it below ~10 is not — at that point the
 * page is publishing noise as a fact about the product.
 */
export const MIN_RATINGS_TO_PUBLISH = 25;

/** How many buckets the distribution must carry — one per point of the scale. */
const SCALE_POINTS = 5;

/**
 * Parse and validate a rating payload, or return null.
 *
 * Nothing is coerced and nothing is defaulted: a field of the wrong type means
 * the server and this reader disagree about what is being measured, and the
 * safe reading of that disagreement is silence.
 */
export function parseRatingAggregate(value: unknown): RatingAggregate | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const { average, count, best, worst } = raw;

  if (typeof average !== "number" || !Number.isFinite(average)) return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  if (typeof best !== "number" || typeof worst !== "number") return null;
  if (!Number.isFinite(best) || !Number.isFinite(worst) || worst >= best) return null;

  // A mean outside its own scale is incoherent — publishing "6.2 out of 5"
  // would be visibly wrong on the page and is the shape a bug or a tampered
  // response takes. The count-zero case is allowed through as the neutral
  // "nothing yet" reading and is filtered by the publish floor instead.
  if (count > 0 && (average < worst || average > best)) return null;

  const distribution = Array.isArray(raw.distribution) ? raw.distribution : null;
  if (!distribution || distribution.length !== SCALE_POINTS) return null;
  if (!distribution.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) {
    return null;
  }
  // The bars and the headline must describe the same rows, or the page renders
  // a distribution that visibly fails to add up to the count beside it.
  if (distribution.reduce((sum: number, n: number) => sum + n, 0) !== count) return null;

  return { average, count, best, worst, distribution: distribution as number[] };
}

/**
 * Whether an aggregate is solid enough to state publicly.
 *
 * Deliberately **not** a `rating is RatingAggregate` type predicate. `false`
 * here has two quite different causes — no aggregate at all, and a real
 * aggregate that has not reached the floor — so a predicate would tell the
 * compiler a falsy result means "not an aggregate", narrowing a genuine
 * below-floor reading to `never` in the caller's else branch.
 */
export function isPublishableRating(rating: RatingAggregate | null | undefined): boolean {
  return rating != null && rating.count >= MIN_RATINGS_TO_PUBLISH;
}
