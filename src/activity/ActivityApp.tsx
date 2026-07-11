/**
 * Activity shell.
 *
 * Reuses the web app's heavy lifting — the `ComponentTree` editor and the
 * pixel-accurate `Preview` — and runs the SDK handshake on mount. Until the
 * handshake resolves (or if it fails) it shows a splash; once ready, the two
 * panes are the same builder the web app renders, now scoped to the launching
 * server/channel and synced to everyone in the room.
 *
 * The Activity-specific bar sits as a header on the editor pane only — matching
 * the web app, where the action bar tops the builder column and the preview is
 * left uncluttered — rather than spanning the full width across both panes.
 *
 * Layout mirrors the web app at every width (see `app/App`): two side-by-side
 * panes on desktop, and on a narrow window (mobile, or a small picture-in-
 * picture) the editor goes full-width while the preview becomes a bottom sheet
 * raised by tapping the floating live mini preview. On the mobile client we also
 * inset the whole surface for Discord's native top bar / home indicator.
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { ComponentTree } from "@/features/builder/components/ComponentTree";
import { Preview } from "@/features/preview/Preview";
import { MiniPreview } from "@/features/preview/MiniPreview";
import { usePreviewSwipeToClose, useIsMobileSheet } from "@/features/preview/previewSheet";
import { ToastViewport } from "@/ui/Toast";
import { Button } from "@/ui/Button";
import {
  useActivityStore,
  type ActivityStatus,
  type ActivityStep,
} from "@/core/activity/activityStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import { ActivityBar } from "./ActivityBar";
import { TreeSkeleton, PreviewSkeleton } from "./Skeletons";
import { PresenceDock } from "./PresenceDock";
import styles from "./ActivityApp.module.css";

/** Hard ceiling on the per-region loading hold: if the room draft and/or guild
 *  data are still settling after this, drop the skeletons and show the live
 *  content anyway — the last few names just resolve in place. A clean placeholder
 *  for a beat beats an indefinite one. */
const MAX_HYDRATE_MS = 4000;

// Lazy — the feedback form (and its transport) only loads when someone opens it,
// so it never weighs on the Activity's first paint. Mirrors the web `App`.
const FeedbackDialog = lazy(() =>
  import("@/features/feedback/FeedbackDialog").then((m) => ({ default: m.FeedbackDialog })),
);

