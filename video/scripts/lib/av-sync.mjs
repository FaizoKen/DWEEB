// A/V sync checks shared by master.mjs and deliver-web.mjs: an encoded file's
// audio must decode sample-aligned with the PCM it was encoded from — AAC's
// encoder priming (2048 samples for libfdk_aac) is only skipped when the MP4's
// edit list signals it, and a stream copy that loses the edit list plays the
// whole film 43 ms late.

import path from "node:path";
import { runSystem } from "./ffmpeg.mjs";
import { readWav } from "./wav.mjs";

/**
 * Lag (in samples) of `testFile`'s decoded audio against the reference PCM,
 * found by cross-correlating the loudest 1.5 s of the reference (transients
 * pin the lag). Positive = the test file plays late.
 */
export function lagSamples(refFile, testFile, { sampleRate, tmpDir }) {
  const decoded = path.join(tmpDir, "decoded.wav");
  runSystem("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", testFile, "-map", "0:a:0", "-ac", "2", "-ar", String(sampleRate), "-c:a", "pcm_f32le", decoded]);
  const a = readWav(refFile).data[0];
  const b = readWav(decoded).data[0];
  const SR = sampleRate;
  const win = Math.round(1.5 * SR);
  let best = 0, bestE = -1;
  for (let s = SR; s + win < a.length - SR; s += SR / 4) {
    let e = 0;
    for (let i = s; i < s + win; i += 8) e += a[i] * a[i];
    if (e > bestE) { bestE = e; best = s; }
  }
  const maxLag = 3000;
  let lag = 0, bestC = -Infinity;
  for (let d = -maxLag; d <= maxLag; d++) {
    let c = 0;
    for (let i = best; i < best + win; i += 2) c += a[i] * (b[i + d] ?? 0);
    if (c > bestC) { bestC = c; lag = d; }
  }
  return { lag, lengthDiff: b.length - a.length };
}

/** Media time of the audio stream's first edit-list entry, or null if none. */
export function audioEditListMediaTime(file) {
  const r = runSystem("ffprobe", ["-v", "trace", "-select_streams", "a:0", "-show_entries", "stream=index", file], { allowFail: true });
  const p = runSystem("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type", "-of", "json", file]);
  const audioIndex = JSON.parse(p.stdout).streams.find((s) => s.codec_type === "audio")?.index;
  const m = new RegExp(`st: ${audioIndex}, edit list 0 - media time: (-?\\d+)`).exec(r.stderr);
  return m ? Number(m[1]) : null;
}
