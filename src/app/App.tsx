/**
 * App shell.
 *
 * Two full-height panes side by side — the editor (left) carries every
 * control, and the preview (right) is left uncluttered so the Discord-style
 * render dominates. There is no separate top toolbar; global actions live
 * inside the Builder's action bar.
 *
 * On narrow viewports the preview pane is hidden and slides up from the
 * bottom as a sheet when the user taps the floating "Preview" button. The
 * sheet can be dismissed by swiping it down via its top drag handle. This
 * keeps the editor full-width on mobile while preserving one-tap access to
 * the render.
 *
 * First-visit flow:
 *  1. `bootstrap()` in the store seeds either a saved draft or the showcase
 *     preset.
 *  2. If the URL carries `#s=…`, `useShareUrlBootstrap` replaces it shortly.
 *  3. From then on, every message change is persisted to `localStorage` via
 *     `useAutoSaveDraft` so a refresh restores the in-progress message.
 */

import { useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import { Builder } from "@/features/builder/Builder";
import { Preview } from "@/features/preview/Preview";
import { ShareDialog } from "@/features/share/ShareDialog";
import { ToastViewport } from "@/ui/Toast";
import { EyeIcon, SupportIcon } from "@/ui/Icon";
import { useShareUrlBootstrap } from "./useShareUrlBootstrap";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useAutoSaveDraft } from "./useAutoSaveDraft";
import { useAttachmentGc } from "./useAttachmentGc";

/**
 * Drives the mobile preview sheet's swipe-to-dismiss gesture.
 *
 * The sheet's resting open/close slide lives in CSS (driven by
 * `data-preview-open`). During a drag we disable that transition inline and
 * follow the finger 1:1 with `translateY`; on release we restore the CSS
 * timing and either animate the rest of the way down (a drag past the
 * threshold dismisses) or snap back to the open position. Handlers are
 * attached to the sheet's drag handle only, so they never fight the preview's
 * own scroll.
 */
function usePreviewSwipeToClose(onClose: () => void) {
  const sheetRef = useRef<HTMLElement>(null);
  const startY = useRef(0);
  const deltaY = useRef(0);
  const active = useRef(false);

  const onTouchStart = (e: ReactTouchEvent) => {
    const touch = e.touches[0];
    const el = sheetRef.current;
    if (!touch || !el) return;
    active.current = true;
    startY.current = touch.clientY;
    deltaY.current = 0;
    el.style.transition = "none";
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    const touch = e.touches[0];
    if (!active.current || !touch) return;
    const dy = Math.max(0, touch.clientY - startY.current);
    deltaY.current = dy;
    const el = sheetRef.current;
    if (el) el.style.transform = `translateY(${dy}px)`;
  };

  const onTouchEnd = () => {
    const el = sheetRef.current;
    if (!active.current || !el) return;
    active.current = false;
    const height = el.offsetHeight || window.innerHeight;
    const shouldClose = deltaY.current > Math.min(160, height * 0.3);
    el.style.transition = "";
    if (shouldClose) {
      // Finish the slide down, then hand the transform back to CSS.
      el.style.transform = "translateY(100%)";
      const cleanup = () => {
        el.style.transform = "";
        el.removeEventListener("transitionend", cleanup);
      };
      el.addEventListener("transitionend", cleanup);
      onClose();
    } else {
      el.style.transform = "";
    }
  };

  return {
    sheetRef,
    dragHandleProps: { onTouchStart, onTouchMove, onTouchEnd },
  };
}

export function App() {
  useShareUrlBootstrap();
  useKeyboardShortcuts();
  useAutoSaveDraft();
  useAttachmentGc();

  // The Share dialog is shared by every editor CTA; `shareInitialTab` picks
  // which panel each entry point lands on so each button feels dedicated even
  // though they reuse the same dialog.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareInitialTab, setShareInitialTab] = useState<
    "send" | "share" | "restore" | "json" | "import"
  >("send");

  // `previewOpen` only matters on mobile, where the preview pane is a
  // bottom sheet. On desktop the CSS keeps both panes visible regardless.
  const [previewOpen, setPreviewOpen] = useState(false);
  const { sheetRef, dragHandleProps } = usePreviewSwipeToClose(() => setPreviewOpen(false));

  const openShareDialog = (tab: typeof shareInitialTab) => {
    setShareInitialTab(tab);
    setShareOpen(true);
  };

  return (
    <div className="app-shell" data-preview-open={previewOpen ? "true" : "false"}>
      <h1 className="sr-only">
        Discord Webhook Builder — visually build, preview, and share Discord webhook messages with
        Components V2
      </h1>
      <section
        className="app-shell__pane app-shell__pane--builder"
        aria-label="Component builder"
      >
        <Builder
          onShare={() => openShareDialog("share")}
          onExport={() => openShareDialog("json")}
          onImport={() => openShareDialog("import")}
          onSend={() => openShareDialog("send")}
          onRestore={() => openShareDialog("restore")}
        />
      </section>
      <section
        ref={sheetRef}
        className="app-shell__pane app-shell__pane--preview"
        aria-label="Message preview"
        aria-hidden={previewOpen ? undefined : "true"}
      >
        <Preview onClose={() => setPreviewOpen(false)} dragHandleProps={dragHandleProps} />
      </section>

      <div className="fab-stack">
        <button
          type="button"
          className="preview-fab"
          onClick={() => setPreviewOpen(true)}
          aria-label="Show preview"
        >
          <EyeIcon size={18} />
          <span>Preview</span>
        </button>

        <a
          className="support-fab"
          href="https://discord.gg/2wB7rHRDg2"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Join our Discord support server"
        >
          <SupportIcon size={20} />
          <span>Support</span>
        </a>
      </div>

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        initialTab={shareInitialTab}
      />
      <ToastViewport />
    </div>
  );
}
