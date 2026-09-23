import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimAddBotPrompt } from "./addBotPrompt";

// Vitest runs in Node, which has no localStorage — stub a Map-backed one.
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
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

describe("claimAddBotPrompt", () => {
  it("lets the prompt open once per user, not on every load", () => {
    expect(claimAddBotPrompt("111")).toBe(true);
    expect(claimAddBotPrompt("111")).toBe(false);
    expect(claimAddBotPrompt("111")).toBe(false);
  });

  it("gives a different account signing in on the same browser its own first prompt", () => {
    expect(claimAddBotPrompt("111")).toBe(true);
    expect(claimAddBotPrompt("222")).toBe(true);
    expect(claimAddBotPrompt("222")).toBe(false);
  });

  it("never opens automatically when storage is missing", () => {
    setStorage(undefined);
    expect(claimAddBotPrompt("111")).toBe(false);
  });

  it("never opens automatically when storage is blocked (getItem throws)", () => {
    setStorage({
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as Storage);
    expect(claimAddBotPrompt("111")).toBe(false);
  });

  it("never opens automatically when the record can't be written back", () => {
    setStorage({
      getItem: () => null,
      setItem: () => {},
    } as unknown as Storage);
    expect(claimAddBotPrompt("111")).toBe(false);
  });
});
