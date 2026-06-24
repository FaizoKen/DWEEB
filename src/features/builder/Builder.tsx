/**
 * Builder pane — owns every editor control.
 *
 * Layout (top to bottom):
 *   1. ActionBar     — undo/redo + reset/restore/share/send (the former toolbar)
 *   2. ComponentTree — webhook meta + tree; the selected row reveals its value
 *                      editor inline (no separate docked panel).
 *
 * Selecting in the tree or the preview updates the same store slice, so the
 * two stay in sync without prop drilling.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import {
  ChevronDownIcon,
  DownloadIcon,
  HistoryIcon,
  InfoIcon,
  PencilIcon,
  RedoIcon,
  SendIcon,
  ShareIcon,
  SupportIcon,
  UndoIcon,
  UploadIcon,
} from "@/ui/Icon";
import { Menu, MenuItem } from "@/ui/Menu";
import { ComponentTree } from "./components/ComponentTree";
import { PostedMessageBanner } from "./PostedMessageBanner";
import { SavedMessagesMenu } from "./components/SavedMessagesMenu";
import { AccountMenu } from "@/features/guild/AccountMenu";
import { isProxyConfigured } from "@/core/guild/config";
import { isFeedbackConfigured } from "@/core/feedback/submit";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import styles from "./Builder.module.css";

interface BuilderProps {
  /** Opens the Share / Export dialog on the Share-link tab. */
  onShare: () => void;
  /** Opens the Share / Export dialog on the JSON export tab. */
  onExport: () => void;
  /** Opens the Share / Export dialog on the Import tab. */
  onImport: () => void;
  /** Opens the Share / Export dialog focused on the Send panel. */
  onSend: () => void;
  /** Opens the Share / Export dialog focused on the Restore panel. */
  onRestore: () => void;
  /** Opens the Share / Export dialog focused on the About panel. */
  onAbout: () => void;
}

export function Builder({ onShare, onExport, onImport, onSend, onRestore, onAbout }: BuilderProps) {
  return (
    <div className={styles.builder}>
      {/* ActionBar + banner share the grid's first (auto) row so the tree below
          keeps the 1fr row whether or not the banner is showing. */}
      <div className={styles.header}>
        <ActionBar
          onShare={onShare}
          onExport={onExport}
          onImport={onImport}
          onSend={onSend}
          onRestore={onRestore}
          onAbout={onAbout}
        />
        <PostedMessageBanner />
      </div>

      <ComponentTree />
    </div>
  );
}

