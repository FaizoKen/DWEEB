import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Toast.module.css";
import { cn } from "@/lib/cn";
import { AlertCircleIcon, CheckCircleIcon, CloseIcon, InfoIcon } from "@/ui/Icon";
import {
  currentToasts,
  dismissToast,
  setToastsPaused,
  subscribeToasts,
  type ToastEntry,
  type ToastTone,
} from "./toastQueue";

export { pushToast, type ToastAction, type ToastOptions } from "./toastQueue";

const TONE_ICON: Record<ToastTone, typeof InfoIcon> = {
  info: InfoIcon,
  success: CheckCircleIcon,
  error: AlertCircleIcon,
};

const describedBy = (id: number) => `dweeb-toast-${id}`;

export function ToastViewport() {
  const [items, setItems] = useState<readonly ToastEntry[]>(currentToasts);
  const stackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToasts(setItems);
    // A toast pushed between the first render and this effect.
    setItems(currentToasts());
    // A hidden tab holds every countdown: an error raised while someone is on
    // another tab is still there to read when they come back.
    const syncHidden = () => setToastsPaused("hidden", document.visibilityState === "hidden");
    syncHidden();
    document.addEventListener("visibilitychange", syncHidden);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", syncHidden);
      setToastsPaused("hidden", false);
      setToastsPaused("hover", false);
      setToastsPaused("focus", false);
    };
  }, []);

  // Removing the toast under the pointer or focus doesn't reliably fire a
  // leave/blur, so an emptied stack releases both holds itself.
  useEffect(() => {
    if (items.length > 0) return;
    setToastsPaused("hover", false);
    setToastsPaused("focus", false);
  }, [items]);

  const close = (id: number) => {
    // The focused button leaves with its toast, and no blur says so.
    if (stackRef.current?.contains(document.activeElement)) setToastsPaused("focus", false);
    dismissToast(id);
  };

  if (typeof document === "undefined") return null;
  const polite = items.filter((t) => t.tone !== "error");
  const urgent = items.filter((t) => t.tone === "error");

  return createPortal(
    // One body-level root: Modal leaves `data-modal-live-region` surfaces out of
    // its inerting, so a toast raised from inside a dialog is still announced
    // and still clickable.
    <div data-modal-live-region="true">
      {/* What screen readers hear. Errors interrupt; everything else waits its
          turn. Each message lives here once — the visible copy below is hidden
          from assistive tech, and the toast's buttons point back here for their
          description — so nothing is read twice. */}
      <div className="sr-only" role="status" aria-atomic="false">
        {polite.map((t) => (
          <p key={t.id} id={describedBy(t.id)}>
            {t.message}
          </p>
        ))}
      </div>
      <div className="sr-only" role="alert" aria-atomic="false">
        {urgent.map((t) => (
          <p key={t.id} id={describedBy(t.id)}>
            {t.message}
          </p>
        ))}
      </div>
      <div
        ref={stackRef}
        className={styles.viewport}
        // The countdowns hold while someone is reading or reaching for a toast.
        onPointerEnter={() => setToastsPaused("hover", true)}
        onPointerLeave={() => setToastsPaused("hover", false)}
        onFocus={() => setToastsPaused("focus", true)}
        onBlur={(e) => {
          if (!stackRef.current?.contains(e.relatedTarget as Node | null)) {
            setToastsPaused("focus", false);
          }
        }}
      >
        {items.map((t) => {
          const Icon = TONE_ICON[t.tone];
          return (
            <div key={t.id} className={cn(styles.toast, styles[t.tone])}>
              <span className={styles.icon} aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className={styles.message} aria-hidden="true">
                {t.message}
              </span>
              {t.action ? (
                <button
                  type="button"
                  className={styles.action}
                  aria-describedby={describedBy(t.id)}
                  onClick={() => {
                    // Dismiss first: the action may itself push a toast, and the
                    // one it came from must not linger beside it.
                    close(t.id);
                    t.action?.onClick();
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
              <button
                type="button"
                className={styles.dismiss}
                aria-label="Dismiss"
                aria-describedby={describedBy(t.id)}
                title="Dismiss"
                onClick={() => close(t.id)}
              >
                <CloseIcon size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
