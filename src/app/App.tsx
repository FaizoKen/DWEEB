/**
 * App shell.
 *
 * Lays out the toolbar + builder/preview split and hosts cross-cutting
 * features (share dialog, toast viewport, keyboard shortcuts, share-URL
 * bootstrap).
 *
 * Everything below this component is decoupled from app state through the
 * Zustand store, so adding e.g. a settings drawer is a matter of adding a
 * new dialog and a button — no plumbing required.
 */

import { useState } from "react";
import { Toolbar } from "@/features/toolbar/Toolbar";
import { Builder } from "@/features/builder/Builder";
import { Preview } from "@/features/preview/Preview";
import { ShareDialog } from "@/features/share/ShareDialog";
import { ToastViewport } from "@/ui/Toast";
import { useShareUrlBootstrap } from "./useShareUrlBootstrap";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

export function App() {
  useShareUrlBootstrap();
  useKeyboardShortcuts();

  const [shareOpen, setShareOpen] = useState(false);

  return (
    <div className="app-shell">
      <Toolbar onShare={() => setShareOpen(true)} />
      <main className="app-shell__workspace">
        <section
          className="app-shell__pane app-shell__pane--builder"
          aria-label="Component builder"
        >
          <Builder />
        </section>
        <section className="app-shell__pane app-shell__pane--preview" aria-label="Message preview">
          <Preview />
        </section>
      </main>
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} />
      <ToastViewport />
    </div>
  );
}
