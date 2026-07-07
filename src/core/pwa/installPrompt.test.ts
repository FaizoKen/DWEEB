import { describe, expect, it } from "vitest";
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
