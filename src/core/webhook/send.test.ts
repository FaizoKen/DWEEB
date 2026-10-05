import { afterEach, describe, expect, it, vi } from "vitest";

import { modifyWebhook, parseWebhookUrl, prepareMessagePayload, verifyWebhook } from "./send";
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

describe("verifyWebhook", () => {
  const WEBHOOK = parseWebhookUrl("https://discord.com/api/webhooks/123456789012345678/token-abc")!;
  const CANCELLED = { ok: false, status: 0, error: "Check was cancelled." };

  afterEach(() => vi.unstubAllGlobals());

  /** Discord's answer with its body cut short: the first bytes arrive, then the
   *  stream fails with whatever `cut` resolves to — what `text()` meets when the
   *  check is aborted, or the connection drops, after the headers. */
  function cutShort(cut: Promise<unknown>, status = 200): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"123456789012345678","name":"Rel'));
          void cut.then((reason) => controller.error(reason));
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  it("verifies a webhook when Discord hands back its object", async () => {
    const webhook = { id: "123456789012345678", name: "Releases", avatar: "a1b2", type: 1 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(webhook), { status: 200 })),
    );
    await expect(verifyWebhook(WEBHOOK)).resolves.toEqual({ ok: true, status: 200, webhook });
  });

  // The saved-webhook health check aborts its checks whenever the list changes.
  // One aborted between Discord's headers and its body used to count as
  // verified — with an empty webhook, which blanked the stored avatar and owner.
  it("reports a check aborted after the headers as cancelled, never as verified", async () => {
    const ac = new AbortController();
    const aborted = new Promise((resolve) =>
      ac.signal.addEventListener("abort", () => resolve(ac.signal.reason), { once: true }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => ac.abort(), 0);
        return cutShort(aborted);
      }),
    );
    await expect(verifyWebhook(WEBHOOK, { signal: ac.signal })).resolves.toEqual(CANCELLED);
  });

  it("reports a body lost to the network as a failed request, never as verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => cutShort(Promise.resolve(new TypeError("Failed to fetch")))),
    );
    const result = await verifyWebhook(WEBHOOK);
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(result.ok ? "" : result.error).toMatch(/^Network request failed/);
  });

  it("verifies nothing from a 2xx that isn't the webhook object", async () => {
    for (const body of [null, "<html>Sign in to continue</html>"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 200 })),
      );
      await expect(verifyWebhook(WEBHOOK)).resolves.toMatchObject({
        ok: false,
        status: 200,
        error: "Discord returned an unexpected 200 response.",
      });
    }
  });

  it("still reports a deleted webhook as gone when the error body is cut short", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => cutShort(Promise.resolve(new TypeError("Failed to fetch")), 404)),
    );
    await expect(verifyWebhook(WEBHOOK)).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: "Discord could not find that webhook (404). It may have been deleted.",
    });
  });
});

describe("modifyWebhook", () => {
  const WEBHOOK = parseWebhookUrl("https://discord.com/api/webhooks/123456789012345678/token-abc")!;

  afterEach(() => vi.unstubAllGlobals());

  it("returns the webhook Discord echoes after a rename", async () => {
    const webhook = { id: "123456789012345678", name: "Releases", avatar: "a1b2" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(webhook), { status: 200 })),
    );
    await expect(modifyWebhook(WEBHOOK, { name: "Releases" })).resolves.toEqual({
      ok: true,
      status: 200,
      webhook,
    });
  });

  // The manage dialog writes the echoed name and avatar over the saved entry, so
  // an unreadable 2xx used to arrive as an empty webhook and blank the avatar.
  it("never answers an unreadable 2xx with an empty webhook", async () => {
    for (const body of [null, "<html>Sign in to continue</html>"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 200 })),
      );
      const result = await modifyWebhook(WEBHOOK, { name: "Releases" });
      expect(result.ok).toBe(false);
    }
  });
});
