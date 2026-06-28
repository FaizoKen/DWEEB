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
 */

import { useEffect } from "react";
import { ComponentTree } from "@/features/builder/components/ComponentTree";
import { Preview } from "@/features/preview/Preview";
import { ToastViewport } from "@/ui/Toast";
import { Button } from "@/ui/Button";
import {
  useActivityStore,
  type ActivityStatus,
  type ActivityStep,
} from "@/core/activity/activityStore";
import { ActivityBar } from "./ActivityBar";
import styles from "./ActivityApp.module.css";

export function ActivityApp() {
  const status = useActivityStore((s) => s.status);
  const step = useActivityStore((s) => s.step);
  const error = useActivityStore((s) => s.error);
  const init = useActivityStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (status !== "ready") {
    return <Splash status={status} step={step} error={error} />;
  }

  return (
    <div className={styles.app}>
      <div className={styles.panes}>
        <section className={styles.editor} aria-label="Component builder">
          <ActivityBar />
          <ComponentTree />
        </section>
        <section className={styles.preview} aria-label="Message preview">
          <Preview />
        </section>
      </div>
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
          <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </>
      ) : (
        <>
          <div className={styles.spinner} aria-hidden="true" />
          <p className={styles.splashMsg}>Connecting to Discord…</p>
          {/* Dev-only handshake progress, so a stalled local launch shows *where*
              it stalled (the in-Discord iframe has no reachable console). */}
          {import.meta.env.DEV ? <p className={styles.splashMsg}>step: {step}</p> : null}
        </>
      )}
    </div>
  );
}
