// Minimal WAV I/O for the audio scripts — no dependencies.
//
// The kit writes 16-bit PCM stereo because every consumer handles it: Remotion
// (ffmpeg) at render time, the Studio preview (the browser's decoder), and git
// diffs of the committed SFX stay byte-stable. Reading accepts the formats our
// own tools produce: 16/24/32-bit integer PCM and 32-bit float, any channel count.

import fs from "node:fs";
import path from "node:path";

/**
 * Write a 16-bit PCM stereo WAV. `L`/`R` are Float32Arrays in [-1, 1]; values
 * outside are clamped (the builders keep headroom, so clamping is a guard, not
 * a sound). Rounds to nearest rather than truncating toward zero, so a signal
 * and its negation quantize symmetrically.
 */
export function writeWav16(file, L, R, sampleRate) {
  const n = L.length;
  const buffer = Buffer.alloc(44 + n * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + n * 4, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(2, 22); // stereo
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i]));
    const r = Math.max(-1, Math.min(1, R[i]));
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l * 32767))), 44 + i * 4);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r * 32767))), 44 + i * 4 + 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
}

/** Read a WAV into per-channel Float32Arrays: `{ sampleRate, channels, length, data }`. */
export function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }
  let o = 12;
  let fmt = null;
  let data = null;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4);
    let size = b.readUInt32LE(o + 4);
    // ffmpeg writes 0xFFFFFFFF for the data size when it streams to a pipe.
    if (id === "data" && (size === 0xffffffff || o + 8 + size > b.length)) size = b.length - o - 8;
    if (id === "fmt ") {
      fmt = {
        tag: b.readUInt16LE(o + 8),
        channels: b.readUInt16LE(o + 10),
        sampleRate: b.readUInt32LE(o + 12),
        bits: b.readUInt16LE(o + 22),
      };
      // WAVE_FORMAT_EXTENSIBLE: the real format tag is the sub-format GUID's first word.
      if (fmt.tag === 0xfffe && size >= 26) fmt.tag = b.readUInt16LE(o + 8 + 24);
    }
    if (id === "data") {
      data = b.subarray(o + 8, o + 8 + size);
      break;
    }
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt or data chunk`);
  const { tag, channels, sampleRate, bits } = fmt;
  const bytes = bits / 8;
  const length = Math.floor(data.length / (bytes * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(length));
  const read =
    tag === 3 && bits === 32
      ? (p) => data.readFloatLE(p)
      : tag === 3 && bits === 64
        ? (p) => data.readDoubleLE(p)
        : bits === 16
          ? (p) => data.readInt16LE(p) / 32768
          : bits === 24
            ? (p) => data.readIntLE(p, 3) / 8388608
            : bits === 32
              ? (p) => data.readInt32LE(p) / 2147483648
              : null;
  if (!read) throw new Error(`${file}: unsupported WAV format (tag ${tag}, ${bits}-bit)`);
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) out[c][i] = read((i * channels + c) * bytes);
  }
  return { sampleRate, channels, length, data: out };
}

export const dbfs = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** Peak absolute sample over all channels. */
export function peak(channels) {
  let p = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
  return p;
}
