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

describe("webhook history trimming", () => {
  const hook = (n: number) =>
    `https://discord.com/api/webhooks/9000000000000000${String(n).padStart(2, "0")}/t-${n}`;
  const customBot = { ownerKind: "bot" as const, applicationId: "800000000000000001" };
  const person = { ownerKind: "user" as const };

  it("keeps a custom bot's webhook — its only token copy — past five ordinary entries", () => {
    rememberWebhook(hook(0), customBot);
    for (let i = 1; i <= 5; i++) rememberWebhook(hook(i), person);
    const ids = loadHistory().map((e) => e.id);
    expect(ids).toHaveLength(6);
    expect(ids).toContain("900000000000000000");
  });

  it("still evicts entries a server list can hand back", () => {
    for (let i = 0; i < 7; i++) rememberWebhook(hook(i), person);
    expect(loadHistory()).toHaveLength(5);
    expect(loadHistory().some((e) => e.id === "900000000000000000")).toBe(false);
  });

  it("bounds how many token-only entries outlive the recent five", () => {
    for (let i = 0; i < 20; i++) rememberWebhook(hook(i), customBot);
    expect(loadHistory()).toHaveLength(15);
  });
});
