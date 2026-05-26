/**
 * App shell.
 *
 * Two full-height panes side by side — the editor (left) carries every
 * control, and the preview (right) is left uncluttered so the Discord-style
 * render dominates. There is no separate top toolbar; global actions live
 * inside the Builder's action bar.
 *
 * On narrow viewports the preview pane is hidden and slides over from the
 * right when the user taps the floating "Preview" button. This keeps the
 * editor full-width on mobile while preserving one-tap access to the render.
 *
 * First-visit flow:
 *  1. `bootstrap()` in the store seeds either a saved draft or the showcase
 *     preset.
 *  2. If the URL carries `#s=…`, `useShareUrlBootstrap` replaces it shortly.
 *  3. From then on, every message change is persisted to `localStorage` via
 *     `useAutoSaveDraft` so a refresh restores the in-progress message.
 */

import { useState } from "react";
import { Builder } from "@/features/builder/Builder";
import { Preview } from "@/features/preview/Preview";
import { ShareDialog } from "@/features/share/ShareDialog";
import { ToastViewport } from "@/ui/Toast";
import { EyeIcon, SupportIcon } from "@/ui/Icon";
import { useShareUrlBootstrap } from "./useShareUrlBootstrap";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useAutoSaveDraft } from "./useAutoSaveDraft";
import { useAttachmentGc } from "./useAttachmentGc";

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
  // slide-over. On desktop the CSS keeps both panes visible regardless.
  const [previewOpen, setPreviewOpen] = useState(false);

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
        className="app-shell__pane app-shell__pane--preview"
        aria-label="Message preview"
        aria-hidden={previewOpen ? undefined : "true"}
      >
        <Preview onClose={() => setPreviewOpen(false)} />
      </section>

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

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        initialTab={shareInitialTab}
      />
      <ToastViewport />
    </div>
  );
}