function ActionBar({ onShare, onExport, onImport, onSend, onRestore, onAbout }: BuilderProps) {
  const undo = useMessageStore((s) => s.undo);
  const redo = useMessageStore((s) => s.redo);
  const canUndo = useMessageStore((s) => s.past.length > 0);
  const canRedo = useMessageStore((s) => s.future.length > 0);
  // The Send panel defaults to "Update existing" whenever a restore origin is
  // set — after restoring a message, or after a successful send re-targets the
  // form at the now-live message. Mirror that here so the action reads "Update"
  // when the next post edits in place, "Send" when it posts something new.
  const isUpdate = useMessageStore((s) => s.restoredFrom != null);
  const sendLabel = isUpdate ? "Update" : "Send";

  const openFeedback = useFeedbackStore((s) => s.openFeedback);

  const barRef = useRef<HTMLDivElement>(null);
  // The action bar always stays on a single row. As its available width shrinks
  // — a narrow builder pane on desktop, or a phone — its controls collapse in
  // stages rather than wrapping onto a second line:
  //   0 — every label shown
  //   1 — secondary buttons (Saved / More / Restore) drop to icons, via the
  //       `data-compact` flag their CSS keys off
  //   2 — the primary Send/Update button also drops to its icon
  // We measure the real control widths instead of guessing a breakpoint, so the
  // labels survive on any width — viewport *or* pane — that has room for them.
  const [compact, setCompact] = useState(0);
  // Bumped by the ResizeObserver below whenever the bar's *width* changes; drives
  // a fresh measurement pass. (Width only — collapsing changes the bar's content,
  // not its width, so this never feeds back on itself.)
  const [barWidth, setBarWidth] = useState(0);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() => setBarWidth(bar.clientWidth));
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // On every width change — or when the primary label flips ("Send" ↔ "Update",
  // which is wider) — optimistically restore every label…
  useLayoutEffect(() => {
    setCompact(0);
  }, [barWidth, isUpdate]);

  // …then collapse one stage at a time until the two control groups fit side by
  // side on one row. Each group keeps its natural width, so summing them (plus
  // the gap between and the bar's padding) tells us what a single row needs —
  // more reliable than `scrollWidth`, which `justify-content: space-between`
  // leaves unchanged when items overflow. Each pass runs before paint, so the
  // staged collapse never flashes.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || compact >= 2) return;
    const cs = getComputedStyle(bar);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    const groups = Array.from(bar.children) as HTMLElement[];
    const needed =
      groups.reduce((sum, g) => sum + g.getBoundingClientRect().width, 0) +
      gap * Math.max(0, groups.length - 1) +
      padX;
    if (needed > bar.clientWidth + 1) setCompact((c) => c + 1);
  }, [compact, barWidth, isUpdate]);

  return (
    <div ref={barRef} className={styles.actionBar} data-compact={compact >= 1 ? "" : undefined}>
      <div className={styles.actionGroup}>
        {isProxyConfigured() ? <AccountMenu /> : null}
        <SavedMessagesMenu />
        <IconButton label="Undo" onClick={undo} disabled={!canUndo}>
          <UndoIcon />
        </IconButton>
        <IconButton label="Redo" onClick={redo} disabled={!canRedo}>
          <RedoIcon />
        </IconButton>
      </div>

      <div className={styles.actionGroup}>
        <Menu
          trigger={
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<ShareIcon />}
              trailingIcon={<ChevronDownIcon />}
              collapseLabel
              title="Share link, export JSON, import another message, or view info"
            >
              More
            </Button>
          }
        >
          {(close) => (
            <>
              <MenuItem
                icon={<ShareIcon />}
                onSelect={() => {
                  close();
                  onShare();
                }}
              >
                Share link
              </MenuItem>
              <MenuItem
                icon={<DownloadIcon />}
                onSelect={() => {
                  close();
                  onExport();
                }}
              >
                Export JSON
              </MenuItem>
              <MenuItem
                icon={<UploadIcon />}
                onSelect={() => {
                  close();
                  onImport();
                }}
              >
                Import…
              </MenuItem>
              <MenuItem
                icon={<InfoIcon />}
                onSelect={() => {
                  close();
                  onAbout();
                }}
              >
                About
              </MenuItem>
              {isFeedbackConfigured() ? (
                <MenuItem
                  icon={<SupportIcon />}
                  onSelect={() => {
                    close();
                    openFeedback();
                  }}
                >
                  Send feedback
                </MenuItem>
              ) : null}
            </>
          )}
        </Menu>
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<HistoryIcon />}
          onClick={onRestore}
          collapseLabel
          title="Pull a message your webhook previously posted back into the editor"
        >
          Restore
        </Button>
        <Button
          // Stable anchor for the post-setup coach-mark (see SendCoachMark).
          id="builder-send-action"
          variant="primary"
          size="sm"
          leadingIcon={isUpdate ? <PencilIcon /> : <SendIcon />}
          onClick={onSend}
          aria-label={sendLabel}
          title={
            isUpdate
              ? "Update the message you last posted or restored"
              : "Post this message to your Discord webhook"
          }
        >
          {/* Dropped last — only once collapsing the secondary labels still
              isn't enough to keep the bar on one row (see `compact`). */}
          {compact >= 2 ? null : sendLabel}
        </Button>
      </div>
    </div>
  );
}
