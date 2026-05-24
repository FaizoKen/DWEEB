import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Toast.module.css";
import { cn } from "@/lib/cn";

type ToastTone = "info" | "success" | "error";

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
      {items.map((t) => (
        <div key={t.id} className={cn(styles.toast, styles[t.tone])}>
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}
