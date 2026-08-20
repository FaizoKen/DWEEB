/**
 * The rating aggregate is the one value in this repo that leaves as an HTTP
 * response and arrives as a factual claim in DWEEB's own structured data. These
 * tests pin the "fail closed" contract: anything the reader cannot fully verify
 * must resolve to no rating, because a page without stars costs nothing and a
 * rating snippet judged fabricated is a manual action against the whole domain.
 */

import { describe, expect, it } from "vitest";
import {
  isPublishableRating,
  MIN_RATINGS_TO_PUBLISH,
  parseRatingAggregate,
} from "./ratingAggregate";

const valid = {
  average: 4.6,
  count: 100,
  best: 5,
  worst: 1,
  distribution: [2, 3, 5, 15, 75],
};

describe("parseRatingAggregate", () => {
  it("accepts a well-formed payload unchanged", () => {
    expect(parseRatingAggregate(valid)).toEqual(valid);
  });

  it("accepts the empty state, which the publish floor filters rather than this", () => {
    const empty = { average: 0, count: 0, best: 5, worst: 1, distribution: [0, 0, 0, 0, 0] };
    // 0 is below `worst`, but with no ratings there is no mean to be out of
    // range — rejecting it here would conflate "nothing yet" with "corrupt".
    expect(parseRatingAggregate(empty)).toEqual(empty);
    expect(isPublishableRating(empty)).toBe(false);
  });

  it("rejects a payload whose bars do not add up to its count", () => {
    // This is the shape a partially-updated or hand-edited response takes, and
    // it would render a distribution visibly contradicting the number beside it.
    expect(parseRatingAggregate({ ...valid, distribution: [2, 3, 5, 15, 74] })).toBeNull();
  });

  it("rejects a mean outside its own scale", () => {
    expect(parseRatingAggregate({ ...valid, average: 6.2 })).toBeNull();
    expect(parseRatingAggregate({ ...valid, average: 0.4 })).toBeNull();
  });

  it("rejects a distribution that is not one bucket per scale point", () => {
    expect(parseRatingAggregate({ ...valid, distribution: [2, 3, 5, 90] })).toBeNull();
    expect(parseRatingAggregate({ ...valid, distribution: [] })).toBeNull();
  });

  it("rejects non-numeric, negative, and fractional counts", () => {
    expect(parseRatingAggregate({ ...valid, count: "100" })).toBeNull();
    expect(parseRatingAggregate({ ...valid, count: -1 })).toBeNull();
    expect(parseRatingAggregate({ ...valid, count: 4.5 })).toBeNull();
    expect(parseRatingAggregate({ ...valid, distribution: [2, 3, 5, 15, 75.5] })).toBeNull();
  });

  it("rejects a non-finite average rather than printing NaN on the page", () => {
    expect(parseRatingAggregate({ ...valid, average: Number.NaN })).toBeNull();
    expect(parseRatingAggregate({ ...valid, average: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("rejects an inverted or degenerate scale", () => {
    expect(parseRatingAggregate({ ...valid, best: 1, worst: 5 })).toBeNull();
    expect(parseRatingAggregate({ ...valid, best: 5, worst: 5 })).toBeNull();
  });

  it("rejects anything that is not an object", () => {
    for (const junk of [null, undefined, 4.6, "4.6", [], true]) {
      expect(parseRatingAggregate(junk)).toBeNull();
    }
  });

  it("ignores unknown fields rather than failing on a server that grew one", () => {
    const parsed = parseRatingAggregate({ ...valid, median: 5, somethingNew: true });
    expect(parsed).toEqual(valid);
  });
});

describe("isPublishableRating", () => {
  it("holds everything back below the floor", () => {
    expect(isPublishableRating({ ...valid, count: MIN_RATINGS_TO_PUBLISH - 1 })).toBe(false);
    expect(isPublishableRating({ ...valid, count: MIN_RATINGS_TO_PUBLISH })).toBe(true);
  });

  it("treats a missing aggregate as not publishable", () => {
    expect(isPublishableRating(null)).toBe(false);
    expect(isPublishableRating(undefined)).toBe(false);
  });

  it("keeps a floor high enough that one friend cannot move the headline", () => {
    // A change detector: lowering this below ~10 turns the published average
    // into noise stated as fact. Raising it is always safe.
    expect(MIN_RATINGS_TO_PUBLISH).toBeGreaterThanOrEqual(10);
  });
});
