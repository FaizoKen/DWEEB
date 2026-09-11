import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA, defaultMediaPreviewUrl } from "./defaultMedia";

describe("default image previews", () => {
  it("uses display variants for owned samples while leaving exported URLs alone", () => {
    expect(defaultMediaPreviewUrl(DEFAULT_MEDIA.welcomeBanner)).toBe(
      DEFAULT_MEDIA.welcomeBanner.replace(/\.jpg$/, ".webp"),
    );
    expect(DEFAULT_MEDIA.welcomeBanner).toMatch(/\.jpg$/);
  });

  it("never rewrites user URLs, signed URLs or local attachments", () => {
    for (const url of [
      "https://example.com/media/defaults/dweeb-welcome-banner.jpg",
      `${DEFAULT_MEDIA.welcomeBanner}?signature=test`,
      "session://sample/photo.jpg",
      "attachment://photo.jpg",
      "",
    ])
      expect(defaultMediaPreviewUrl(url)).toBe(url);
  });
});
