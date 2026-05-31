/**
 * Classify a media source as image or video so preview renderers can pick the
 * right element (`<img>` vs `<video>`). Discord renders both inline in Files
 * and Media Galleries, so the builder preview must too — otherwise a video
 * dropped into a gallery paints as a broken `<img>`.
 *
 * Prefers an explicit `content_type` (present on restored media) and falls back
 * to the filename extension.
 */

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "apng"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

export type MediaKind = "image" | "video";

export function mediaKindFromName(name: string, contentType?: string): MediaKind | null {
  if (contentType) {
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("video/")) return "video";
  }
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

/**
 * Best-effort filename for a stored media URL, used only for kind detection.
 * Handles our `session://<id>/<name>` refs, Discord `attachment://<name>`, and
 * plain http(s) URLs.
 */
export function mediaNameFromUrl(url: string): string {
  if (url.startsWith("attachment://")) return url.slice("attachment://".length);
  const slash = url.lastIndexOf("/");
  const tail = slash >= 0 ? url.slice(slash + 1) : url;
  // Strip any query/hash so the extension test sees a clean name.
  return tail.split(/[?#]/)[0] || url;
}