export function ActivityApp() {
  const status = useActivityStore((s) => s.status);
  const step = useActivityStore((s) => s.step);
  const error = useActivityStore((s) => s.error);
  const pipMode = useActivityStore((s) => s.pipMode);
  const init = useActivityStore((s) => s.init);

  // ── Per-region loading (app-shell pattern) ───────────────────────────────
  // The handshake going `ready` only means we're signed in; the shell (bar +
  // panes) renders for real right away so the app *looks* loaded. But two regions
  // are still fetching, and showing them live would flash the wrong thing: the
  // component list would render the fresh-open default before the collab room's
  // draft syncs in, and the preview would render with raw, unresolved mentions
  // before the guild's channels/roles/emoji arrive. So *only those two regions*
  // wear a skeleton until their own data is ready — everything else is instant.
  const hydrated = useActivityStore((s) => s.hydrated);
  const targetGuildId = useActivityStore((s) => s.targetGuildId);
  const botMissing = useActivityStore((s) => s.botMissing);
  const isDm = useActivityStore((s) => s.context != null && s.context.guildId == null);
  const guildStatus = useGuildStore((s) => s.status);
  const guildDataId = useGuildStore((s) => s.data?.guildId ?? null);

  // Guild data is "settled" when there's nothing to wait for (a DM launch hasn't
  // picked a server yet; a bot-less server won't bootstrap; dev builds have no
  // proxy) or the target guild's bootstrap has finished — ready with matching
  // data, or errored (we still show; the toast already explained it).
  const guildSettled =
    !import.meta.env.PROD || isDm || botMissing || !targetGuildId
      ? true
      : (guildStatus === "ready" && guildDataId === targetGuildId) || guildStatus === "error";

  // A hard-ceiling escape hatch, so a slow/stuck fetch can never leave a region
  // skeletoned forever — after this it shows live regardless.
  const [capReached, setCapReached] = useState(false);
  useEffect(() => {
    if (capReached || status !== "ready") return;
    const t = window.setTimeout(() => setCapReached(true), MAX_HYDRATE_MS);
    return () => window.clearTimeout(t);
  }, [capReached, status]);

  // The component list needs only the synced draft. `hydrated` is a one-way latch
  // (collab's first draft, or a short grace for a fresh room), so this is
  // monotonic — no flip-back once the tree is live.
  const treeReady = hydrated || capReached;
  // The preview additionally needs guild resolve-data. `guildSettled` can bounce
  // (a background guild refresh flips status to "loading"), so latch this once
  // true to keep a routine refresh from re-skeletoning a live preview.
  const [previewReady, setPreviewReady] = useState(false);
  useEffect(() => {
    if (previewReady) return;
    if ((hydrated && guildSettled) || capReached) setPreviewReady(true);
  }, [previewReady, hydrated, guildSettled, capReached]);

  // Feedback form open state — mounted lazily below only while open (like the web
  // app), summoned from the bar's "Send feedback" action.
  const feedbackOpen = useFeedbackStore((s) => s.open);

  // The preview is a side column on desktop and a bottom sheet on mobile; this
  // only matters in the sheet layout, where the CSS keeps it slid away until
  // opened. Mounting mirrors the web app: keep the (off-screen) sheet preview
  // out of the tree while closed so we don't double the per-keystroke render —
  // a second live <Preview> already runs inside the mini preview — lingering
  // briefly past close so it animates out with its content intact.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewMounted, setPreviewMounted] = useState(false);
  useEffect(() => {
    if (previewOpen) {
      setPreviewMounted(true);
      return;
    }
    const t = window.setTimeout(() => setPreviewMounted(false), 300);
    return () => window.clearTimeout(t);
  }, [previewOpen]);

  const isMobileSheet = useIsMobileSheet();
  const closePreview = () => setPreviewOpen(false);
  const { sheetRef, swipeProps } = usePreviewSwipeToClose(closePreview);

  useEffect(() => {
    void init();
  }, [init]);

  if (status !== "ready") {
    return <Splash status={status} step={step} error={error} />;
  }

  // Minimised into Discord's picture-in-picture window: drop the editor and all
  // chrome and show just the message preview, full-bleed, so the small floating
  // window is a clean live view of the message being built (it keeps updating as
  // the room edits). Restoring the Activity flips `layout_mode` back and the full
  // builder returns. The mobile-sheet hooks above still ran (rules of hooks), but
  // their state is inert here — this branch renders neither the sheet nor its FAB.
  if (pipMode) {
    return (
      <div className={styles.app} data-pip="true">
        <div className={styles.pipPreview}>{previewReady ? <Preview /> : <PreviewSkeleton />}</div>
        <ToastViewport />
      </div>
    );
  }

  return (
    <div className={styles.app} data-preview-open={previewOpen ? "true" : "false"}>
      <div className={styles.panes}>
        <section className={styles.editor} aria-label="Component builder">
          {/* The bar is real immediately — only the component list below waits on
              the synced draft, so it holds a skeleton until the room's message
              arrives instead of flashing the fresh-open default. */}
          <ActivityBar />
          {treeReady ? <ComponentTree /> : <TreeSkeleton />}
        </section>
        {/* Dismiss scrim for the mobile preview sheet — catches taps on the
            builder peeking above the sheet so they close it. Inert on desktop,
            where the preview is a permanent side column. */}
        <div className={styles.scrim} aria-hidden="true" onClick={closePreview} />
        <section
          ref={sheetRef}
          className={styles.preview}
          aria-label="Message preview"
          aria-hidden={isMobileSheet && !previewOpen ? "true" : undefined}
        >
          {/* The preview waits on the draft *and* the guild's mention/emoji data,
              so it holds a skeleton until both are ready rather than rendering
              raw, unresolved mentions. */}
          {!isMobileSheet || previewMounted ? (
            previewReady ? (
              <Preview onClose={closePreview} swipeProps={swipeProps} />
            ) : (
              <PreviewSkeleton />
            )
          ) : null}
          {/* Presence dock floated in the preview pane's bottom-right corner
              (like the web app's AI FAB), so it sits at the bottom under the
              message without a heavy full-width bar. Desktop only: on mobile the
              preview is a bottom sheet, so the dock floats over the viewport
              corner instead (below). */}
          {!isMobileSheet ? (
            <div className={styles.presenceFab}>
              <PresenceDock />
            </div>
          ) : null}
        </section>
      </div>

      {/* Mobile: the preview is a bottom sheet, so the presence dock can't live
          under it — float it in the bottom-right corner, directly *under* the
          live mini preview (the mini preview stands in for the message here).
          Hidden while the sheet is open (it would cover it). The mini is the
          only preview visible on mobile, so gate it on the same draft the tree
          waits for — it pops in with real content, not the fresh-open default. */}
      {isMobileSheet && !previewOpen ? (
        <div className="fab-stack">
          {treeReady ? <MiniPreview onOpen={() => setPreviewOpen(true)} /> : null}
          <PresenceDock />
        </div>
      ) : null}

      {feedbackOpen ? (
        <Suspense fallback={null}>
          <FeedbackDialog />
        </Suspense>
      ) : null}

      <ToastViewport />
    </div>
  );
}

