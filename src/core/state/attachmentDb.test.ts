/**
 * Guards the upload-persistence startup contract: `loadAttachmentBlobs` must
 * restore exactly the reachable blobs and prune every orphan key in the same
 * pass — without `IDBCursor.delete()` on its key-only cursor. That call throws
 * `InvalidStateError` ("The cursor is a key cursor"), and since the throw
 * happens inside the cursor's success handler it aborts the whole transaction.
 * v1.0.0 shipped exactly that: any returning user with one orphaned upload got
 * a crash beacon AND lost hydration of their still-referenced uploads.
 *
 * Runs against `fake-indexeddb`, which enforces the spec's key-cursor
 * restriction, so a regression fails here instead of in production.
 */
import { describe, expect, it, vi } from "vitest";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

type AttachmentDb = typeof import("./attachmentDb");

/** Fresh module state (the DB handle is cached per module) + an empty database. */
async function freshDb(): Promise<AttachmentDb> {
  vi.resetModules();
  globalThis.indexedDB = new FakeIDBFactory() as unknown as IDBFactory;
  return import("./attachmentDb");
}

function upload(id: string, name: string, content: string): { id: string; file: File } {
  return {
    id,
    file: new File([content], name, { type: "text/plain", lastModified: 1_700_000_000_000 }),
  };
}

describe("attachmentDb", () => {
  it("round-trips persisted uploads by id", async () => {
    const db = await freshDb();
    await db.putAttachmentBlobs([upload("a", "a.txt", "alpha"), upload("b", "b.png", "beta")]);

    const restored = await db.loadAttachmentBlobs(["a", "b"]);
    expect(restored.map((r) => r.id).sort()).toEqual(["a", "b"]);
    const a = restored.find((r) => r.id === "a");
    expect(a?.file.name).toBe("a.txt");
    expect(a?.file.type).toBe("text/plain");
    expect(a?.file.lastModified).toBe(1_700_000_000_000);
    expect(await a?.file.text()).toBe("alpha");
  });

  it("prunes an orphan key without losing the live blobs in the same transaction", async () => {
    const db = await freshDb();
    await db.putAttachmentBlobs([
      upload("keep", "keep.txt", "still referenced"),
      upload("stale", "stale.bin", "orphaned upload"),
    ]);

    // The v1.0.0 regression: the orphan's delete threw inside the cursor
    // callback, aborted the transaction, and this came back [] instead.
    const restored = await db.loadAttachmentBlobs(["keep"]);
    expect(restored.map((r) => r.id)).toEqual(["keep"]);
    expect(await restored.find((r) => r.id === "keep")?.file.text()).toBe("still referenced");

    // The orphan row is really gone: asking for it afterwards finds nothing.
    const second = await db.loadAttachmentBlobs(["keep", "stale"]);
    expect(second.map((r) => r.id)).toEqual(["keep"]);
  });

  it("clears the whole store when nothing is reachable", async () => {
    const db = await freshDb();
    await db.putAttachmentBlobs([upload("a", "a.txt", "x"), upload("b", "b.txt", "y")]);

    expect(await db.loadAttachmentBlobs([])).toEqual([]);
    expect(await db.loadAttachmentBlobs(["a", "b"])).toEqual([]);
  });

  it("resolves empty instead of rejecting when IndexedDB is unavailable", async () => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "indexedDB");
    const db: AttachmentDb = await import("./attachmentDb");

    await expect(db.loadAttachmentBlobs(["a"])).resolves.toEqual([]);
    await expect(db.putAttachmentBlob("a", new File(["x"], "a.txt"))).resolves.toBeUndefined();
  });
});
