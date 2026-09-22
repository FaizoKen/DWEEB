import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Toast.module.css";
import { cn } from "@/lib/cn";
import { AlertCircleIcon, CheckCircleIcon, InfoIcon } from "@/ui/Icon";

type ToastTone = "info" | "success" | "error";

const TONE_ICON: Record<ToastTone, typeof InfoIcon> = {
  info: InfoIcon,
  success: CheckCircleIcon,
  error: AlertCircleIcon,
};

/** An optional one-tap follow-up shown inside the toast (Undo, Watch the intro…). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Override the auto-dismiss delay. */
  durationMs?: number;
}

interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

/** Plain feedback reads in a glance. */
const DEFAULT_MS = 3000;
/** Errors carry longer copy the user may need to act on. */
const ERROR_MS = 5000;
/**
 * A toast offering an action (typically Undo after a destructive edit) has to
 * outlast the moment of "wait, no" — but not so long it nags.
 */
const ACTION_MS = 7000;

let counter = 0;
type Subscriber = (entries: ToastEntry[]) => void;
const subscribers: Set<Subscriber> = new Set();
let entries: ToastEntry[] = [];
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function notify() {
  for (const s of subscribers) s(entries);
}

function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  entries = entries.filter((e) => e.id !== id);
  notify();
}

export function pushToast(
  message: string,
  tone: ToastTone = "info",
  options: ToastOptions = {},
): void {
  const id = ++counter;
  const { action, durationMs } = options;
  entries = [...entries, { id, message, tone, action }];
  notify();
  const ms = durationMs ?? (action ? ACTION_MS : tone === "error" ? ERROR_MS : DEFAULT_MS);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), ms),
  );
}

export function ToastViewport() {
  const [items, setItems] = useState<ToastEntry[]>(entries);
  useEffect(() => {
    subscribers.add(setItems);
    return () => {
      subscribers.delete(setItems);
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={styles.viewport} role="status" aria-live="polite" data-modal-live-region="true">
      {items.map((t) => {
        const Icon = TONE_ICON[t.tone];
        return (
          <div key={t.id} className={cn(styles.toast, styles[t.tone])}>
            <span className={styles.icon} aria-hidden="true">
              <Icon size={18} />
            </span>
            <span className={styles.message}>{t.message}</span>
            {t.action ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  // Dismiss first: the action may itself push a toast, and the
                  // one it came from must not linger beside it.
                  dismissToast(t.id);
                  t.action?.onClick();
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
