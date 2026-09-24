// Master a rendered film's audio: measure → static gain → oversampled
// true-peak limiter → encode/mux, then verify what came out.
//
//   npx remotion render src/index.ts DweebPromo out/dweeb-promo.mp4 --separate-audio-to=out/dweeb-promo.wav
//   npm run master -- out/dweeb-promo.mp4 --audio out/dweeb-promo.wav
//
// writes, next to the video:
//   <name>.master.mp4  promo master: the video stream copied untouched + AAC 256k
//                      (libfdk_aac) at -14 LUFS, true peak ≤ -1.0 dBTP
//   <name>.promo.wav   the same audio as 24-bit PCM (for platforms that take PCM)
//   <name>.web.wav     24-bit PCM at -16 LUFS, ≤ -1.0 dBTP — the audio the web
//                      delivery cuts are encoded from (one generation of AAC)
//
// Why each step:
// - LOSSLESS INPUT. `--separate-audio-to=<file>.wav` makes Remotion write the mix
//   as PCM instead of AAC. Without --audio the track is decoded from the video;
//   Remotion's MP4s carry AAC whose encoder priming is never signalled (edit
//   list media time 0), so every such file plays 2048 samples (42.7 ms) late —
//   the extraction trims that priming (auto-detected; --priming=<samples> overrides).
// - STATIC GAIN + LIMITER, not loudnorm: a two-pass loudnorm that has to limit
//   falls back to its dynamic mode, a 3 s gain rider that flattens the score's
//   arc. A static gain keeps every level relationship; the limiter only shaves
//   the few peaks (VO plosives, the CTA hit) that a +3–4 dB gain pushes past
//   the ceiling. It runs at 192 kHz (4× oversampled, soxr) so it catches
//   inter-sample peaks, with its look-ahead latency compensated (latency=1) so
//   the audio stays sample-aligned with the picture.
// - MUXED BY FFMPEG, not stream-copied from an ADTS file: the mp4 muxer writes
//   the encoder's priming into the edit list, so the master plays in sync
//   (verified below by cross-correlating the decoded result with its source).
// - MEASURED WITH THE SYSTEM FFMPEG (ebur128, 4× true peak); encoded with
//   Remotion's bundled ffmpeg, the only one here with libfdk_aac.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audioEditListMediaTime, lagSamples } from "./lib/av-sync.mjs";
import { runBundled, runSystem } from "./lib/ffmpeg.mjs";
import { readWav } from "./lib/wav.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const video = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !args[i - 1].includes("=")));
if (!video || !fs.existsSync(video)) {
  console.error("usage: npm run master -- <video.mp4> [--audio <lossless.wav>] [--promo-lufs -14] [--web-lufs -16]\n" +
    "                     [--ceiling -1.0] [--bitrate 256k] [--priming auto|<samples>] [--out-dir <dir>]");
  process.exit(1);
}
const PROMO_LUFS = Number(flag("promo-lufs", -14));
const WEB_LUFS = Number(flag("web-lufs", -16));
const CEILING_DBTP = Number(flag("ceiling", -1.0));
const BITRATE = flag("bitrate", "256k");
const SR = 48000;
const outDir = flag("out-dir", path.dirname(video));
fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, path.basename(video).replace(/\.[^.]+$/, ""));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dweeb-master-"));

const db = (x) => 20 * Math.log10(x);
const lin = (d) => Math.pow(10, d / 20);

/** ebur128 summary of any file with audio: { I, LRA, TP } (TP = 4× oversampled true peak). */
function measure(file) {
  const r = runSystem("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);
  const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const num = (re) => {
    const m = re.exec(summary);
    if (!m) throw new Error(`could not read ${re} from ebur128 of ${file}`);
    return Number(m[1]);
  };
  return { I: num(/I:\s+(-?[\d.]+) LUFS/), LRA: num(/LRA:\s+(-?[\d.]+) LU/), TP: num(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/) };
}

function probe(file) {
  const r = runSystem("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,duration,sample_rate", "-of", "json", file]);
  return JSON.parse(r.stdout).streams;
}

