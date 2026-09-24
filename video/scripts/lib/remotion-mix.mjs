// Rebuild the film's mix offline, the way Remotion 4.0.290 renders it, so the
// balance can be measured (and tuned) without a render:
//   per asset:  aformat=s32/48k → atrim(0, duration) → volume → -ac 2 (mono is
//               upmixed at -3 dB per side) → pcm_s16le 48 kHz
//   merge:      every asset delayed to its frame and summed (amix normalize=0).
// It runs the same bundled ffmpeg binary the renderer uses, so decode, resample
// and the -3 dB upmix are the renderer's own. (The audit's reconstruction of
// the v5 mix by this chain nulled to -57 dB against the rendered master.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VIDEO_ROOT } from "./film-timing.mjs";
import { runBundled } from "./ffmpeg.mjs";
import { readWav } from "./wav.mjs";

export const MIX_SAMPLE_RATE = 48000;

const cache = new Map();

/**
 * One asset through Remotion's per-asset stage. `src` is a public/ path
 * ("audio/hook.mp3"); `seconds` truncates like a <Sequence durationInFrames>.
 */
export function renderAsset(src, { volume = 1, seconds = null } = {}) {
  const key = `${src}|${volume}|${seconds}`;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(VIDEO_ROOT, "public", src);
  const out = path.join(os.tmpdir(), `dweeb-mix-${process.pid}-${cache.size}.wav`);
  const filters = [`aformat=sample_fmts=s32:sample_rates=${MIX_SAMPLE_RATE}`];
  if (seconds !== null) filters.push(`atrim=0us:${Math.round(seconds * 1e6)}us`);
  if (volume !== 1) filters.push(`volume=${volume}:eval=once`);
  try {
    runBundled(["-y", "-i", file, "-ac", "2", "-af", filters.join(","), "-c:a", "pcm_s16le", "-ar", String(MIX_SAMPLE_RATE), out]);
    const wav = readWav(out);
    cache.set(key, wav.data);
    return wav.data;
  } finally {
    fs.rmSync(out, { force: true });
  }
}

/**
 * Sum assets `{ src, from (frame), frames?, volume }` into a stereo bus of
 * `totalFrames`. Returns float channels (NOT clipped: report the peak — the
 * renderer's final 16-bit stage clips anything past full scale).
 */
export function mixBus(assets, { fps, totalFrames }) {
  const n = Math.round((totalFrames / fps) * MIX_SAMPLE_RATE);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (const a of assets) {
    const [l, r] = renderAsset(a.src, { volume: a.volume ?? 1, seconds: a.frames != null ? a.frames / fps : null });
    const off = Math.round((a.from / fps) * MIX_SAMPLE_RATE);
    for (let i = 0; i < l.length && off + i < n; i++) {
      if (off + i < 0) continue;
      L[off + i] += l[i];
      R[off + i] += r[i];
    }
  }
  return [L, R];
}
