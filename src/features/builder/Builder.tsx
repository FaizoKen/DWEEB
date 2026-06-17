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
  RedoIcon,
  SendIcon,
  ShareIcon,
  UndoIcon,
  UploadIcon,
} from "@/ui/Icon";
import { Menu, MenuItem } from "@/ui/Menu";
import { ComponentTree } from "./components/ComponentTree";
import { SavedMessagesMenu } from "./components/SavedMessagesMenu";
import { AccountMenu } from "@/features/guild/AccountMenu";
import { isProxyConfigured } from "@/core/guild/config";
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
      <ActionBar
        onShare={onShare}
        onExport={onExport}
        onImport={onImport}
        onSend={onSend}
        onRestore={onRestore}
        onAbout={onAbout}
      />

      <ComponentTree />
    </div>
  );
}

function ActionBar({ onShare, onExport, onImport, onSend, onRestore, onAbout }: BuilderProps) {
  const undo = useMessageStore((s) => s.undo);
  const redo = useMessageStore((s) => s.redo);
  const canUndo = useMessageStore((s) => s.past.length > 0);
  const canRedo = useMessageStore((s) => s.future.length > 0);

  const barRef = useRef<HTMLDivElement>(null);
  // We always *prefer* to show the "Send" label. It only drops to an icon when
  // keeping the text would push the action bar onto a second row — i.e. on the
  // narrowest phones where it genuinely can't fit. Unlike a fixed breakpoint,
  // this shows the label on any viewport (or tablet) that has room for it.
  const [sendCompact, setSendCompact] = useState(false);
  // Bumped by the ResizeObserver below whenever the bar's *width* changes; drives
  // a fresh measurement pass. (Width only — our own collapse changes the bar's
  // height, and reacting to that would loop.)
  const [barWidth, setBarWidth] = useState(0);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() => setBarWidth(bar.clientWidth));
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // On every width change, optimistically restore the label…
  useLayoutEffect(() => {
    setSendCompact(false);
  }, [barWidth]);

  // …then, with the label shown, collapse to an icon only if the two control
  // groups can't sit side by side on one row. Each group keeps its natural width
  // whether or not the bar has wrapped, so summing them (plus the gap between and
  // the bar's padding) tells us what a single row needs — more reliable than
  // `scrollWidth`, which `justify-content: space-between` leaves unchanged when
  // items overflow. Runs before paint, so the optimistic expand never flashes.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || sendCompact) return;
    const cs = getComputedStyle(bar);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    const groups = Array.from(bar.children) as HTMLElement[];
    const needed =
      groups.reduce((sum, g) => sum + g.getBoundingClientRect().width, 0) +
      gap * Math.max(0, groups.length - 1) +
      padX;
    if (needed > bar.clientWidth + 1) setSendCompact(true);
  }, [sendCompact, barWidth]);

  return (
    <div ref={barRef} className={styles.actionBar}>
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
          leadingIcon={<SendIcon />}
          onClick={onSend}
          aria-label="Send"
          title="Post this message to your Discord webhook"
        >
          {/* Hidden only when the bar would otherwise wrap (see sendCompact). */}
          {sendCompact ? null : "Send"}
        </Button>
      </div>
    </div>
  );
}