// ─── 1. Lossless source ──────────────────────────────────────────────────────
const source = path.join(tmp, "source.wav");
let sourceNote;
const audioArg = flag("audio");
if (audioArg) {
  if (!fs.existsSync(audioArg)) throw new Error(`--audio ${audioArg} does not exist`);
  runSystem("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", audioArg, "-ac", "2", "-ar", String(SR), "-c:a", "pcm_f32le", source]);
  sourceNote = `lossless ${path.basename(audioArg)}`;
} else {
  const streams = probe(video);
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  if (!a) throw new Error(`${video} has no audio stream — pass --audio <file.wav>`);
  let priming = 0;
  const primingArg = flag("priming", "auto");
  if (primingArg === "auto") {
    // Remotion: AAC with the edit list at media time 0, and the stream longer
    // than the picture by the encoder's priming plus the last frame's padding.
    // AAC encoder delays are whole 1024-sample frames (libfdk_aac 2048, ffmpeg's
    // aac 1024), so the priming is the excess floored to a frame.
    const mediaTime = audioEditListMediaTime(video);
    const excess = Math.round((Number(a.duration) - Number(v?.duration ?? a.duration)) * SR);
    if (a.codec_name === "aac" && mediaTime === 0 && excess >= 1024 && excess <= 4096) priming = Math.floor(excess / 1024) * 1024;
  } else {
    priming = Number(primingArg);
  }
  runSystem("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", video, "-map", "0:a:0",
    "-af", `aresample=${SR},atrim=start_sample=${priming},asetpts=N/SR/TB`,
    "-ac", "2", "-c:a", "pcm_f32le", source,
  ]);
  sourceNote = `decoded from ${path.basename(video)} (${a.codec_name}${priming ? `, ${priming} samples of un-signalled priming trimmed` : ""}) — prefer --audio from --separate-audio-to`;
}
const input = measure(source);
console.log(`source: ${sourceNote}\n        I ${input.I.toFixed(1)} LUFS  TP ${input.TP.toFixed(1)} dBTP  LRA ${input.LRA.toFixed(1)} LU`);
if (input.TP > -0.1) console.warn("        warning: the source reaches full scale — Remotion's 16-bit mix may already have clipped; lower the mix");

// ─── 2. Gain + oversampled true-peak limiter ─────────────────────────────────
const RS = "resampler=soxr:precision=28";
function limit(gainDb, ceilingDb, out) {
  const chain = [
    `volume=${gainDb.toFixed(3)}dB`,
    `aresample=${SR * 4}:${RS}`,
    `alimiter=limit=${lin(ceilingDb).toFixed(6)}:attack=4:release=80:asc=1:level=0:latency=1`,
    `aresample=${SR}:${RS}`,
  ].join(",");
  runSystem("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-af", chain, "-c:a", "pcm_s24le", "-ar", String(SR), out]);
  return measure(out);
}

/**
 * Hit `targetLufs` (±0.1) with the true peak under `ceiling`: the limiter takes
 * a little loudness off the peaks it shaves, so the static gain is re-aimed
 * from what the previous pass measured.
 */
function master(targetLufs, ceiling, out, verify = (m) => m) {
  let gain = targetLufs - input.I;
  let limitAt = ceiling - 0.5; // margin for the encoder's own overshoot
  let result;
  for (let pass = 0; pass < 5; pass++) {
    const m = verify(limit(gain, limitAt, out));
    result = { ...m, gainDb: gain, limitDb: limitAt };
    const loudOk = Math.abs(m.I - targetLufs) <= 0.1;
    const peakOk = m.TP <= ceiling;
    if (loudOk && peakOk) break;
    if (!peakOk) limitAt -= m.TP - ceiling + 0.1;
    if (!loudOk) gain += targetLufs - m.I;
  }
  return result;
}

