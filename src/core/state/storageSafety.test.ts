import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAiSettings } from "@/core/ai/settingsStorage";
import { loadCachedGuild } from "@/core/guild/cache";
import {
  hasGalleryEverAutoOpened,
  shouldAutoOpenGallery,
} from "@/features/templates/galleryAutoOpen";
import { welcomeAutoDecision } from "@/features/welcome/welcomeGate";
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
    // `App` reads this one inside a `useState` initializer, so a throw here
    // takes the whole app to the ErrorBoundary. Unreadable must read as
    // "never auto-opened" — the first-visit answer — which is also what keeps
    // the gallery (and with it `/`'s only rendered internal links) on screen
    // for a crawler whose storage is blocked rather than merely empty.
    expect(hasGalleryEverAutoOpened()).toBe(false);
    expect(shouldAutoOpenGallery()).toBe(true);
    // Read in the same render (useWelcomeAutoOpen's initializer). Unreadable
    // storage can't keep the one-time record, so the offer stands down rather
    // than recurring on every load.
    expect(welcomeAutoDecision()).toBe("no");
  });
});
