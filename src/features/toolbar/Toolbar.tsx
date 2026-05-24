/**
 * Top toolbar: brand, undo/redo, presets, share.
 *
 * The toolbar is a thin shell — every action is a single store call (`undo`,
 * `redo`, `loadPresetById`) or opens a dialog. The dialog is owned by the
 * parent so the toolbar stays presentational.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import {
  LogoMark,
  RedoIcon,
  ShareIcon,
  SparkleIcon,
  UndoIcon,
} from "@/ui/Icon";
import { PRESETS } from "@/data/presets";
import { Select } from "@/ui/Select";
import styles from "./Toolbar.module.css";

interface ToolbarProps {
  onShare: () => void;
}

export function Toolbar({ onShare }: ToolbarProps) {
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
        <Button variant="primary" leadingIcon={<ShareIcon />} onClick={onShare}>
          Share / Export
        </Button>
      </div>
    </header>
  );
}