// ─── 3. Promo master: AAC in the MP4, video copied ───────────────────────────
const promoWav = `${base}.promo.wav`;
const promoMp4 = `${base}.master.mp4`;
const encode = () => {
  runBundled([
    "-y", "-i", video, "-i", promoWav,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "libfdk_aac", "-b:a", BITRATE, "-ar", String(SR),
    "-movflags", "+faststart", "-map_metadata", "-1",
    promoMp4,
  ]);
  return measure(promoMp4);
};
const promo = master(PROMO_LUFS, CEILING_DBTP, promoWav, () => encode());
const promoPcm = measure(promoWav);

// ─── 4. Web delivery PCM ─────────────────────────────────────────────────────
const webWav = `${base}.web.wav`;
const web = master(WEB_LUFS, CEILING_DBTP, webWav);

// How hard the limiter worked: 5 ms blocks of (source × gain) vs the limited
// PCM. Keep the max under ~3 dB — beyond that, fix peaks at the source.
function gainReduction(limitedFile, gainDb) {
  const src = readWav(source).data;
  const out = readWav(limitedFile).data;
  const g = lin(gainDb);
  const blk = SR / 200;
  let active = 0, total = 0, max = 0, at = 0;
  for (let s = 0; s + blk <= Math.min(src[0].length, out[0].length); s += blk) {
    let a = 0, b = 0;
    for (let c = 0; c < 2; c++) {
      for (let i = s; i < s + blk; i++) {
        a = Math.max(a, Math.abs(src[c][i]) * g);
        b = Math.max(b, Math.abs(out[c][i]));
      }
    }
    if (a < 0.05) continue;
    total++;
    const gr = db(a / Math.max(b, 1e-9));
    if (gr > 0.2) active++;
    if (gr > max) {
      max = gr;
      at = s / SR;
    }
  }
  return { max, at, share: total ? active / total : 0 };
}
const grPromo = gainReduction(promoWav, promo.gainDb);
const grWeb = gainReduction(webWav, web.gainDb);

// ─── 5. Verify sync: decoded master vs the PCM it was encoded from ───────────
const sync = lagSamples(promoWav, promoMp4, { sampleRate: SR, tmpDir: tmp });
const mediaTime = audioEditListMediaTime(promoMp4);

const line = (name, m, extra = "") =>
  `${name.padEnd(20)} I ${m.I.toFixed(1)} LUFS  TP ${m.TP.toFixed(1)} dBTP  LRA ${m.LRA.toFixed(1)} LU${extra}`;
console.log(line(path.basename(promoMp4), promo, `  A/V lag ${sync.lag} samples (${((sync.lag / SR) * 1000).toFixed(1)} ms; edit list media time ${mediaTime})  gain ${promo.gainDb.toFixed(2)} dB, limiter ${promo.limitDb.toFixed(2)} dBFS`));
console.log(line(path.basename(promoWav), promoPcm, `  limiter active on ${(grPromo.share * 100).toFixed(1)}% of 5 ms blocks, max GR ${grPromo.max.toFixed(2)} dB at ${grPromo.at.toFixed(2)} s (frame ${Math.round(grPromo.at * 30)})`));
console.log(line(path.basename(webWav), web, `  gain ${web.gainDb.toFixed(2)} dB, limiter ${web.limitDb.toFixed(2)} dBFS; active on ${(grWeb.share * 100).toFixed(1)}% of blocks, max GR ${grWeb.max.toFixed(2)} dB`));
fs.rmSync(tmp, { recursive: true, force: true });

const failures = [];
if (Math.abs(promo.I - PROMO_LUFS) > 0.3) failures.push(`promo I ${promo.I} ≠ ${PROMO_LUFS} ±0.3`);
if (promo.TP > CEILING_DBTP) failures.push(`promo TP ${promo.TP} > ${CEILING_DBTP}`);
if (Math.abs(web.I - WEB_LUFS) > 0.3) failures.push(`web I ${web.I} ≠ ${WEB_LUFS} ±0.3`);
if (web.TP > CEILING_DBTP) failures.push(`web TP ${web.TP} > ${CEILING_DBTP}`);
if (Math.abs(sync.lag) > 48) failures.push(`A/V lag ${sync.lag} samples (> 1 ms)`);
if (failures.length) {
  console.error(`MASTER OUT OF SPEC: ${failures.join("; ")}`);
  process.exit(1);
}
