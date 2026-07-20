import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyConfigured: true,
  proxyFetch: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("@/core/guild/config", () => ({
  isProxyConfigured: () => mocks.proxyConfigured,
}));
vi.mock("@/core/net/proxyFetch", () => ({
  proxyFetch: mocks.proxyFetch,
}));
// `prepareAvatarImage` needs a canvas, which the node test environment has no
// business providing; its own pure pieces are covered in `image.test.ts`.
vi.mock("@/core/avatar/image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image")>();
  return { ...actual, prepareAvatarImage: mocks.prepare };
});

import { AVATAR_MAX_UPLOAD_BYTES, AvatarImageError } from "./image";
import { uploadAvatarImage } from "./upload";

function pngBlob(size = 4096): Blob {
  return new Blob([new Uint8Array(size)], { type: "image/png" });
}

const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });

describe("avatar upload", () => {
  beforeEach(() => {
    mocks.proxyConfigured = true;
    mocks.proxyFetch.mockReset();
    mocks.prepare.mockReset();
    mocks.prepare.mockResolvedValue({ blob: pngBlob(), size: 256 });
  });

  it("posts the processed bytes and returns the public URL", async () => {
    const url = "https://api.example.com/api/avatar/abc.png";
    mocks.proxyFetch.mockResolvedValue(new Response(JSON.stringify({ url }), { status: 201 }));

    const result = await uploadAvatarImage(file);

    expect(result).toEqual({ ok: true, url });
    const [path, init] = mocks.proxyFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/avatar");
    expect(init.method).toBe("POST");
    // Raw bytes, not JSON/base64 — base64 would inflate the body by a third.
    expect(init.body).toBeInstanceOf(Blob);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/png");
  });

  it("never uploads when the browser could not process the image", async () => {
    mocks.prepare.mockRejectedValue(new AvatarImageError("That image is too small."));

    const result = await uploadAvatarImage(file);

    expect(result).toEqual({ ok: false, error: "That image is too small." });
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it("refuses a blob over the cap before spending the request", async () => {
    mocks.prepare.mockResolvedValue({
      blob: pngBlob(AVATAR_MAX_UPLOAD_BYTES + 1),
      size: 256,
    });

    const result = await uploadAvatarImage(file);

    expect(result.ok).toBe(false);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it("turns the sign-in gate into actionable copy", async () => {
    // Uploads are session-gated so the endpoint can't be a free image host;
    // a signed-out user must be told that, not shown a bare 401.
    mocks.proxyFetch.mockResolvedValue(new Response(null, { status: 401 }));

    const result = await uploadAvatarImage(file);

    expect(result).toEqual({ ok: false, error: "Sign in with Discord to upload an image." });
  });

  it("surfaces the server's own message for a rejected image", async () => {
    mocks.proxyFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Avatar storage is full — paste an image URL instead." }),
        {
          status: 503,
        },
      ),
    );

    const result = await uploadAvatarImage(file);

    expect(result).toEqual({
      ok: false,
      error: "Avatar storage is full — paste an image URL instead.",
    });
  });

  it("reports a 2xx with no URL as a failure rather than a silent success", async () => {
    // Returning ok:true here would leave the field empty with no explanation.
    mocks.proxyFetch.mockResolvedValue(new Response("{}", { status: 201 }));

    const result = await uploadAvatarImage(file);

    expect(result.ok).toBe(false);
  });

  it("does not call the proxy when the build has none configured", async () => {
    mocks.proxyConfigured = false;

    const result = await uploadAvatarImage(file);

    expect(result.ok).toBe(false);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });
});
