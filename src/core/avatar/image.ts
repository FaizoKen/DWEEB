/**
 * Prepare a user-picked file for use as a webhook avatar.
 *
 * Everything expensive happens here, in the browser, so the server never does
 * pixel work: it receives an already-square, already-small image and only reads
 * the header bytes to check it (see `server/src/avatar.rs`).
 *
 * The processing is not cosmetic — each step exists because Discord fails
 * *silently* otherwise, falling back to the default webhook avatar with no
 * error anywhere:
 *
 *  - **Downscale to 256×256.** Discord ignores avatars whose dimensions run
 *    much past ~1024px. 256 is comfortably inside that and is already larger
 *    than any size Discord displays an avatar at, so there's nothing to gain by
 *    sending more bytes.
 *  - **Center-crop to a square.** Discord renders avatars in a circle. A
 *    non-square source would be squashed by the client; cropping here means the
 *    preview and Discord agree.
 *  - **Re-encode to PNG or JPEG.** Animated GIFs never render as avatars at
 *    all, and WebP is unreliable. Drawing through a canvas normalises whatever
 *    the user picked (including a GIF's first frame) into a format that works.
 *
 * Format choice is made per image rather than fixed, because neither option is
 * right for both kinds of avatar people actually use:
 *  - Artwork/logos are usually flat colour, where PNG is both smaller *and*
 *    lossless — and they are the images most likely to carry transparency,
 *    which JPEG cannot represent (it would flatten to a black square).
 *  - Photos are the opposite: PNG at 256² can run past 150 KiB, over the upload
 *    cap, while JPEG holds the same image in a few tens of KiB.
 *
 * So: keep PNG whenever the image has any transparency, and otherwise keep PNG
 * only while it stays under {@link PNG_SIZE_BUDGET}, falling back to JPEG.
 */

/** Edge length we downscale to. Larger than Discord ever displays an avatar. */
export const AVATAR_TARGET_SIZE = 256;

/** Anything smaller than this is a mis-picked file; the server agrees. */
export const AVATAR_MIN_SIZE = 16;

/** Mirrors the server's `AVATAR_MAX_BYTES` default. */
export const AVATAR_MAX_UPLOAD_BYTES = 128 * 1024;

/**
 * Above this an opaque PNG is re-encoded as JPEG. Set well under the upload cap
 * so the JPEG fallback engages before a rejection rather than after one.
 */
export const PNG_SIZE_BUDGET = 96 * 1024;

/** JPEG quality for the photo fallback — visually clean at avatar sizes. */
const JPEG_QUALITY = 0.85;

export interface CropRect {
  sx: number;
  sy: number;
  size: number;
}

/**
 * The largest centered square that fits in a `width`×`height` image.
 *
 * Pure and exported so the crop maths is testable without a canvas: the DOM
 * work in {@link prepareAvatarImage} is a thin wrapper around this.
 */
export function squareCropRect(width: number, height: number): CropRect {
  const size = Math.min(width, height);
  return {
    sx: Math.floor((width - size) / 2),
    sy: Math.floor((height - size) / 2),
    size,
  };
}

/**
 * Edge length to render at: {@link AVATAR_TARGET_SIZE}, or the source's own
 * square size when it is already smaller.
 *
 * Never upscales. Blowing a 64px icon up to 256 adds bytes and blur without
 * adding any detail, and Discord downscales for display anyway.
 */
export function targetSize(cropSize: number): number {
  return Math.min(cropSize, AVATAR_TARGET_SIZE);
}

/**
 * Does this RGBA buffer contain any non-opaque pixel?
 *
 * Drives the format choice: a transparent image must stay PNG regardless of
 * size, because JPEG has no alpha channel and the transparent region would
 * flatten to solid black inside Discord's circular avatar crop.
 */
export function hasTransparency(rgba: Uint8ClampedArray): boolean {
  // Alpha is every 4th byte.
  for (let i = 3; i < rgba.length; i += 4) {
    if ((rgba[i] ?? 255) < 255) return true;
  }
  return false;
}

export type AvatarEncoding = { mime: "image/png" } | { mime: "image/jpeg"; quality: number };

/**
 * Pick the output format given what we learned about the drawn image.
 *
 * Split from the canvas work so the policy — the part that would silently
 * regress into "always PNG" and start rejecting photos — is directly testable.
 */
export function chooseEncoding(opts: { transparent: boolean; pngBytes: number }): AvatarEncoding {
  if (opts.transparent) return { mime: "image/png" };
  if (opts.pngBytes <= PNG_SIZE_BUDGET) return { mime: "image/png" };
  return { mime: "image/jpeg", quality: JPEG_QUALITY };
}

export interface PreparedAvatar {
  blob: Blob;
  /** Edge length of the square result, for the caller's status copy. */
  size: number;
}

export class AvatarImageError extends Error {}

/**
 * Decode, center-crop, downscale and re-encode `file` into an avatar-ready
 * square image.
 *
 * Throws {@link AvatarImageError} with a user-facing message when the file
 * isn't a decodable image or is too small to use.
 */
export async function prepareAvatarImage(file: File): Promise<PreparedAvatar> {
  const bitmap = await decode(file);
  try {
    const crop = squareCropRect(bitmap.width, bitmap.height);
    if (crop.size < AVATAR_MIN_SIZE) {
      throw new AvatarImageError("That image is too small to use as an avatar.");
    }
    const size = targetSize(crop.size);

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new AvatarImageError("Couldn't process that image in this browser.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, crop.sx, crop.sy, crop.size, crop.size, 0, 0, size, size);

    // `getImageData` can throw on a tainted canvas. Our source is a local file,
    // so it never is — but treat a failure as "assume transparency" (PNG),
    // which is the lossless, always-correct branch.
    let transparent = true;
    try {
      transparent = hasTransparency(ctx.getImageData(0, 0, size, size).data);
    } catch {
      transparent = true;
    }

    const png = await toBlob(canvas, { mime: "image/png" });
    const encoding = chooseEncoding({ transparent, pngBytes: png.size });
    const blob = encoding.mime === "image/png" ? png : await toBlob(canvas, encoding);
    return { blob, size };
  } finally {
    bitmap.close();
  }
}

/**
 * Decode to an `ImageBitmap`, honouring EXIF orientation.
 *
 * `imageOrientation: "from-image"` matters for phone photos: without it a
 * portrait shot taken sideways is cropped along the wrong axis, so the user
 * gets a centered crop of the wrong part of their picture.
 */
async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new AvatarImageError("That file isn't an image we can read.");
  }
}

function toBlob(canvas: HTMLCanvasElement, encoding: AvatarEncoding): Promise<Blob> {
  const quality = encoding.mime === "image/jpeg" ? encoding.quality : undefined;
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new AvatarImageError("Couldn't process that image in this browser."));
      },
      encoding.mime,
      quality,
    );
  });
}
