import { describe, expect, it } from "vitest";

import { otherTabsOpen, startTabPresence } from "./tabPresence";

describe("tab presence", () => {
  it("hears nobody when this is the only tab", async () => {
    startTabPresence();
    expect(await otherTabsOpen(60)).toBe(false);
  });

  it("hears another tab that answers", async () => {
    // A second channel on the same name plays the other tab: it answers pings
    // exactly as `startTabPresence` makes every tab do.
    const otherTab = new BroadcastChannel("dweeb-tab-presence");
    otherTab.onmessage = (event: MessageEvent<{ type: string; id: string }>) => {
      if (event.data.type === "ping") otherTab.postMessage({ type: "pong", id: event.data.id });
    };
    try {
      expect(await otherTabsOpen(500)).toBe(true);
    } finally {
      otherTab.close();
    }
  });
});
