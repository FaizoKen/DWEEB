/**
 * Deploy-skew guard for lazily loaded surfaces.
 *
 * Every deploy purges the previous build's hashed chunks, so a tab that has
 * outlived a deploy — and isn't service-worker-controlled (a first-visit
 * session, private browsing, evicted storage) — 404s the first time it opens a
 * lazy surface (Template gallery, Share dialog, …). Left alone, that rejection
 * climbs to the top-level `ErrorBoundary` and takes the whole editor down with
 * "Something broke." over a message the user never lost — this shipped as a
 * paging `web_crash` on 0.12.0.
 *
 * This boundary sits around each lazy surface's `<Suspense>` and turns exactly
 * that failure into a calm "refresh to update" dialog while the rest of the app
 * keeps running: refresh reloads onto the new build (the draft autosave's
 * pagehide flush plus the preserved URL hash keep the user's message), and
 * "Not now" dismisses via `onDismiss`, which must fully close/unmount the
 * surface (its store flag *and* any `*Mounted` latch) — a still-mounted lazy
 * child would just rethrow the cached rejection into a fresh boundary.
 *
 * Anything that is not a stale-chunk failure is rethrown to the top-level
 * boundary untouched: this is deliberately not a general error boundary, so a
 * real bug in a dialog still surfaces (and reports) exactly as before.
 *
 * Never auto-reload from here: past boot, an automatic reload could destroy
 * in-progress state mid-interaction (the same rule staleChunkRecovery follows).
 */

import { Component, type ReactNode } from "react";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { describeError, isStaleChunkMessage } from "@/core/telemetry/crashReport";
import { reportHandledStaleChunk } from "@/core/telemetry/reporter";
import { isStaleChunkReloadInProgress } from "@/core/pwa/staleChunkRecovery";

/** Whether a thrown value is a failed lazy-chunk load (any engine's wording). */
export function isStaleChunkError(error: unknown): boolean {
  return isStaleChunkMessage(describeError(error).message);
}

interface Props {
  /** Close the wrapped surface completely — reset its open flag in the owning
   *  store/state *and* clear any keep-mounted latch, so the failed lazy child
   *  actually leaves the tree (and this boundary unmounts with it). */
  onDismiss: () => void;
  children: ReactNode;
}

interface State {
  caught: boolean;
  error: unknown;
}

export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { caught: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { caught: true, error };
  }

  componentDidCatch(error: unknown): void {
    // Only the handled deploy-skew shape is ours to report (below paging
    // level); anything else rethrows in render() and reports from the
    // top-level boundary — reporting here too would double-count it. A
    // boot-recovery reload already in flight is about to fix this on its own.
    if (isStaleChunkError(error) && !isStaleChunkReloadInProgress()) {
      reportHandledStaleChunk(error);
    }
  }

  private refresh = () => {
    // Draft + undo history flush on pagehide (useAutoSaveDraft), and the URL —
    // including a share `#hash` — is preserved, so nothing is lost.
    window.location.reload();
  };

  render() {
    if (!this.state.caught) return this.props.children;
    if (!isStaleChunkError(this.state.error)) {
      // Not deploy skew — let the top-level ErrorBoundary handle and report it.
      throw this.state.error;
    }
    // The boot-path recovery is already reloading onto the fresh build; don't
    // flash a prompt the navigation is about to obsolete.
    if (isStaleChunkReloadInProgress()) return null;
    return (
      <Modal
        open
        onClose={this.props.onDismiss}
        title="Update available"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={this.props.onDismiss}>
              Not now
            </Button>
            <Button variant="primary" onClick={this.refresh}>
              Refresh now
            </Button>
          </>
        }
      >
        <p>
          DWEEB has been updated since this tab loaded, so this part of the app couldn’t open.
          Refresh to pick up the new version — your draft is saved on this device and will be right
          where you left it.
        </p>
      </Modal>
    );
  }
}
