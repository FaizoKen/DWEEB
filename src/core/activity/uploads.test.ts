/**
 * The post/update guard for uploads this browser doesn't hold — a teammate's
 * file synced into the shared draft, or one uploaded before a relaunch. Counts
 * distinct uploads (not references), looks only at media URLs, and says what's
 * true without claiming whose device the file is on.
 */

import { describe, expect, it } from "vitest";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";
import { buildSessionUrl, registerAttachment } from "@/core/state/attachmentStore";
import { missingUploadCount, missingUploadsMessage } from "./uploads";

const thumb = (id: string, url: string) => ({
  _id: id,
  type: ComponentType.Thumbnail,
  media: { url },
});

function draft(...urls: string[]): WebhookMessage {
  return {
    components: [
      {
        _id: "c",
        type: ComponentType.Container,
        components: [
          {
            _id: "s",
            type: ComponentType.Section,
            components: [
              { _id: "t", type: ComponentType.TextDisplay, content: "session://not/a-file" },
            ],
            accessory: thumb("a", urls[0] ?? "https://example.com/a.png"),
          },
          {
            _id: "g",
            type: ComponentType.MediaGallery,
            items: urls.slice(1).map((url, i) => ({ _id: `i${i}`, media: { url } })),
          },
        ],
      },
    ],
  } as unknown as WebhookMessage;
}

describe("missingUploadCount", () => {
  const theirs = buildSessionUrl("theirblob", "photo.png");
  const alsoTheirs = buildSessionUrl("otherblob", "clip.mp4");
  const mine = buildSessionUrl("myblob", "logo.png");
  const heldHere = (id: string) => id === "myblob";

  it("counts each upload this browser doesn't hold, once", () => {
    // `theirs` is referenced twice — still one file to ask about.
    expect(missingUploadCount(draft(theirs, theirs, alsoTheirs, mine), heldHere)).toBe(2);
  });

  it("is zero when every upload is here, or there are none", () => {
    expect(missingUploadCount(draft(mine), heldHere)).toBe(0);
    expect(missingUploadCount(draft("https://example.com/a.png"), heldHere)).toBe(0);
  });

  it("ignores text that merely mentions the session scheme", () => {
    // The TextDisplay above reads "session://not/a-file" — not a media URL.
    expect(missingUploadCount(draft(), () => false)).toBe(0);
  });

  it("reads this browser's upload registry by default", () => {
    const here = registerAttachment(new File(["x"], "here.png", { type: "image/png" }));
    expect(missingUploadCount(draft(here))).toBe(0);
    expect(missingUploadCount(draft(here, theirs))).toBe(1);
  });
});

describe("missingUploadsMessage", () => {
  it("names the cause and both ways out, without claiming whose device it's on", () => {
    expect(missingUploadsMessage(1)).toMatch(
      /^An uploaded file in this draft isn't in this browser/,
    );
    expect(missingUploadsMessage(3)).toMatch(
      /^3 uploaded files in this draft aren't in this browser/,
    );
    for (const text of [missingUploadsMessage(1), missingUploadsMessage(2)]) {
      expect(text).toMatch(/ask them to post/);
      expect(text).toMatch(/re-attach/);
    }
  });
});
