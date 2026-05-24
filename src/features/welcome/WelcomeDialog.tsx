/**
 * Welcome dialog — first-launch onboarding.
 *
 * Shown on first visit (and any time the user clicks "Start over" in the
 * toolbar). Offers four self-explanatory paths so a beginner has an obvious
 * next click without having to learn the editor first:
 *
 *   1. Continue previous work   (only if a draft exists in localStorage)
 *   2. Start with a template    (one of the curated presets)
 *   3. Start blank              (single empty TextDisplay)
 *   4. Import                   (paste a share URL or JSON payload)
 *
 * The dialog is stateless w.r.t. the message — picking any option goes
 * through normal store actions, so undo/redo and auto-save work the same
 * way they do everywhere else.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { TextArea } from "@/ui/TextArea";
import { useMessageStore } from "@/core/state/messageStore";
import { loadDraft, loadDraftMessage } from "@/core/state/draftStorage";
import { PRESETS } from "@/data/presets";
import { decodeJson, decodeShare } from "@/core/serialization";
import { validateMessage } from "@/core/schema/validation";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import styles from "./WelcomeDialog.module.css";

interface WelcomeDialogProps {
  open: boolean;
  onDismiss: () => void;
  /**
   * Called when the user picks "Restore from Discord". The welcome dialog
   * itself doesn't host the restore form — App routes this to the Share
   * dialog's Restore tab so there's a single source of truth for that flow.
   */
  onRestoreFromDiscord: () => void;
}

type Path = "menu" | "templates" | "import";

export function WelcomeDialog({ open, onDismiss, onRestoreFromDiscord }: WelcomeDialogProps) {
  // Re-read on each open so a fresh draft (e.g. after editing then clicking
  // "Start over") shows up with the right timestamp.
  const draft = useMemo(() => (open ? loadDraft() : null), [open]);
  const [path, setPath] = useState<Path>("menu");

  // Reset to the main menu after the dialog closes, so re-opening starts fresh.
  useEffect(() => {
    if (!open) setPath("menu");
  }, [open]);

  return (
    <Modal open={open} onClose={onDismiss} title="Welcome — pick a starting point">
      {path === "menu" ? (
        <Menu
          draft={draft}
          onPickTemplates={() => setPath("templates")}
          onPickImport={() => setPath("import")}
          onPickRestore={onRestoreFromDiscord}
          onDone={onDismiss}
        />
      ) : null}
      {path === "templates" ? (
        <TemplatesPanel onBack={() => setPath("menu")} onDone={onDismiss} />
      ) : null}
      {path === "import" ? (
        <ImportPanel onBack={() => setPath("menu")} onDone={onDismiss} />
      ) : null}
    </Modal>
  );
}

/* ── Menu ─────────────────────────────────────────────────────────────── */

function Menu({
  draft,
  onPickTemplates,
  onPickImport,
  onPickRestore,
  onDone,
}: {
  draft: { savedAt: number } | null;
  onPickTemplates: () => void;
  onPickImport: () => void;
  onPickRestore: () => void;
  onDone: () => void;
}) {
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const loadBlank = useMessageStore((s) => s.loadBlank);

  const continueDraft = () => {
    const restored = loadDraftMessage();
    if (!restored) {
      pushToast("Saved draft was unreadable — starting from a template.", "info");
      onDone();
      return;
    }
    replaceMessage(restored.message);
    onDone();
  };

  return (
    <>
      <p className={styles.lead}>
        New here? Pick how you want to begin. You can change your mind any time —
        every action is undoable, and your work auto-saves to this browser.
      </p>

      <div className={styles.cards}>
        {draft ? (
          <Card
            highlighted
            badge={`Last edit ${formatRelative(draft.savedAt)}`}
            title="Continue previous work"
            description="Restore the message you were editing in this browser. Nothing leaves your device."
            cta="Continue"
            onClick={continueDraft}
          />
        ) : null}

        <Card
          title="Start with a template"
          description="Pick a ready-to-use example like a release note or event card, then tweak from there."
          cta="Browse templates"
          onClick={onPickTemplates}
        />

        <Card
          title="Start blank"
          description="An empty text box. Best when you know exactly what you want to build."
          cta="Start blank"
          onClick={() => {
            loadBlank();
            onDone();
          }}
        />

        <Card
          title="Restore from Discord"
          description="Pull a message your webhook already posted back into the editor so you can keep iterating on it."
          cta="Restore…"
          onClick={onPickRestore}
        />

        <Card
          title="Import from URL or JSON"
          description="Paste a share URL or a Components V2 JSON payload to keep iterating on it."
          cta="Import…"
          onClick={onPickImport}
        />
      </div>

      <div className={styles.tips}>
        <strong className={styles.tipsTitle}>How the editor works</strong>
        <ol className={styles.tipsList}>
          <li>
            <strong>Add components</strong> from the left panel — text, buttons, containers, media.
          </li>
          <li>
            <strong>Click any block</strong> to edit its fields in the inspector below.
          </li>
          <li>
            <strong>Preview live</strong> on the right — it matches what Discord will render.
          </li>
          <li>
            <strong>Send or share</strong> via the top-right button when you're happy.
          </li>
        </ol>
      </div>
    </>
  );
}

