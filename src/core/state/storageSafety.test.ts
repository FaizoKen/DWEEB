import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAiSettings } from "@/core/ai/settingsStorage";
import { loadCachedGuild } from "@/core/guild/cache";
import { loadDraft } from "./draftStorage";
import { loadHistory } from "./historyStorage";

afterEach(() => vi.unstubAllGlobals());

describe("boot storage safety", () => {
  it("falls back when a browser exposes localStorage but blocks reads", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    expect(loadDraft()).toBeNull();
    expect(loadHistory()).toBeNull();
    expect(loadCachedGuild()).toBeNull();
    expect(loadAiSettings().provider).toBeTruthy();
  });
});
