import { useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import styles from "./Modal.module.css";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Header content. Use `ariaLabel` whenever this isn't plain text. */
  title: ReactNode;
  /** Accessible dialog name when the visible header needs a clearer alternative. */
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

interface ModalLayer {
  token: symbol;
  backdrop: HTMLElement;
  dialog: HTMLElement;
}

interface InertSnapshot {
  inert: boolean;
  ariaHidden: string | null;
}

const layers: ModalLayer[] = [];
const inertSnapshots = new Map<HTMLElement, InertSnapshot>();
let bodyObserver: MutationObserver | null = null;

function restoreElement(element: HTMLElement, snapshot: InertSnapshot) {
  element.inert = snapshot.inert;
  if (snapshot.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", snapshot.ariaHidden);
}

/**
 * Keep every body-level surface except the topmost modal inert. Modals portal
 * directly to `body`, so this also makes an underlying modal inert when a
 * confirmation is opened above it. A small observer covers toasts and other
 * portal roots that may be added while a dialog is already open.
 */
function syncBodyModality() {
  const topBackdrop = layers.at(-1)?.backdrop ?? null;

  if (!topBackdrop) {
    bodyObserver?.disconnect();
    bodyObserver = null;
    for (const [element, snapshot] of inertSnapshots) restoreElement(element, snapshot);
    inertSnapshots.clear();
    return;
  }

  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;

    // Status toasts are a non-focusable aria-live portal. Keep announcements
    // available when a modal action succeeds or fails without reopening any
    // interactive background surface.
    const isLiveRegion = child.dataset.modalLiveRegion === "true";
    if (child === topBackdrop || isLiveRegion) {
      const snapshot = inertSnapshots.get(child);
      if (snapshot) {
        restoreElement(child, snapshot);
        inertSnapshots.delete(child);
      }
      continue;
    }

    if (!inertSnapshots.has(child)) {
      inertSnapshots.set(child, {
        inert: child.inert,
        ariaHidden: child.getAttribute("aria-hidden"),
      });
    }
    child.inert = true;
    child.setAttribute("aria-hidden", "true");
  }

  for (const element of inertSnapshots.keys()) {
    if (!element.isConnected) inertSnapshots.delete(element);
  }

  if (!bodyObserver) {
    bodyObserver = new MutationObserver(syncBodyModality);
    bodyObserver.observe(document.body, { childList: true });
  }
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableChildren(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.closest("[inert]") &&
      element.getClientRects().length > 0,
  );
}

/**
 * Shared modal primitive. It provides a real modal focus lifecycle while
 * retaining the existing card/backdrop styling:
 *
 * - focus cannot leave the topmost dialog with Tab or programmatic focus;
 * - every background body surface (including an underlying modal) is inert;
 * - only the topmost layer consumes Escape; and
 * - closing restores the element that opened that layer.
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
  const titleId = useId();
  const tokenRef = useRef(Symbol("modal"));
  const lastFocused = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;

    const active = document.activeElement;
    lastFocused.current = active instanceof HTMLElement ? active : null;

    const layer: ModalLayer = { token: tokenRef.current, backdrop, dialog };
    layers.push(layer);

    // Move focus before making the opener's body surface inert.
    const autoFocus = dialog.querySelector<HTMLElement>("[autofocus]");
    (autoFocus ?? dialog).focus({ preventScroll: true });
    syncBodyModality();

    const isTopmost = () => layers.at(-1)?.token === tokenRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost()) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = focusableChildren(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const current = document.activeElement;
      if (!dialog.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (current === first || current === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || current === dialog)) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isTopmost() || dialog.contains(event.target as Node)) return;
      dialog.focus({ preventScroll: true });
    };

    // Capture lets the top layer consume Escape before a parent surface's
    // global listener (for example the template directory) sees it.
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);

      const index = layers.findIndex((candidate) => candidate.token === tokenRef.current);
      const wasTopmost = index === layers.length - 1;
      if (index >= 0) layers.splice(index, 1);
      syncBodyModality();

      if (!wasTopmost) return;
      const opener = lastFocused.current;
      requestAnimationFrame(() => {
        if (opener?.isConnected && !opener.closest("[inert]")) {
          opener.focus({ preventScroll: true });
        } else {
          layers.at(-1)?.dialog.focus({ preventScroll: true });
        }
      });
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={backdropRef}
      className={styles.backdrop}
      style={backdropStyle}
      data-modal-backdrop="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && layers.at(-1)?.token === tokenRef.current) {
          onCloseRef.current();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId}
        tabIndex={-1}
        className={cn(styles.dialog, size === "sm" && styles.dialogSm)}
      >
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={() => onCloseRef.current()}
            className={styles.close}
          >
            ×
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
