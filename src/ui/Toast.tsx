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

interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
}

let counter = 0;
type Subscriber = (entries: ToastEntry[]) => void;
const subscribers: Set<Subscriber> = new Set();
let entries: ToastEntry[] = [];

function notify() {
  for (const s of subscribers) s(entries);
}

export function pushToast(message: string, tone: ToastTone = "info"): void {
  const id = ++counter;
  entries = [...entries, { id, message, tone }];
  notify();
  setTimeout(() => {
    entries = entries.filter((e) => e.id !== id);
    notify();
  }, 3000);
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
    <div className={styles.viewport} role="status" aria-live="polite">
      {items.map((t) => {
        const Icon = TONE_ICON[t.tone];
        return (
          <div key={t.id} className={cn(styles.toast, styles[t.tone])}>
            <span className={styles.icon} aria-hidden="true">
              <Icon size={18} />
            </span>
            <span className={styles.message}>{t.message}</span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
