import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadHistory, rememberWebhook } from "./history";

const values = new Map<string, string>();
let readsFail = false;
let writesFail = false;

const storage = {
  getItem: (key: string) => {
    if (readsFail) throw new DOMException("Storage blocked", "SecurityError");
    return values.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    if (writesFail) throw new DOMException("Storage full", "QuotaExceededError");
    values.set(key, String(value));
  },
  removeItem: (key: string) => void values.delete(key),
  clear: () => values.clear(),
} as unknown as Storage;

const WEBHOOK_URL = "https://discord.com/api/webhooks/123456789/example-token";

beforeEach(() => {
  values.clear();
  readsFail = false;
  writesFail = false;
  (globalThis as { localStorage?: Storage }).localStorage = storage;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("webhook history persistence", () => {
  it("round-trips a persisted recent webhook", () => {
    expect(rememberWebhook(WEBHOOK_URL, { name: "Updates" })).toMatchObject({
      id: "123456789",
      name: "Updates",
    });
    expect(loadHistory()).toHaveLength(1);
  });

  it("never throws when an optional history write fails", () => {
    writesFail = true;

    expect(() => rememberWebhook(WEBHOOK_URL)).not.toThrow();
    expect(rememberWebhook(WEBHOOK_URL)).toBeNull();
    expect(loadHistory()).toEqual([]);
  });

  it("treats blocked storage reads as an empty optional history", () => {
    readsFail = true;
    expect(loadHistory()).toEqual([]);
    expect(() => rememberWebhook(WEBHOOK_URL)).not.toThrow();
  });

  it("drops tampered non-Discord credentials at the storage boundary", () => {
    values.set(
      "dweeb.webhook_history.v1",
      JSON.stringify([
        {
          id: "123456789",
          url: "https://attacker.example/api/webhooks/123456789/stolen",
          name: "Looks saved",
          lastUsedAt: Date.now(),
        },
      ]),
    );

    expect(loadHistory()).toEqual([]);
  });
});
