/**
 * Session-only registry of in-memory file blobs.
 *
 * Components V2 lets media items (`File`, `Thumbnail`, `MediaGallery`) point at
 * either a public `https://` URL or a multipart attachment referenced as
 * `attachment://<filename>`. Real file uploads require sending the bytes
 * alongside the JSON payload — but those bytes are not serializable, so they
 * can't live in the editor state, the auto-save draft, the share URL, or the
 * JSON export.
 *
 * We work around that by:
 *  1. Keeping File/Blob handles here, keyed by an opaque id (`blobId`).
 *  2. Storing a sentinel URL in the editor state of the form
 *     `session://<blobId>/<filename>`. The id lets us look the blob back up;
 *     the filename suffix is what Discord's `attachment://<filename>` wants.
 *  3. Resolving session URLs to object URLs (`URL.createObjectURL`) for the
 *     preview, and rewriting them to `attachment://<filename>` + multipart
 *     parts at send time.
 *
 * Persistence rules:
 *  - The registry is the live source of truth, but it now *writes through* to
 *    IndexedDB (see `attachmentDb`): every register persists the bytes, every
 *    forget / GC removes them. On startup `hydrateAttachments()` reads them
 *    back so a `session://` URL the draft restored resolves again — uploads
 *    survive a reload.
 *  - The auto-save draft keeps the `session://` reference (it's just a URL);
 *    re-connecting it to the rehydrated blob is what makes the upload reappear.
 *  - Share URLs / JSON export *do* strip `session://` references (see `encode`),
 *    since the recipient's browser has no access to this browser's blob store.
 *  - A blob that can't be rehydrated (IndexedDB disabled, evicted, or shared
 *    from another origin) still surfaces as "missing" in the inspector and
 *    validator, exactly as before.
 */

import {
  deleteAttachmentBlob,
  deleteAttachmentBlobs,
  loadAllAttachmentBlobs,
  putAttachmentBlob,
} from "./attachmentDb";

const SESSION_PREFIX = "session://";

interface BlobRecord {
  file: File;
  /** Lazy object URL for previews. Created on first call, revoked on free. */
  objectUrl?: string;
}

const blobs = new Map<string, BlobRecord>();
const listeners = new Set<() => void>();

/**
 * Version counter incremented on every add/remove. `useSyncExternalStore`
 * compares snapshots with `Object.is`, so we can't return the mutable `blobs`
 * Map — its reference never changes and React would skip re-renders after
 * `notify()`. The dev-only StrictMode double-render hides this; prod doesn't.
 */
let version = 0;

function notify() {
  version++;
  for (const fn of listeners) fn();
}

/** Subscribe to registry changes so React components can re-render on add/remove. */
export function subscribeAttachments(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Stable snapshot for `useSyncExternalStore` — changes whenever the registry mutates. */
export function getAttachmentSnapshot(): number {
  return version;
}

/** Register a new blob. Returns the session URL to store in editor state. */
export function registerAttachment(file: File): string {
  const id = makeBlobId();
  blobs.set(id, { file });
  // Write through to IndexedDB so the upload survives a reload. Fire-and-forget
  // — the session URL is usable immediately; the persisted copy lands shortly.
  void putAttachmentBlob(id, file);
  notify();
  return buildSessionUrl(id, file.name);
}

/** Drop a blob and revoke its object URL, if any. */
export function forgetAttachment(blobId: string): void {
  const record = blobs.get(blobId);
  if (!record) return;
  if (record.objectUrl) URL.revokeObjectURL(record.objectUrl);
  blobs.delete(blobId);
  void deleteAttachmentBlob(blobId);
  notify();
}

/** Drop every blob whose id isn't referenced by the supplied URL list. */
export function garbageCollect(referencedUrls: Iterable<string>): void {
  const live = new Set<string>();
  for (const url of referencedUrls) {
    const parsed = parseSessionUrl(url);
    if (parsed) live.add(parsed.blobId);
  }
  let changed = false;
  const removed: string[] = [];
  for (const id of Array.from(blobs.keys())) {
    if (live.has(id)) continue;
    const rec = blobs.get(id)!;
    if (rec.objectUrl) URL.revokeObjectURL(rec.objectUrl);
    blobs.delete(id);
    removed.push(id);
    changed = true;
  }
  // Evict the same ids from IndexedDB so orphaned uploads don't accumulate
  // across sessions (e.g. a component deleted, or a draft replaced by import).
  if (removed.length > 0) void deleteAttachmentBlobs(removed);
  if (changed) notify();
}

/**
 * Restore persisted uploads into the in-memory registry. Idempotent and safe
 * to call from `useEffect` (StrictMode double-invoke included): the first call
 * latches, later calls resolve immediately. Existing in-memory ids win — we
 * only fill gaps — so a blob registered before hydration finishes isn't
 * clobbered by its persisted copy.
 *
 * Resolves once hydration is done, letting the caller reconcile the restored
 * blobs against the live tree (drop anything no longer referenced).
 */
let hydration: Promise<void> | null = null;
export function hydrateAttachments(): Promise<void> {
  if (hydration) return hydration;
  hydration = loadAllAttachmentBlobs().then((records) => {
    let changed = false;
    for (const { id, file } of records) {
      if (blobs.has(id)) continue;
      blobs.set(id, { file });
      changed = true;
    }
    if (changed) notify();
  });
  return hydration;
}

export interface SessionUrlParts {
  blobId: string;
  filename: string;
}

export function isSessionUrl(url: string): boolean {
  return url.startsWith(SESSION_PREFIX);
}

export function buildSessionUrl(blobId: string, filename: string): string {
  return `${SESSION_PREFIX}${blobId}/${encodeURIComponent(sanitizeFilename(filename))}`;
}

export function parseSessionUrl(url: string): SessionUrlParts | null {
  if (!isSessionUrl(url)) return null;
  const rest = url.slice(SESSION_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const blobId = rest.slice(0, slash);
  let filename: string;
  try {
    filename = decodeURIComponent(rest.slice(slash + 1));
  } catch {
    return null;
  }
  if (!filename) return null;
  return { blobId, filename };
}

/** Look up the underlying File. Returns null when the blob has been GC'd. */
export function getAttachmentFile(blobId: string): File | null {
  return blobs.get(blobId)?.file ?? null;
}

/** Return an object URL for previewing the blob. Memoized per blob. */
export function getAttachmentObjectUrl(blobId: string): string | null {
  const record = blobs.get(blobId);
  if (!record) return null;
  if (!record.objectUrl) record.objectUrl = URL.createObjectURL(record.file);
  return record.objectUrl;
}

function makeBlobId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

/**
 * Discord allows a wide set of characters in attachment filenames, but the
 * `attachment://` URL must not contain spaces or special URL chars. Replace
 * anything risky with an underscore so the wire reference matches the
 * multipart `filename=` we send. We do NOT URL-encode here — Discord expects
 * the literal filename.
 */
function sanitizeFilename(name: string): string {
  const trimmed = name.trim() || "file";
  return trimmed.replace(/[^\w.-]/g, "_");
}
