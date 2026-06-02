/**
 * Native HTML5 file drag-and-drop for an arbitrary element — used by the
 * gallery / thumbnail tree rows and the gallery inspector to accept OS file
 * drops without the inspector having to be open.
 *
 * This is deliberately distinct from the component tree's *pointer*-based
 * reorder DnD: OS file drags fire the `drag*` events handled here, while an
 * in-app row reorder is pure pointer capture, so the two never collide.
 *
 * Files are filtered against `accept` (same rules as a native picker); the
 * caller gets the accepted files via `onFiles` and any rejects via `onReject`
 * so it can surface its own messaging.
 */

import { useState, type DragEvent } from "react";
import { isFileDrag, matchesAccept } from "@/lib/fileUpload";

interface UseFileDropOptions {
  /** Allow-list, e.g. "image/*" or "image/*,video/*". Empty permits anything. */
  accept?: string;
  /** When false, only the first dropped file is kept. */
  multiple?: boolean;
  /** Gate the whole behaviour off (handlers no-op, never highlights). */
  enabled?: boolean;
  onFiles: (files: File[]) => void;
  onReject?: (files: File[]) => void;
}

export interface FileDropHandlers {
  onDragEnter: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

export function useFileDrop({
  accept,
  multiple = false,
  enabled = true,
  onFiles,
  onReject,
}: UseFileDropOptions): { isDragOver: boolean; handlers: FileDropHandlers } {
  const [isDragOver, setIsDragOver] = useState(false);

  const onDragEnter = (e: DragEvent) => {
    if (!enabled || !isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const onDragOver = (e: DragEvent) => {
    if (!enabled || !isFileDrag(e)) return;
    // preventDefault is what tells the browser this element is a valid drop
    // target (and stops it from navigating to the dropped file).
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    if (!isDragOver) setIsDragOver(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (!enabled) return;
    // Ignore leaves that just cross into a child element.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  };

  const onDrop = (e: DragEvent) => {
    if (!enabled || !isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const all = Array.from(e.dataTransfer.files ?? []);
    const picked = multiple ? all : all.slice(0, 1);
    const accepted: File[] = [];
    const rejected: File[] = [];
    for (const file of picked) (matchesAccept(file, accept) ? accepted : rejected).push(file);
    if (rejected.length > 0 && onReject) onReject(rejected);
    if (accepted.length > 0) onFiles(accepted);
  };

  return {
    isDragOver: enabled && isDragOver,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
