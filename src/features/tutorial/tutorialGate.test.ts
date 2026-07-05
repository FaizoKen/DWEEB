import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The gate runs against `localStorage`, which Vitest's node environment lacks —
 * stub a minimal Map-backed one so the decision logic (not the browser) is
 * what's under test. Keys touched: the tour's own record, the gallery's
 * auto-open stamp, and the editor draft (both read as "evidence of prior use").
 */
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
} as unknown as Storage;

import { readTutorialRecord, tutorialAutoDecision, writeTutorialRecord } from "./tutorialGate";

const GALLERY_STAMP_KEY = "dweeb.gallery.lastAutoOpen.v1";
const DRAFT_KEY = "dweeb.draft.v1";
const TUTORIAL_KEY = "dweeb.tutorial.v1";

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: Storage }).localStorage = localStorageStub;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("tutorialAutoDecision", () => {
  it("starts on a clean slate (genuine first visit)", () => {
    expect(tutorialAutoDecision()).toBe("start");
  });

  it("announces instead of starting when the gallery has auto-opened before", () => {
    store.set(GALLERY_STAMP_KEY, String(Date.now()));
    expect(tutorialAutoDecision()).toBe("announce");
  });

  it("announces instead of starting when a saved draft exists", () => {
    store.set(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), payload: { components: [] } }));
    expect(tutorialAutoDecision()).toBe("announce");
  });

  it("never fires again once any record exists — done, skipped, started, or announced", () => {
    for (const status of ["done", "skipped", "started", "announced"] as const) {
      writeTutorialRecord(status);
      expect(tutorialAutoDecision()).toBe("no");
    }
  });

  it("a record wins over prior-use evidence", () => {
    store.set(GALLERY_STAMP_KEY, String(Date.now()));
    writeTutorialRecord("announced");
    expect(tutorialAutoDecision()).toBe("no");
  });

  it("treats a corrupt record as absent rather than throwing", () => {
    store.set(TUTORIAL_KEY, "{not json");
    expect(tutorialAutoDecision()).toBe("start");
    store.set(TUTORIAL_KEY, JSON.stringify({ status: "hacked", at: "later" }));
    expect(tutorialAutoDecision()).toBe("start");
  });
});

describe("tutorial record round-trip", () => {
  it("reads back what was written, including the skip step", () => {
    writeTutorialRecord("skipped", 2);
    const record = readTutorialRecord();
    expect(record?.status).toBe("skipped");
    expect(record?.step).toBe(2);
    expect(typeof record?.at).toBe("number");
  });

  it("returns null with storage unavailable, and writes are no-ops", () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(readTutorialRecord()).toBeNull();
    expect(() => writeTutorialRecord("done")).not.toThrow();
    expect(tutorialAutoDecision()).toBe("start");
  });
});