function Splash({
  status,
  step,
  error,
}: {
  status: ActivityStatus;
  step: ActivityStep;
  error: string | null;
}) {
  const isError = status === "error";
  return (
    <div className={styles.splash} data-state={isError ? "error" : "loading"}>
      {/* Soft brand-tinted aurora behind the lockup — slowly breathes while we
          wait so the screen feels alive, not frozen. Inert/red on error. */}
      <div className={styles.aura} aria-hidden="true" />

      <div className={styles.splashInner}>
        {/* The mark: the app icon while connecting, or a danger badge on error.
            Purely decorative — the text below carries the actual status for
            screen readers. */}
        {isError ? (
          <div className={styles.markError} aria-hidden="true">
            !
          </div>
        ) : (
          <img
            className={styles.markLogo}
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            aria-hidden="true"
          />
        )}

        <div className={styles.wordmark}>DWEEB</div>

        {isError ? (
          <>
            <p className={styles.splashMsg}>{error ?? "Something went wrong starting DWEEB."}</p>
            {/* Name the stage we stalled on, for errors whose message doesn't (a
                non-timeout SDK failure). Hidden once the handshake had finished. */}
            {step !== "done" ? (
              <p className={styles.splashStep}>Stalled while {STEP_LABELS[step]}.</p>
            ) : null}
            <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </>
        ) : (
          <>
            {/* Surface the live handshake stage in *every* build, not just dev: a
                real in-Discord launch has no reachable console, so this on-screen
                label is the only way to see where a stalled launch got stuck. Each
                stage is also timeout-bounded (see activityStore), so a hang resolves
                to a labelled error rather than spinning here forever. The `key`
                re-triggers the fade as each stage swaps in. */}
            <p key={step} className={styles.splashMsg}>
              {capitalize(STEP_LABELS[step])}…
            </p>
            {/* Determinate progress across the handshake stages: a stalled launch
                visibly parks at a stage instead of an endless indeterminate spin,
                and a healthy one shows real forward motion. Width animates between
                stages via CSS. */}
            <div
              className={styles.progress}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={STEP_PROGRESS[step]}
              aria-label="Starting DWEEB"
            >
              <div className={styles.progressFill} style={{ width: `${STEP_PROGRESS[step]}%` }} />
            </div>
            {import.meta.env.DEV ? <p className={styles.splashStep}>step: {step}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Friendly, lower-cased label for each handshake stage, shown on the splash in
 *  every build (a real in-Discord launch has no console) so progress is visible
 *  and a stall names its stage. Phrased to read after "Stalled while …" too;
 *  `capitalize` fixes the leading letter where it heads a line. A total record so
 *  every `ActivityStep` is covered. */
const STEP_LABELS: Record<ActivityStep, string> = {
  starting: "starting up",
  "sdk-ready": "connecting to Discord",
  authorizing: "authorizing",
  "exchanging-token": "signing in",
  authenticating: "finishing sign-in",
  done: "ready",
};

/** Rough completion percentage per handshake stage, driving the splash progress
 *  bar. Not measured timings — just a monotonic sense of "how far in" so the wait
 *  reads as forward motion and a stall parks at a visible point. The early stages
 *  are spaced generously since `starting`/`sdk-ready` resolve fast; the back half
 *  (token exchange + authenticate) is where a slow launch actually lingers. */
const STEP_PROGRESS: Record<ActivityStep, number> = {
  starting: 12,
  "sdk-ready": 34,
  authorizing: 54,
  "exchanging-token": 74,
  authenticating: 92,
  done: 100,
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
