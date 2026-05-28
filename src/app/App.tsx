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
import { AiChatPanel } from "@/features/ai/AiChatPanel";
import { useAiStore } from "@/core/ai/aiStore";
import { ToastViewport } from "@/ui/Toast";
import { EyeIcon, SparkleIcon } from "@/ui/Icon";
import { useShareUrlBootstrap } from "./useShareUrlBootstrap";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useAutoSaveDraft } from "./useAutoSaveDraft";
import { useAttachmentGc } from "./useAttachmentGc";

/**
 * Drives the mobile preview sheet's swipe-to-dismiss gesture.
 *
 * The sheet's resting open/close slide lives in CSS (driven by
 * `data-preview-open`). The whole sheet is swipeable so the user doesn't
 * have to hunt for the drag handle: the gesture engages either on the
 * handle (which has `touch-action: none`) or on the message area when the
 * scroll is already at the top. We re-check `scrollTop` on each move so
 * that if native scrolling has happened first, the swipe-to-dismiss never
 * steals the gesture — the user can scroll freely.
 *
 * Once engaged we disable the CSS transition inline and follow the finger
 * 1:1 with `translateY`; on release we restore the CSS timing and either
 * finish the slide down (a drag past the threshold dismisses) or snap back
 * to the open position.
 */
function usePreviewSwipeToClose(onClose: () => void) {
  const sheetRef = useRef<HTMLElement>(null);
  const startY = useRef(0);
  const deltaY = useRef(0);
  const active = useRef(false);
  // null = undecided, true = eligible to engage, false = abandon for this gesture.
  const eligible = useRef<boolean | null>(null);
  const inScrollArea = useRef(false);

  const onTouchStart = (e: ReactTouchEvent) => {
    const touch = e.touches[0];
    const el = sheetRef.current;
    if (!touch || !el) return;
    const scroll = el.querySelector<HTMLElement>("[data-preview-scroll]");
    inScrollArea.current = scroll ? scroll.contains(e.target as Node) : false;
    active.current = false;
    eligible.current = null;
    startY.current = touch.clientY;
    deltaY.current = 0;
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    const touch = e.touches[0];
    const el = sheetRef.current;
    if (!touch || !el) return;
    const dy = touch.clientY - startY.current;

    if (active.current) {
      const clamped = Math.max(0, dy);
      deltaY.current = clamped;
      el.style.transform = `translateY(${clamped}px)`;
      return;
    }
    if (eligible.current === false) return;

    // Treat any upward intent or sideways drag as "user is scrolling, not
    // dismissing" and abandon for the rest of the gesture so native scroll
    // owns it.
    if (dy < -2) {
      eligible.current = false;
      return;
    }
    // Wait for a clear downward intent before deciding.
    if (dy <= 10) return;

    // Re-check the scroll position now, not just at touchstart — if native
    // scroll has carried us off the top, we yield to it.
    const scroll = el.querySelector<HTMLElement>("[data-preview-scroll]");
    const atTop = !scroll || scroll.scrollTop <= 0;
    if (inScrollArea.current && !atTop) {
      eligible.current = false;
      return;
    }

    eligible.current = true;
    active.current = true;
    el.style.transition = "none";
    const clamped = Math.max(0, dy);
    deltaY.current = clamped;
    el.style.transform = `translateY(${clamped}px)`;
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
    swipeProps: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd },
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
    "send" | "share" | "restore" | "json" | "import" | "about"
  >("send");

  // `previewOpen` only matters on mobile, where the preview pane is a
  // bottom sheet. On desktop the CSS keeps both panes visible regardless.
  const [previewOpen, setPreviewOpen] = useState(false);

  // The AI assistant docks as a third column on desktop and a floating window
  // over the preview on mobile; `aiOpen` drives the app-shell grid switch.
  const aiOpen = useAiStore((s) => s.open);
  const openAi = useAiStore((s) => s.openPanel);
  const closeAi = useAiStore((s) => s.closePanel);

  // The mobile chat floats over the preview, so dismissing the preview also
  // dismisses the chat — leaving a stranded chat over the builder would be odd.
  const closePreview = () => {
    setPreviewOpen(false);
    if (aiOpen) closeAi();
  };

  const { sheetRef, swipeProps } = usePreviewSwipeToClose(closePreview);

  const openShareDialog = (tab: typeof shareInitialTab) => {
    setShareInitialTab(tab);
    setShareOpen(true);
  };

  // On mobile the AI chat floats over the preview, so opening the assistant
  // brings the (full-screen) preview up first — you watch the message build as
  // you chat. On desktop both panes are always visible, so this is harmless.
  const openAiWithPreview = () => {
    setPreviewOpen(true);
    openAi();
  };

  return (
    <div
      className="app-shell"
      data-preview-open={previewOpen ? "true" : "false"}
      data-ai-open={aiOpen ? "true" : "false"}
    >
      <h1 className="sr-only">
        Discord Webhook Builder — visually build, preview, and share Discord webhook messages with
        Components V2
      </h1>
      <section className="app-shell__pane app-shell__pane--builder" aria-label="Component builder">
        <Builder
          onShare={() => openShareDialog("share")}
          onExport={() => openShareDialog("json")}
          onImport={() => openShareDialog("import")}
          onSend={() => openShareDialog("send")}
          onRestore={() => openShareDialog("restore")}
          onAbout={() => openShareDialog("about")}
        />
      </section>
      <section
        ref={sheetRef}
        className="app-shell__pane app-shell__pane--preview"
        aria-label="Message preview"
        aria-hidden={previewOpen ? undefined : "true"}
      >
        <Preview onClose={closePreview} swipeProps={swipeProps} />
      </section>

      <AiChatPanel />

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

        <button
          type="button"
          className="ai-fab"
          onClick={openAiWithPreview}
          aria-label="Open the AI assistant"
        >
          <SparkleIcon size={20} />
          <span>AI Assistant</span>
        </button>
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
