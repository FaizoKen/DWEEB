/**
 * Top toolbar: brand, undo/redo, presets, start-over, send, share.
 *
 * The toolbar is a thin shell — every action is a single store call (`undo`,
 * `redo`, `loadPresetById`) or opens a dialog. Dialogs are owned by the
 * parent so the toolbar stays presentational.
 *
 * Why two primary-ish CTAs on the right (Send + Share / Export): hiding
 * Send inside the Share dialog made the "what now?" step invisible to
 * first-time users. The dedicated button removes the guess.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import {
  LogoMark,
  RedoIcon,
  SendIcon,
  ShareIcon,
  SparkleIcon,
  UndoIcon,
} from "@/ui/Icon";
import { PRESETS } from "@/data/presets";
import { Select } from "@/ui/Select";
import styles from "./Toolbar.module.css";

interface ToolbarProps {
  /** Opens the Share / Export dialog on the Share-link tab. */
  onShare: () => void;
  /** Opens the Share / Export dialog focused on the Send panel. */
  onSend: () => void;
  /** Opens the Share / Export dialog focused on the Restore panel. */
  onRestore: () => void;
  /** Re-opens the welcome dialog so the user can pick a fresh starting point. */
  onStartOver: () => void;
}

export function Toolbar({ onShare, onSend, onRestore, onStartOver }: ToolbarProps) {
  const undo = useMessageStore((s) => s.undo);
  const redo = useMessageStore((s) => s.redo);
  const canUndo = useMessageStore((s) => s.past.length > 0);
  const canRedo = useMessageStore((s) => s.future.length > 0);
  const loadPresetById = useMessageStore((s) => s.loadPresetById);

  return (
    <header className={styles.toolbar}>
      <div className={styles.brand}>
        <LogoMark />
        <div>
          <div className={styles.brandTitle}>Discord Webhook Builder</div>
          <div className={styles.brandSub}>Components V2 editor</div>
        </div>
      </div>

      <div className={styles.center}>
        <div className={styles.group}>
          <IconButton label="Undo" onClick={undo} disabled={!canUndo}>
            <UndoIcon />
          </IconButton>
          <IconButton label="Redo" onClick={redo} disabled={!canRedo}>
            <RedoIcon />
          </IconButton>
        </div>
        <div className={styles.divider} aria-hidden="true" />
        <div className={styles.group}>
          <SparkleIcon size={14} />
          <Select
            aria-label="Load preset"
            defaultValue=""
            onChange={(e) => {
              if (e.currentTarget.value) {
                loadPresetById(e.currentTarget.value);
                e.currentTarget.value = "";
              }
            }}
          >
            <option value="">Load preset…</option>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className={styles.right}>
        <Button
          variant="ghost"
          onClick={onStartOver}
          title="Pick a fresh starting point — your current draft stays saved"
        >
          Start over
        </Button>
        <Button
          variant="ghost"
          onClick={onRestore}
          title="Pull a message your webhook previously posted back into the editor"
        >
          Restore
        </Button>
        <Button
          variant="secondary"
          leadingIcon={<ShareIcon />}
          onClick={onShare}
          title="Share link, copy JSON, or import another message"
        >
          Share / Export
        </Button>
        <Button
          variant="primary"
          leadingIcon={<SendIcon />}
          onClick={onSend}
          title="Post this message to your Discord webhook"
        >
          Send
        </Button>
      </div>
    </header>
  );
}
