import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WebhookMessage } from "@/core/schema";
import { useSavedMessagesStore } from "./savedMessagesStore";

const values = new Map<string, string>();
let writesFail = false;

const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (writesFail) throw new DOMException("Storage is full", "QuotaExceededError");
    values.set(key, String(value));
  },
  removeItem: (key: string) => void values.delete(key),
  clear: () => values.clear(),
} as unknown as Storage;

const message: WebhookMessage = { components: [] };

beforeEach(() => {
  values.clear();
  writesFail = false;
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  useSavedMessagesStore.setState({ entries: [] });
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
  useSavedMessagesStore.setState({ entries: [] });
});

describe("saved message durability", () => {
  it("reports success only after localStorage accepts the record", () => {
    const result = useSavedMessagesStore.getState().save("Release note", message);

    expect(result.ok).toBe(true);
    expect(useSavedMessagesStore.getState().entries).toHaveLength(1);
    expect(Array.from(values.values()).join("")).toContain("Release note");
  });

  it("reports a failed save and leaves no ephemeral in-memory entry", () => {
    writesFail = true;

    const result = useSavedMessagesStore.getState().save("Not durable", message);

    expect(result).toMatchObject({ ok: false });
    expect(useSavedMessagesStore.getState().entries).toEqual([]);
  });

  it("does not make a failed delete reappear only after reload", () => {
    expect(useSavedMessagesStore.getState().save("Keep me", message).ok).toBe(true);
    const [entry] = useSavedMessagesStore.getState().entries;
    writesFail = true;

    expect(useSavedMessagesStore.getState().remove(entry!.id)).toBe(false);
    expect(useSavedMessagesStore.getState().entries).toEqual([entry]);
  });
});
