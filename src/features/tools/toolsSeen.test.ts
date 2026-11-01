import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readToolsUnseen, recordToolsSeen, TOOLS_REVISION } from "./toolsSeen";

const KEY = "dweeb.tools.seen.v1";

// Vitest runs in Node, which has no localStorage — stub a Map-backed one.
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
} as unknown as Storage;

function setStorage(value: Storage | undefined) {
  (globalThis as { localStorage?: Storage }).localStorage = value;
}

beforeEach(() => {
  store.clear();
  setStorage(localStorageStub);
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("toolsSeen", () => {
  it("shows the dot until the menu has been opened", () => {
    expect(readToolsUnseen()).toBe(true);
    recordToolsSeen();
    expect(readToolsUnseen()).toBe(false);
  });

  it("relights once when the revision moves past what this browser saw", () => {
    store.set(KEY, String(TOOLS_REVISION - 1));
    expect(readToolsUnseen()).toBe(true);
    recordToolsSeen();
    expect(store.get(KEY)).toBe(String(TOOLS_REVISION));
    expect(readToolsUnseen()).toBe(false);
  });

  it("shows no dot when storage can't be read, since nothing could ever clear it", () => {
    setStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    } as unknown as Storage);
    expect(readToolsUnseen()).toBe(false);

    setStorage(undefined);
    expect(readToolsUnseen()).toBe(false);
  });

  it("survives a write that fails", () => {
    setStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage);
    expect(() => recordToolsSeen()).not.toThrow();
  });
});
