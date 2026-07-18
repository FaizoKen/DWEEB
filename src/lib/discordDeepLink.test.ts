/**
 * The desktop "open in app" race in `openDiscordLink` is timing-sensitive and
 * shipped a dual-open bug once: the web fallback fired at 800 ms while the
 * (cold-starting) desktop app was still coming up, so the user got the app
 * *and* a web tab. These tests pin the behaviour that prevents it: a blur at
 * any point during the grace period cancels the fallback, the grace period on
 * non-WebKit desktops is long enough for a slow app handoff, and repeat clicks
 * supersede the pending race instead of stacking extra fallback tabs.
 *
 * The suite runs in Node (no jsdom), so the browser surface the module touches
 * is stubbed explicitly — which also documents exactly what it relies on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordAppUrl, handleDiscordLinkClick, openDiscordLink } from "@/lib/discordDeepLink";

const CHROME_WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SAFARI_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const WEB_URL = "https://discord.com/channels/111/222/333";
const APP_URL = "discord://-/channels/111/222/333";

function makeEventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(type: string, fn: () => void) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
  };
}

function stubBrowser({ userAgent = CHROME_WINDOWS_UA }: { userAgent?: string } = {}) {
  const open = vi.fn((...args: unknown[]): { opener: unknown } | null => {
    void args;
    return { opener: null };
  });
  const win = Object.assign(makeEventTarget(), {
    location: { href: "" },
    open,
    // Delegate to the (fake-timer-patched) globals at call time.
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as Parameters<typeof clearTimeout>[0]),
  });
  const doc = Object.assign(makeEventTarget(), {
    hidden: false,
    focused: true,
    hasFocus() {
      return this.focused;
    },
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints: 0 });
  return { win, doc, open };
}

describe("discordAppUrl", () => {
  it("maps channel links to the app scheme", () => {
    expect(discordAppUrl(WEB_URL)).toBe(APP_URL);
    expect(discordAppUrl("https://ptb.discord.com/channels/1/2")).toBe("discord://-/channels/1/2");
  });

  it("returns null for anything that is not a plain channel link", () => {
    expect(discordAppUrl("https://discord.com/invite/abc")).toBeNull();
    expect(discordAppUrl("https://discord.com/channels/1/2?x=1")).toBeNull();
    expect(discordAppUrl("https://example.com/channels/1/2")).toBeNull();
  });
});

describe("openDiscordLink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Drain any pending race so module-level state resets between tests.
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the web link directly on mobile, without touching the app scheme", () => {
    const { win, open } = stubBrowser({ userAgent: ANDROID_UA });
    openDiscordLink(WEB_URL);
    expect(open).toHaveBeenCalledWith(WEB_URL, "_blank");
    expect(win.location.href).toBe("");
  });

  it("navigates the current tab when the popup is blocked", () => {
    const { win, open } = stubBrowser({ userAgent: ANDROID_UA });
    open.mockReturnValueOnce(null);
    openDiscordLink(WEB_URL);
    expect(win.location.href).toBe(WEB_URL);
  });

  it("falls back to the web link only after the full grace period", () => {
    const { win, open } = stubBrowser();
    openDiscordLink(WEB_URL);
    expect(win.location.href).toBe(APP_URL);
    // The old 800 ms deadline lost to slow app handoffs — it must be gone.
    vi.advanceTimersByTime(800);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1700);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(WEB_URL, "_blank");
  });

  it("never opens the web link when the app takes focus late (dual-open regression)", () => {
    const { win, open } = stubBrowser();
    openDiscordLink(WEB_URL);
    // App cold start: focus is stolen well after the old 800 ms deadline.
    vi.advanceTimersByTime(1500);
    win.fire("blur");
    vi.runAllTimers();
    expect(open).not.toHaveBeenCalled();
  });

  it("treats the page going hidden as an app handoff", () => {
    const { doc, open } = stubBrowser();
    openDiscordLink(WEB_URL);
    doc.hidden = true;
    doc.fire("visibilitychange");
    vi.runAllTimers();
    expect(open).not.toHaveBeenCalled();
  });

  it("skips the fallback when the page is no longer focused at the deadline", () => {
    const { doc, open } = stubBrowser();
    openDiscordLink(WEB_URL);
    doc.focused = false;
    vi.runAllTimers();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens at most one web tab for an impatient double click", () => {
    const { open } = stubBrowser();
    openDiscordLink(WEB_URL);
    vi.advanceTimersByTime(400);
    openDiscordLink(WEB_URL);
    vi.runAllTimers();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps the sub-second deadline WebKit's popup gate demands", () => {
    const { open } = stubBrowser({ userAgent: SAFARI_MAC_UA });
    openDiscordLink(WEB_URL);
    vi.advanceTimersByTime(800);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("handleDiscordLinkClick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function click(overrides: Partial<Parameters<typeof handleDiscordLinkClick>[0]> = {}) {
    return {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: vi.fn(),
      ...overrides,
    };
  }

  it("leaves modified clicks to the browser", () => {
    const { win } = stubBrowser();
    const e = click({ ctrlKey: true });
    handleDiscordLinkClick(e, WEB_URL);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(win.location.href).toBe("");
  });

  it("hijacks a plain left click into the app attempt", () => {
    const { win } = stubBrowser();
    const e = click();
    handleDiscordLinkClick(e, WEB_URL);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(win.location.href).toBe(APP_URL);
  });
});