/* ── Templates panel ──────────────────────────────────────────────────── */

function TemplatesPanel({
  onBack,
  onDone,
}: {
  onBack: () => void;
  onDone: () => void;
}) {
  const loadPresetById = useMessageStore((s) => s.loadPresetById);
  // Hide the blank starter here — it has its own card on the main menu.
  const templates = useMemo(() => PRESETS.filter((p) => p.id !== "blank"), []);

  return (
    <>
      <button type="button" className={styles.back} onClick={onBack}>
        ← Back
      </button>
      <p className={styles.lead}>
        Each template is a complete example. Picking one replaces the current message — your
        previous work will still be in this browser's draft if you want it back.
      </p>
      <div className={styles.templateList}>
        {templates.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={styles.templateRow}
            onClick={() => {
              loadPresetById(preset.id);
              onDone();
            }}
          >
            <span className={styles.templateName}>{preset.name}</span>
            <span className={styles.templateDesc}>{preset.description}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/* ── Import panel (mirrors ShareDialog's Import tab) ──────────────────── */

function ImportPanel({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const replace = useMessageStore((s) => s.replaceMessage);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);

  const tryImport = () => {
    const value = ref.current?.value.trim() ?? "";
    if (!value) {
      setError("Paste a share URL, share token, or JSON payload to continue.");
      return;
    }
    const urlMatch = /#s=([^&]+)/.exec(value);
    if (urlMatch) return finish(decodeShare(urlMatch[1]!));
    if (/^\d+\./.test(value)) return finish(decodeShare(value));
    finish(decodeJson(value));
  };

  function finish(result: ReturnType<typeof decodeJson>) {
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const validation = validateMessage(result.message);
    replace(result.message);
    setError(null);
    if (!validation.ok) {
      pushToast(
        `Imported with ${validation.issues.length} validation issue${validation.issues.length === 1 ? "" : "s"}.`,
        "info",
      );
    } else {
      pushToast("Imported — happy editing!", "success");
    }
    onDone();
  }

  return (
    <>
      <button type="button" className={styles.back} onClick={onBack}>
        ← Back
      </button>
      <p className={styles.lead}>
        Paste a share URL, a share token, or a Components V2 JSON payload. This becomes your new
        starting point.
      </p>
      <TextArea
        ref={ref}
        rows={8}
        placeholder='https://...#s=...   or   { "components": [ ... ] }'
        invalid={!!error}
      />
      {error ? <div className={styles.error}>{error}</div> : null}
      <div className={styles.importActions}>
        <Button variant="primary" onClick={tryImport}>
          Import and continue
        </Button>
      </div>
    </>
  );
}

/* ── Bits ─────────────────────────────────────────────────────────────── */

function Card({
  title,
  description,
  cta,
  onClick,
  badge,
  highlighted,
}: {
  title: string;
  description: string;
  cta: string;
  onClick: () => void;
  badge?: string;
  highlighted?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(styles.card, highlighted && styles.cardHighlighted)}
      onClick={onClick}
    >
      {badge ? <span className={styles.cardBadge}>{badge}</span> : null}
      <span className={styles.cardTitle}>{title}</span>
      <span className={styles.cardDesc}>{description}</span>
      <span className={styles.cardCta}>{cta} →</span>
    </button>
  );
}

/** "Just now", "3 minutes ago", "yesterday", "4 days ago" — no Intl needed. */
function formatRelative(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  if (diffMs < 30_000) return "just now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
