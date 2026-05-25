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
 *  - The registry lives in-memory only. A page reload loses every blob; any
 *    component pointing at a `session://` URL whose id no longer resolves is
 *    surfaced as "missing" in the inspector and validator.
 *  - Auto-save / share URLs strip `session://` references (see `draftStorage`
 *    and `encode`), since persisting a broken reference would just confuse a
 *    returning user.
 */

const SESSION_PREFIX = "session://";

interface BlobRecord {
  file: File;
  /** Lazy object URL for previews. Created on first call, revoked on free. */
  objectUrl?: string;
}

const blobs = new Map<string, BlobRecord>();
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

/** Subscribe to registry changes so React components can re-render on add/remove. */
export function subscribeAttachments(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Stable snapshot accessor for `useSyncExternalStore`. */
export function getAttachmentSnapshot(): Map<string, BlobRecord> {
  return blobs;
}

/** Register a new blob. Returns the session URL to store in editor state. */
export function registerAttachment(file: File): string {
  const id = makeBlobId();
  blobs.set(id, { file });
  notify();
  return buildSessionUrl(id, file.name);
}

/** Drop a blob and revoke its object URL, if any. */
export function forgetAttachment(blobId: string): void {
  const record = blobs.get(blobId);
  if (!record) return;
  if (record.objectUrl) URL.revokeObjectURL(record.objectUrl);
  blobs.delete(blobId);
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
  for (const id of Array.from(blobs.keys())) {
    if (live.has(id)) continue;
    const rec = blobs.get(id)!;
    if (rec.objectUrl) URL.revokeObjectURL(rec.objectUrl);
    blobs.delete(id);
    changed = true;
  }
  if (changed) notify();
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
  return trimmed.replace(/[^\w.\-]/g, "_");
}
