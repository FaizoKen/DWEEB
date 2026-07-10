import { describe, expect, it } from "vitest";

import { prepareMessagePayload } from "./send";
import { registerAttachment } from "@/core/state/attachmentStore";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";
import { stripEditorFields } from "@/core/serialization/normalize";

/** A message whose gallery points at the given media URLs. */
function galleryMessage(...urls: string[]): WebhookMessage {
  return {
    components: [
      {
        _id: "gal",
        type: ComponentType.MediaGallery,
        items: urls.map((url, i) => ({ _id: `item-${i}`, media: { url } })),
      },
    ],
  };
}

type WirePayload = {
  components: Array<{ items: Array<{ media: { url: string } }> }>;
  attachments?: Array<{ id: number; filename: string }>;
};

describe("prepareMessagePayload", () => {
  it("passes a file-less message through as the plain wire payload", () => {
    const message = galleryMessage("https://example.com/pic.png");
    const { payload, files } = prepareMessagePayload(message);
    expect(files).toEqual([]);
    expect(payload).toEqual(stripEditorFields(message));
    expect("attachments" in payload).toBe(false);
  });

  it("rewrites session uploads to attachment:// refs with a matching attachments map", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const sessionUrl = registerAttachment(file);
    const message = galleryMessage(sessionUrl, "https://example.com/pic.png");

    const { payload, files } = prepareMessagePayload(message);
    const wire = payload as WirePayload;

    expect(files).toHaveLength(1);
    expect(files[0]!.file).toBe(file);
    expect(files[0]!.filename).toBe("shot.png");
    // The payload's attachments array maps multipart part index → filename, so
    // Discord can resolve the components' attachment:// references. The ids
    // must be the files[] positions the request body will use.
    expect(wire.attachments).toEqual([{ id: 0, filename: "shot.png" }]);
    expect(wire.components[0]!.items[0]!.media.url).toBe("attachment://shot.png");
    // External URLs ride through untouched.
    expect(wire.components[0]!.items[1]!.media.url).toBe("https://example.com/pic.png");
  });

  it("dedupes repeated references to one blob into a single file part", () => {
    const file = new File([new Uint8Array([9])], "logo.png", { type: "image/png" });
    const sessionUrl = registerAttachment(file);
    const message = galleryMessage(sessionUrl, sessionUrl);

    const { payload, files } = prepareMessagePayload(message);
    const wire = payload as WirePayload;

    expect(files).toHaveLength(1);
    expect(wire.attachments).toEqual([{ id: 0, filename: "logo.png" }]);
    expect(wire.components[0]!.items.map((i) => i.media.url)).toEqual([
      "attachment://logo.png",
      "attachment://logo.png",
    ]);
  });
});
