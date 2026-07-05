import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The gate runs against `localStorage`, which Vitest's node environment lacks —
 * stub a minimal Map-backed one so the decision logic (not the browser) is
 * what's under test. Keys touched: the welcome record itself, the gallery's
 * auto-open stamp, and the editor draft (both read as "evidence of prior use").
 */
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
} as unknown as Storage;

import { readWelcomeRecord, welcomeAutoDecision, writeWelcomeRecord } from "./welcomeGate";

const GALLERY_STAMP_KEY = "dweeb.gallery.lastAutoOpen.v1";
const DRAFT_KEY = "dweeb.draft.v1";
const WELCOME_KEY = "dweeb.welcome.v1";

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: Storage }).localStorage = localStorageStub;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("welcomeAutoDecision", () => {
  it("shows the film on a clean slate (genuine first visit)", () => {
    expect(welcomeAutoDecision()).toBe("show");
  });

  it("announces instead of showing when the gallery has auto-opened before", () => {
    store.set(GALLERY_STAMP_KEY, String(Date.now()));
    expect(welcomeAutoDecision()).toBe("announce");
  });

  it("announces instead of showing when a saved draft exists", () => {
    store.set(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), payload: { components: [] } }));
    expect(welcomeAutoDecision()).toBe("announce");
  });

  it("never fires again once any record exists — shown or announced", () => {
    for (const status of ["shown", "announced"] as const) {
      writeWelcomeRecord(status);
      expect(welcomeAutoDecision()).toBe("no");
    }
  });

  it("a record wins over prior-use evidence", () => {
    store.set(GALLERY_STAMP_KEY, String(Date.now()));
    writeWelcomeRecord("announced");
    expect(welcomeAutoDecision()).toBe("no");
  });

  it("treats a corrupt record as absent rather than throwing", () => {
    store.set(WELCOME_KEY, "{not json");
    expect(welcomeAutoDecision()).toBe("show");
    store.set(WELCOME_KEY, JSON.stringify({ status: "hacked", at: "later" }));
    expect(welcomeAutoDecision()).toBe("show");
  });
});

describe("welcome record round-trip", () => {
  it("reads back what was written", () => {
    writeWelcomeRecord("shown");
    const record = readWelcomeRecord();
    expect(record?.status).toBe("shown");
    expect(typeof record?.at).toBe("number");
  });

  it("returns null with storage unavailable, and writes are no-ops", () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(readWelcomeRecord()).toBeNull();
    expect(() => writeWelcomeRecord("shown")).not.toThrow();
    expect(welcomeAutoDecision()).toBe("show");
  });
});
