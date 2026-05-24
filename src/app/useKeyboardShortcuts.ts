/**
 * Global keyboard shortcuts:
 *   Cmd/Ctrl+Z — undo
 *   Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y — redo
 *
 * We ignore the event when the user is typing in a text field; otherwise
 * Cmd+Z would also undo the editor while they were trying to undo their
 * own text edit.
 */

import { useEffect } from "react";
import { useMessageStore } from "@/core/state/messageStore";

const isTextTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
};

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (isTextTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        useMessageStore.getState().undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        useMessageStore.getState().redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
