/**
 * Upload an avatar image to the proxy and get back the permanent public URL
 * that goes into `avatar_url`.
 *
 * Why the URL is resolved at *pick* time rather than at send time — the opposite
 * of how the editor treats every other upload (`session://` blobs, resolved to
 * multipart parts by `core/serialization/attachments.ts`):
 *
 *  - `avatar_url` is not a component media field. Discord's execute endpoint
 *    resolves `attachment://` only inside the message's components, so an
 *    avatar can never ride along in the multipart body — it has to already be a
 *    URL Discord can fetch.
 *  - Because the result is an ordinary `https://` URL, *every* downstream path
 *    keeps working untouched: send, scheduled posts (which fire hours later,
 *    server-side, with no browser around), the message library, share links,
 *    JSON export, and the Activity. A `session://` avatar would have broken all
 *    of those, since none of them can reach this browser's blob store.
 *
 * The cost of resolving early is an upload the user might never send. That is
 * bounded on the server by content-addressed dedupe (re-picking the same image
 * is free) and the row cap, so it isn't worth complicating the send path for.
 */

import { isProxyConfigured } from "@/core/guild/config";
import { proxyFetch } from "@/core/net/proxyFetch";
import { AVATAR_MAX_UPLOAD_BYTES, AvatarImageError, prepareAvatarImage } from "@/core/avatar/image";

export type AvatarUploadResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Process `file` in the browser, then store it on the proxy.
 *
 * The body is the raw image bytes rather than JSON or a data URL: base64 would
 * inflate the payload by a third and force both sides to hold a decoded copy,
 * for no benefit when the whole request is one binary blob.
 */
export async function uploadAvatarImage(
  file: File,
  signal?: AbortSignal,
): Promise<AvatarUploadResult> {
  if (!isProxyConfigured()) {
    return { ok: false, error: "Image uploads aren't available in this build." };
  }

  let blob: Blob;
  try {
    ({ blob } = await prepareAvatarImage(file));
  } catch (error) {
    if (error instanceof AvatarImageError) return { ok: false, error: error.message };
    return { ok: false, error: "Couldn't read that image. Try a different file." };
  }

  // Should be unreachable after downscaling — a 256² image is far under the cap
  // — but the check keeps a surprising encoder from producing a request the
  // server would only reject after the whole upload.
  if (blob.size > AVATAR_MAX_UPLOAD_BYTES) {
    return { ok: false, error: "That image is too complex to compress. Try a simpler one." };
  }

  let res: Response;
  try {
    res = await proxyFetch("/api/avatar", {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
      signal,
    });
  } catch (error) {
    if ((error as DOMException)?.name === "AbortError") {
      return { ok: false, error: "Cancelled." };
    }
    return { ok: false, error: "Upload failed. Check your connection and try again." };
  }

  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { url?: unknown } | null;
    if (typeof body?.url === "string" && body.url.length > 0) {
      return { ok: true, url: body.url };
    }
    return { ok: false, error: "Upload succeeded but returned no URL." };
  }

  // 401 is the common, actionable case: uploads are sign-in gated because the
  // endpoint would otherwise be a free image host.
  if (res.status === 401) {
    return { ok: false, error: "Sign in with Discord to upload an image." };
  }
  const text = await res.text().catch(() => "");
  let error = `Upload failed (${res.status}). Please try again.`;
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) error = body.error;
    } catch {
      /* keep the default message */
    }
  }
  return { ok: false, error };
}
