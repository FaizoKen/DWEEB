/**
 * Mount point for the post-send rating card (`RatingCard.tsx` has the whole
 * story).
 *
 * The card itself loads only once a successful send has armed it: it used to
 * ride the boot path — code and styles — on every visit, for a prompt most
 * sessions never see and each person sees once. This shell is all that stays
 * there. Like every lazy surface it sits inside a `ChunkErrorBoundary`, so a
 * tab that outlived a deploy gets the usual "refresh to update" offer; "Not
 * now" closes the card softly, as if it had timed out.
 */

import { lazy, Suspense } from "react";
import { useRatingStore } from "@/core/rating/ratingStore";
import { ChunkErrorBoundary } from "@/ui/ChunkErrorBoundary";

const RatingCard = lazy(() => import("./RatingCard").then((m) => ({ default: m.RatingCard })));

export function RatingPrompt() {
  const showing = useRatingStore((s) => s.phase !== "idle");
  if (!showing) return null;
  return (
    <ChunkErrorBoundary onDismiss={() => useRatingStore.getState().dismiss(false)}>
      <Suspense fallback={null}>
        <RatingCard />
      </Suspense>
    </ChunkErrorBoundary>
  );
}
