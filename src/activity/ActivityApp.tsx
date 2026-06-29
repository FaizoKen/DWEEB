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

import { useEffect, useState } from "react";
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
import { ActivityBar } from "./ActivityBar";
import { SelfPresence } from "./SelfPresence";
import styles from "./ActivityApp.module.css";

export function ActivityApp() {
  const status = useActivityStore((s) => s.status);
  const step = useActivityStore((s) => s.step);
  const error = useActivityStore((s) => s.error);
  const platform = useActivityStore((s) => s.platform);
  const init = useActivityStore((s) => s.init);

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

  return (
    <div
      className={styles.app}
      data-platform={platform ?? undefined}
      data-preview-open={previewOpen ? "true" : "false"}
    >
      <div className={styles.panes}>
        <section className={styles.editor} aria-label="Component builder">
          <ActivityBar />
          <ComponentTree />
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
          {!isMobileSheet || previewMounted ? (
            <Preview onClose={closePreview} swipeProps={swipeProps} />
          ) : null}
        </section>
      </div>

      {/* Bottom-right "this is you" badge (your avatar + live sync status). On
          desktop it floats free in the corner; on mobile that corner holds the
          mini preview, so it stacks into the same floating column just above it.
          Hidden while the mobile preview sheet is open (it would cover it). */}
      {isMobileSheet ? (
        !previewOpen ? (
          <div className="fab-stack">
            <SelfPresence />
            <MiniPreview onOpen={() => setPreviewOpen(true)} />
          </div>
        ) : null
      ) : (
        <div className={styles.selfFloat}>
          <SelfPresence />
        </div>
      )}

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
  return (
    <div className={styles.splash}>
      <div className={styles.wordmark}>DWEEB</div>
      {status === "error" ? (
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
          <div className={styles.spinner} aria-hidden="true" />
          {/* Surface the live handshake stage in *every* build, not just dev: a
              real in-Discord launch has no reachable console, so this on-screen
              label is the only way to see where a stalled launch got stuck. Each
              stage is also timeout-bounded (see activityStore), so a hang resolves
              to a labelled error rather than spinning here forever. */}
          <p className={styles.splashMsg}>{capitalize(STEP_LABELS[step])}…</p>
          {import.meta.env.DEV ? <p className={styles.splashStep}>step: {step}</p> : null}
        </>
      )}
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
