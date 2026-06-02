/**
 * IndexedDB persistence for uploaded attachment blobs.
 *
 * The in-memory attachment registry (`attachmentStore`) keys `File` handles by
 * an opaque `blobId`, and the editor state / draft references them through
 * `session://<blobId>/<filename>` URLs. The draft (localStorage) preserves the
 * *reference*, but a `File`'s *bytes* aren't JSON-serializable — so before this
 * layer existed, every upload was lost on reload and surfaced as "missing".
 *
 * This module persists the bytes alongside the draft so a returning user keeps
 * their uploads: on startup `attachmentStore.hydrateAttachments()` reads every
 * stored blob back into the in-memory map, re-connecting the `session://` URLs
 * the draft restored. The store writes through here on register / forget / GC.
 *
 * Everything is best-effort: IndexedDB can be unavailable (private windows,
 * disabled storage, quota). Every call resolves rather than rejects, so a
 * failure degrades gracefully to the prior in-memory-only behaviour.
 */

const DB_NAME = "dwb-attachments";
const DB_VERSION = 1;
const STORE = "blobs";

/**
 * Stored as discrete fields rather than the raw `File` because some engines
 * historically dropped a `File`'s `name`/`type` through structured clone.
 * Reconstituting a `File` on load keeps `record.file.name` working everywhere.
 */
interface StoredBlob {
  id: string;
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
  savedAt: number;
}

function dbUnavailable(): boolean {
  return typeof indexedDB === "undefined";
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbUnavailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // A blocked open (older connection holding the DB at a lower version)
    // would otherwise hang the promise forever.
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/**
 * Run `fn` inside a transaction, resolving to its request result or a fallback.
 * `fn` returns an untyped `IDBRequest` (the DOM types make `IDBRequest<T>`
 * invariant, so the various `put`/`getAll` return shapes don't unify); the
 * result is coerced to `T` on the way out.
 */
function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | null,
  fallback: T,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve) => {
        if (!db) {
          resolve(fallback);
          return;
        }
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, mode);
        } catch {
          resolve(fallback);
          return;
        }
        let result = fallback;
        const req = fn(tx.objectStore(STORE));
        if (req) req.onsuccess = () => (result = req.result as T);
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => resolve(fallback);
      }),
  );
}

function toFile(record: StoredBlob): File {
  return new File([record.blob], record.name, {
    type: record.type,
    lastModified: record.lastModified,
  });
}

/** Persist a single upload. Resolves once the write commits (or is dropped). */
export function putAttachmentBlob(id: string, file: File): Promise<void> {
  const record: StoredBlob = {
    id,
    blob: file,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    savedAt: Date.now(),
  };
  return withStore<unknown>("readwrite", (store) => store.put(record), null).then(() => undefined);
}

/** Drop a single persisted upload. */
export function deleteAttachmentBlob(id: string): Promise<void> {
  return withStore<unknown>("readwrite", (store) => store.delete(id), null).then(() => undefined);
}

/** Drop several persisted uploads in one transaction. No-op on an empty list. */
export function deleteAttachmentBlobs(ids: Iterable<string>): Promise<void> {
  const list = Array.from(ids);
  if (list.length === 0) return Promise.resolve();
  return openDb().then((db) => {
    if (!db) return;
    return new Promise<void>((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE, "readwrite");
      } catch {
        resolve();
        return;
      }
      const store = tx.objectStore(STORE);
      for (const id of list) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => resolve();
    });
  });
}

/** Read every persisted upload back as `{ id, file }`. Returns [] on failure. */
export function loadAllAttachmentBlobs(): Promise<Array<{ id: string; file: File }>> {
  return withStore<StoredBlob[]>(
    "readonly",
    (store) => store.getAll() as IDBRequest<StoredBlob[]>,
    [],
  ).then((records) =>
    records
      .filter((r): r is StoredBlob => !!r && typeof r.id === "string" && r.blob instanceof Blob)
      .map((r) => ({ id: r.id, file: toFile(r) })),
  );
}
