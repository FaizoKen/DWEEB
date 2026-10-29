/**
 * The tree's inline editors, loaded on demand.
 *
 * Every field editor — the component inspectors, the plugin panel, the
 * markdown toolbar with its mention/emoji/timestamp pickers, the attachment
 * and default-value editors — is only ever on screen under a *selected* row,
 * and nothing is selected at boot. Statically imported, they were the largest
 * single block of the critical bundle, parsed on every visit before the editor
 * could paint. They now ride one lazy chunk (`./inspectorPanels`), warmed in
 * idle time once the tree has mounted, so the first click almost always finds
 * it loaded and boot no longer pays for it.
 *
 * Like every lazy surface, each panel sits inside a `ChunkErrorBoundary`: a
 * tab that outlived a deploy before the warm-up ran gets the lossless "refresh
 * to update" dialog rather than the top-level crash screen. Its "Not now"
 * deselects the row, which unmounts the failed panel.
 */

import { Suspense, lazy, useEffect } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import type { EditorId, MediaGalleryItem } from "@/core/schema/types";
import { reportBackgroundFailure } from "@/core/telemetry/reporter";
import { ChunkErrorBoundary } from "@/ui/ChunkErrorBoundary";

const loadPanels = () => import("./inspectorPanels");

const Inspector = lazy(() => loadPanels().then((m) => ({ default: m.Inspector })));
const GalleryItemInspector = lazy(() =>
  loadPanels().then((m) => ({ default: m.GalleryItemInspector })),
);

let warmed = false;

/**
 * Fetch the editors' chunk ahead of the first click. Fire-and-forget, so its
 * rejection is reported as background work (a stale chunk stays non-paging);
 * the panel's own `lazy()` load retries when a row is actually opened.
 */
export function warmInspector(): void {
  if (warmed) return;
  warmed = true;
  loadPanels().catch(reportBackgroundFailure);
}

/** Warm the editors' chunk in idle time after the tree first mounts. */
export function useWarmInspector(): void {
  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warmInspector, { timeout: 4_000 });
      return () => window.cancelIdleCallback(handle);
    }
    const t = window.setTimeout(warmInspector, 1_500);
    return () => window.clearTimeout(t);
  }, []);
}

function useDeselect(): () => void {
  const select = useMessageStore((s) => s.select);
  return () => select(null);
}

export function LazyInspector() {
  const deselect = useDeselect();
  return (
    <ChunkErrorBoundary onDismiss={deselect}>
      <Suspense fallback={null}>
        <Inspector />
      </Suspense>
    </ChunkErrorBoundary>
  );
}

export function LazyGalleryItemInspector(props: { galleryId: EditorId; item: MediaGalleryItem }) {
  const deselect = useDeselect();
  return (
    <ChunkErrorBoundary onDismiss={deselect}>
      <Suspense fallback={null}>
        <GalleryItemInspector {...props} />
      </Suspense>
    </ChunkErrorBoundary>
  );
}
