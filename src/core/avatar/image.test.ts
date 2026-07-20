import { describe, expect, it } from "vitest";
import {
  AVATAR_TARGET_SIZE,
  PNG_SIZE_BUDGET,
  chooseEncoding,
  hasTransparency,
  squareCropRect,
  targetSize,
} from "./image";

/**
 * The canvas work in `prepareAvatarImage` needs a DOM, but everything that
 * could silently produce a *wrong-looking avatar in Discord* is pure and lives
 * here: the crop geometry, the no-upscale rule, and the PNG/JPEG policy.
 */

describe("squareCropRect", () => {
  it("centers the crop on the long axis", () => {
    // Landscape: trim equally from left and right.
    expect(squareCropRect(1000, 400)).toEqual({ sx: 300, sy: 0, size: 400 });
    // Portrait: trim equally from top and bottom.
    expect(squareCropRect(400, 1000)).toEqual({ sx: 0, sy: 300, size: 400 });
  });

  it("leaves an already-square image untouched", () => {
    expect(squareCropRect(512, 512)).toEqual({ sx: 0, sy: 0, size: 512 });
  });

  it("keeps the offset an integer on odd differences", () => {
    // A fractional source offset would make `drawImage` resample the whole
    // image off-grid and soften it for no reason.
    const rect = squareCropRect(101, 50);
    expect(Number.isInteger(rect.sx)).toBe(true);
    expect(rect).toEqual({ sx: 25, sy: 0, size: 50 });
  });
});

describe("targetSize", () => {
  it("downscales anything larger than the target", () => {
    expect(targetSize(4000)).toBe(AVATAR_TARGET_SIZE);
    expect(targetSize(AVATAR_TARGET_SIZE + 1)).toBe(AVATAR_TARGET_SIZE);
  });

  it("never upscales a small source", () => {
    // Blowing a 64px icon up to 256 adds bytes and blur but no detail.
    expect(targetSize(64)).toBe(64);
    expect(targetSize(AVATAR_TARGET_SIZE)).toBe(AVATAR_TARGET_SIZE);
  });
});

describe("hasTransparency", () => {
  it("detects a single non-opaque pixel", () => {
    const opaque = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(hasTransparency(opaque)).toBe(false);

    const withAlpha = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]);
    expect(hasTransparency(withAlpha)).toBe(true);
  });

  it("treats an empty buffer as opaque", () => {
    expect(hasTransparency(new Uint8ClampedArray([]))).toBe(false);
  });
});

describe("chooseEncoding", () => {
  it("always keeps PNG when the image has transparency", () => {
    // JPEG has no alpha channel: a transparent logo would flatten to a black
    // square inside Discord's circular avatar crop. Size never overrides this.
    expect(chooseEncoding({ transparent: true, pngBytes: PNG_SIZE_BUDGET * 10 })).toEqual({
      mime: "image/png",
    });
  });

  it("keeps PNG for opaque images that are already small", () => {
    expect(chooseEncoding({ transparent: false, pngBytes: 1024 })).toEqual({ mime: "image/png" });
  });

  it("falls back to JPEG for a large opaque image", () => {
    // Photos at 256² can push PNG past the upload cap; JPEG holds them in a
    // few tens of KiB. Without this branch those uploads would be rejected.
    const encoding = chooseEncoding({ transparent: false, pngBytes: PNG_SIZE_BUDGET + 1 });
    expect(encoding.mime).toBe("image/jpeg");
  });

  it("switches formats before reaching the upload cap, not after", () => {
    // The budget exists so the JPEG path engages while the request would still
    // have been accepted — a budget at/above the cap would rescue nothing.
    expect(PNG_SIZE_BUDGET).toBeLessThan(128 * 1024);
  });
});
