/**
 * Build-time read of the first-party rating aggregate, for the visible ratings
 * block and the `aggregateRating` on the head-term landing page.
 *
 * Validation lives in `@/core/seo/ratingAggregate` so the test suite (which
 * only covers `src/**`) can cover the part that turns an HTTP response into a
 * published claim. What is left here is the fetching: network, env, timeout.
 *
 * ## Why the number is baked in rather than fetched by the page
 *
 * The generated pages ship no first-party JavaScript, and a rating injected
 * client-side is one Google may never see. More importantly, `aggregateRating`
 * may only describe a rating **a reader can see on the same page** — so the
 * markup and the visible block must come from one value, resolved once, here.
 * Every deploy refreshes it; between deploys the page states a figure that was
 * true when it was built, which is what a printed number can honestly promise.
 *
 * ## The build must never depend on this succeeding
 *
 * `web.yml` builds on GitHub's runners, and this repo has already been bitten
 * by workflows that fail on a network call (`api.github.com` flaking broke
 * `setup-bun` and every image workflow). So a proxy that is slow, down, or not
 * running this feature yet resolves to `null`, the ratings block and its schema
 * are **both** omitted, and the build succeeds. A missing rating is a page
 * without stars; a build that fails on it is a site that cannot deploy.
 *
 * Failing closed also covers the case that matters most: never publish a rating
 * we could not verify on this run.
 */

import {
  isPublishableRating,
  MIN_RATINGS_TO_PUBLISH,
  parseRatingAggregate,
  type RatingAggregate,
} from "@/core/seo/ratingAggregate";

export { isPublishableRating as isPublishable, MIN_RATINGS_TO_PUBLISH, type RatingAggregate };

/**
 * Where the aggregate is read from. Overridable so a self-hosted or staging
 * build points at its own proxy instead of production's.
 */
const DEFAULT_ORIGIN = "https://api.dweeb.faizo.net";

/**
 * Hard ceiling on the whole fetch. Short on purpose: the build has nothing to
 * gain by waiting, since the fallback is simply "no stars this deploy".
 */
const TIMEOUT_MS = 5_000;

/**
 * Fetch the aggregate, or `null` for any reason at all.
 *
 * `RATINGS_API_ORIGIN` overrides the proxy; `SKIP_RATINGS=1` forces the
 * no-stars path, which is how a local `bun run build` avoids reaching the
 * public API on every run.
 */
export async function loadRatings(): Promise<RatingAggregate | null> {
  if (process.env.SKIP_RATINGS === "1") return null;
  const origin = process.env.RATINGS_API_ORIGIN?.trim() || DEFAULT_ORIGIN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/rating`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    // 501 is the documented answer while the feature is off — an expected
    // state, not something worth a warning on every build.
    if (!res.ok) return null;
    const parsed = parseRatingAggregate(await res.json());
    if (!parsed) {
      console.warn("[seo] rating aggregate failed validation — publishing without stars");
      return null;
    }
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
