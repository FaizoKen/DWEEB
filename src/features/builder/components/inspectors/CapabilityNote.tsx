/**
 * Tiny note rendered inside an inspector to flag a component-level capability
 * requirement (needs a bot, needs app monetization, etc.). The message-level
 * Send panel reiterates the same information; this exists so users notice the
 * requirement while editing instead of only when sending.
 */

import styles from "./CapabilityNote.module.css";
import { cn } from "@/lib/cn";

interface Props {
  tone?: "info" | "warning";
  children: React.ReactNode;
}

export function CapabilityNote({ tone = "warning", children }: Props) {
  return (
    <div
      role="note"
      className={cn(styles.note, tone === "info" ? styles.info : styles.warn)}
    >
      {children}
    </div>
  );
}
