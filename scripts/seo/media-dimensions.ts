/**
 * Pixel dimensions of the shipped sample images, read from the WebP headers at
 * build time so the static pages can print `width`/`height` on every `<img>`
 * (no layout shift while the picture loads) without pulling in an image
 * library. Only the three WebP container layouts exist; anything else reads as
 * "unknown", and the renderer falls back to its captioned placeholder.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ImageSize {
  width: number;
  height: number;
}

/** Parse a WebP file's canvas size from its header. Returns null for anything that isn't WebP. */
export function webpDimensions(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
  const u16 = (o: number) => bytes[o]! | (bytes[o + 1]! << 8);
  const u24 = (o: number) => bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16);
  const chunk = ascii(12, 4);
  if (chunk === "VP8 ") {
    // Lossy: a 3-byte frame tag, the 9d 01 2a start code, then 14-bit width and height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: u16(26) & 0x3fff, height: u16(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // Lossless: the 0x2f signature, then width-1 and height-1 as packed 14-bit fields.
    if (bytes[20] !== 0x2f) return null;
    const b = (i: number) => bytes[21 + i]!;
    const width = 1 + (b(0) | ((b(1) & 0x3f) << 8));
    const height = 1 + ((b(1) >> 6) | (b(2) << 2) | ((b(3) & 0x0f) << 10));
    return { width, height };
  }
  if (chunk === "VP8X") {
    // Extended: flags + reserved (4 bytes), then 24-bit canvas width-1 / height-1.
    return { width: 1 + u24(24), height: 1 + u24(27) };
  }
  return null;
}

const DEFAULT_MEDIA_DIR = fileURLToPath(new URL("../../public/media/defaults/", import.meta.url));
const sizeCache = new Map<string, ImageSize | null>();

/**
 * Size of one shipped default-media file (`dweeb-welcome-banner.webp`), or null
 * when it is missing or unreadable — the caller then keeps its placeholder, so a
 * renamed sample can never break the build.
 */
export function defaultMediaSize(fileName: string): ImageSize | null {
  const cached = sizeCache.get(fileName);
  if (cached !== undefined) return cached;
  const path = `${DEFAULT_MEDIA_DIR}${fileName}`;
  let size: ImageSize | null = null;
  if (existsSync(path)) {
    try {
      size = webpDimensions(readFileSync(path));
    } catch {
      size = null;
    }
  }
  sizeCache.set(fileName, size);
  return size;
}
