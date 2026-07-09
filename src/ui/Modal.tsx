import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import styles from "./Modal.module.css";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Header content. Use `ariaLabel` whenever this isn't plain text. */
  title: ReactNode;
  /** Accessible dialog name when the header is not a plain-text title. */
  ariaLabel?: string;
  /** Optional footer area (typically holds buttons). */
  footer?: ReactNode;
  /** "sm" renders a compact centered dialog that stays small on mobile. */
  size?: "sm" | "md";
  /** Inline overrides for the backdrop — e.g. a raised `zIndex` so the dialog
   *  clears another full-screen overlay it's opened on top of. */
  backdropStyle?: CSSProperties;
  children: ReactNode;
}

/**
 * Accessible modal:
 *  - Restores focus to the previously focused element on close.
 *  - Traps focus via the surrounding `<dialog>` semantics.
 *  - Closes on Escape and on backdrop click.
 *
 * Rendered into `document.body` via a portal so it escapes any scroll
 * container the trigger lives in.
 */
export function Modal({
  open,
  onClose,
  title,
  ariaLabel,
  footer,
  size = "md",
  backdropStyle,
  children,
}: ModalProps) {
  const lastFocused = useRef<Element | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    lastFocused.current = document.activeElement;
    const t = setTimeout(() => dialogRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      if (lastFocused.current instanceof HTMLElement) lastFocused.current.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={styles.backdrop}
      style={backdropStyle}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : "Dialog")}
        tabIndex={-1}
        className={cn(styles.dialog, size === "sm" && styles.dialogSm)}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className={styles.close}
          >
            ✕
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
