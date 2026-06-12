/**
 * Undo/redo history persistence.
 *
 * Saves the editor's undo/redo stacks to `localStorage` so a refresh keeps
 * the user's recent history alongside the draft (`draftStorage.ts`). Frames
 * are stored in the same wire format as the draft (no editor `_id`s) and
 * re-hydrated through `attachEditorFields`, so a schema-incompatible frame
 * from an older build is simply dropped — each frame is a full snapshot, so
 * the survivors still undo/redo cleanly.
 *
 * Built so frequent saves stay cheap:
 *  - History frames are immutable once pushed, so each frame's JSON is
 *    serialized exactly once and memoized in a WeakMap. A typical save only
 *    stringifies the single newly pushed frame.
 *  - The stored record is assembled by joining the cached frame strings —
 *    saving never re-serializes the whole history.
 *  - Persistence is capped (frames per stack plus a total byte budget,
 *    newest frames win) so the record can't grow past a small slice of the
 *    `localStorage` quota; older steps remain undoable in-memory only.
 */

import type { WebhookMessage } from "@/core/schema/types";
import { attachEditorFields, stripEditorFields } from "@/core/serialization/normalize";

const STORAGE_KEY = "dweeb.history.v1";

/** Most recent steps persisted per stack; older steps stay memory-only. */
const MAX_FRAMES_PER_STACK = 25;
/** Total serialized budget across both stacks. */
const MAX_BYTES = 1_000_000;

/** One undo/redo step — a full snapshot of the message at that point. */
export interface HistoryFrame {
  message: WebhookMessage;
}

/**
 * Frame → wire-format JSON memo. Keyed by the message object itself: the
 * store treats every snapshot as immutable, so identity is a safe cache key.
 * Entries die with their frames (WeakMap), so trimmed history frees itself.
 */
const frameJson = new WeakMap<WebhookMessage, string>();

function serializeFrame(message: WebhookMessage): string {
  let json = frameJson.get(message);
  if (json === undefined) {
    json = JSON.stringify(stripEditorFields(message));
    frameJson.set(message, json);
  }
  return json;
}

/**
 * Persist the undo/redo stacks. Silently no-ops on quota errors (keeping the
 * previous record beats throwing inside the auto-save subscriber).
 */
export function saveHistory(past: readonly HistoryFrame[], future: readonly HistoryFrame[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    let bytes = 0;

    // Walk `past` newest-first so the caps favor the most recent undo steps,
    // then restore chronological order for storage.
    const pastJson: string[] = [];
    for (let i = past.length - 1; i >= 0 && pastJson.length < MAX_FRAMES_PER_STACK; i--) {
      const json = serializeFrame(past[i]!.message);
      if (bytes + json.length > MAX_BYTES) break;
      bytes += json.length;
      pastJson.push(json);
    }
    pastJson.reverse();

    // `future[0]` is the next redo step — nearest-first already.
    const futureJson: string[] = [];
    for (let i = 0; i < future.length && futureJson.length < MAX_FRAMES_PER_STACK; i++) {
      const json = serializeFrame(future[i]!.message);
      if (bytes + json.length > MAX_BYTES) break;
      bytes += json.length;
      futureJson.push(json);
    }

    if (pastJson.length === 0 && futureJson.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }

    // Hand-assembled from the per-frame strings (each already valid JSON) so
    // a save never re-serializes frames it has stored before.
    localStorage.setItem(
      STORAGE_KEY,
      `{"past":[${pastJson.join(",")}],"future":[${futureJson.join(",")}]}`,
    );
  } catch {
    // Quota exceeded or storage disabled.
  }
}

/** Read the persisted undo/redo stacks, if any. Never throws. */
export function loadHistory(): { past: HistoryFrame[]; future: HistoryFrame[] } | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { past?: unknown; future?: unknown };
    const past = reviveFrames(parsed.past);
    const future = reviveFrames(parsed.future);
    if (past.length === 0 && future.length === 0) return null;
    return { past, future };
  } catch {
    return null;
  }
}

function reviveFrames(raw: unknown): HistoryFrame[] {
  if (!Array.isArray(raw)) return [];
  const frames: HistoryFrame[] = [];
  for (const payload of raw) {
    try {
      frames.push({ message: attachEditorFields(payload) });
    } catch {
      // Malformed frame (older incompatible build) — skip it.
    }
  }
  return frames;
}
