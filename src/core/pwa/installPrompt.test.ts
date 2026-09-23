import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectInstallPlatform } from "./installPrompt";

/**
 * `detectInstallPlatform` picks which manual-install instructions the dialog
 * shows when the browser has no scriptable install prompt. The ordering of the
 * checks matters — every Chromium UA also claims "Safari", Edge also claims
 * "Chrome", and iPadOS masquerades as macOS — so the table is worth pinning.
 */

// Representative real-world UA strings (trimmed to the parts the detector reads).
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPADOS_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const ANDROID_FIREFOX = "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DESKTOP_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
const DESKTOP_FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";

describe("detectInstallPlatform", () => {
  it("detects iPhone Safari as iOS", () => {
    expect(detectInstallPlatform(IPHONE_SAFARI, 5)).toBe("ios");
  });

  it("detects iPadOS (macOS UA + touch points) as iOS", () => {
    // iPadOS 13+ reports a desktop-Safari UA; the touch-point count is the tell.
    expect(detectInstallPlatform(IPADOS_SAFARI, 5)).toBe("ios");
  });

  it("keeps a real Mac (no touch) on the Safari-mac path, not iOS", () => {
    expect(detectInstallPlatform(MAC_SAFARI, 0)).toBe("safari-mac");
  });

  it("detects Android Chrome as android", () => {
    expect(detectInstallPlatform(ANDROID_CHROME, 5)).toBe("android");
  });

  it("routes Android Firefox to android (menu install), not the desktop Firefox path", () => {
    expect(detectInstallPlatform(ANDROID_FIREFOX, 5)).toBe("android");
  });

  it("detects desktop Chrome as chromium", () => {
    expect(detectInstallPlatform(DESKTOP_CHROME, 0)).toBe("chromium");
  });

  it("detects Edge (also claims Chrome) as chromium", () => {
    expect(detectInstallPlatform(DESKTOP_EDGE, 0)).toBe("chromium");
  });

  it("detects desktop Firefox as firefox", () => {
    expect(detectInstallPlatform(DESKTOP_FIREFOX, 0)).toBe("firefox");
  });

  it("falls back to unknown for an unrecognized UA", () => {
    expect(detectInstallPlatform("some-random-bot/1.0", 0)).toBe("unknown");
  });
});

/**
 * The replay sequencing `InstallDialog` is built around: the captured event is
 * spent — and `canPrompt` drops, notifying subscribers — the moment the prompt
 * is replayed, *before* the browser's sheet resolves. The dialog holds its own
 * "prompting" state across that window; these pin the store side of it.
 */
describe("promptInstall sequencing", () => {
  /** A stand-in `window`: just the event target and media query the module reads. */
  function fakeWindow() {
    return Object.assign(new EventTarget(), {
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    });
  }

  /** Chromium's `beforeinstallprompt`, with a controllable prompt and choice. */
  function installEvent(prompt: () => Promise<unknown>) {
    let choose!: (outcome: "accepted" | "dismissed") => void;
    const userChoice = new Promise<{ outcome: "accepted" | "dismissed" }>((resolve) => {
      choose = (outcome) => resolve({ outcome });
    });
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: vi.fn(prompt),
      userChoice,
    });
    return { event, choose };
  }

  /** A fresh module (its capture state is module-level) wired to a fake window. */
  async function setup() {
    const win = fakeWindow();
    vi.stubGlobal("window", win);
    vi.stubGlobal("navigator", {});
    vi.resetModules();
    const mod = await import("./installPrompt");
    mod.captureInstallPrompt();
    return { win, ...mod };
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is unavailable until the browser offers a prompt", async () => {
    const { promptInstall, getInstallSnapshot } = await setup();
    expect(getInstallSnapshot()).toEqual({ installed: false, canPrompt: false });
    await expect(promptInstall()).resolves.toBe("unavailable");
  });

  it("captures the event, suppressing the browser's own promotion", async () => {
    const { win, getInstallSnapshot } = await setup();
    const { event } = installEvent(async () => {});
    win.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(getInstallSnapshot().canPrompt).toBe(true);
  });

  it("spends the event before the sheet resolves, so a snapshot reader must hold its own mode", async () => {
    const { win, promptInstall, getInstallSnapshot, subscribeInstall } = await setup();
    const { event, choose } = installEvent(async () => {});
    win.dispatchEvent(event);
    const seen: boolean[] = [];
    subscribeInstall(() => seen.push(getInstallSnapshot().canPrompt));

    const outcome = promptInstall();
    // Synchronously, while the browser's sheet is still up: the prompt is
    // replayed, and subscribers have already been told there's none to show.
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(getInstallSnapshot().canPrompt).toBe(false);
    expect(seen).toEqual([false]);

    choose("dismissed");
    await expect(outcome).resolves.toBe("dismissed");
  });

  it("never replays a spent event: a second call while the sheet is up is unavailable", async () => {
    const { win, promptInstall } = await setup();
    const { event, choose } = installEvent(async () => {});
    win.dispatchEvent(event);

    const first = promptInstall();
    await expect(promptInstall()).resolves.toBe("unavailable");
    expect(event.prompt).toHaveBeenCalledTimes(1);

    choose("accepted");
    await expect(first).resolves.toBe("accepted");
  });

  it("reports a prompt the browser refused as unavailable", async () => {
    const { win, promptInstall } = await setup();
    const { event } = installEvent(() => Promise.reject(new Error("NotAllowedError")));
    win.dispatchEvent(event);
    await expect(promptInstall()).resolves.toBe("unavailable");
  });

  it("marks the app installed and drops the prompt once an install completes", async () => {
    const { win, getInstallSnapshot } = await setup();
    const { event } = installEvent(async () => {});
    win.dispatchEvent(event);
    win.dispatchEvent(new Event("appinstalled"));
    expect(getInstallSnapshot()).toEqual({ installed: true, canPrompt: false });
  });
});
