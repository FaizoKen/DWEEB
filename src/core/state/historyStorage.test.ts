import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComponentType, type WebhookMessage } from "@/core/schema";
import { loadHistory, saveHistory, type HistoryFrame } from "./historyStorage";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => void values.set(key, String(value)),
  removeItem: (key: string) => void values.delete(key),
} as unknown as Storage;

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const text = (content: string): WebhookMessage =>
  ({ components: [{ _id: "t", type: ComponentType.TextDisplay, content }] }) as WebhookMessage;

describe("history persistence", () => {
  it("keeps which steps swapped the document, never the origins they carried", () => {
    const past: HistoryFrame[] = [
      { message: text("edit") },
      {
        message: text("swapped"),
        replaced: true,
        origins: {
          restoredFrom: {
            webhookUrl: "https://discord.com/api/webhooks/1/secret-token",
            messageId: "2",
          },
          pendingEditOrigin: null,
        },
      },
    ];
    saveHistory(past, []);
    // The webhook URL is a credential: it never reaches storage.
    expect([...values.values()].join("")).not.toContain("secret-token");

    const loaded = loadHistory();
    expect(loaded?.past.map((f) => f.replaced ?? false)).toEqual([false, true]);
    expect(loaded?.past[1]?.origins).toBeUndefined();
    const revived = loaded?.past[1]?.message.components[0] as unknown as { content: string };
    expect(revived.content).toBe("swapped");
  });
});
