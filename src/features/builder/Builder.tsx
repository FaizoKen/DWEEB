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

  return (
    <div className={styles.actionBar}>
      <div className={styles.actionGroup}>
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
          title="Pull a message your webhook previously posted back into the editor"
        >
          Restore
        </Button>
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<SendIcon />}
          onClick={onSend}
          title="Post this message to your Discord webhook"
        >
          Send
        </Button>
      </div>
    </div>
  );
}
