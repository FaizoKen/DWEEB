// The score: ONE bar-accurate edit of the licensed track, anchored to the film.
//
// Track: Pavel Yudin ("paulyudin"), "Tech Corporate", Pixabay #182507 — kept in
// video/assets-src/ (gitignored: its licence allows use inside the film, not
// redistribution of the file, and this repo is public). Measured grid: kick onsets on
// all 128 beats of the two main sections fit exactly 118.000 BPM (bar
// 2.033898 s) with bar 0's downbeat at 1.0508 s, residuals ≤ 3.9 ms. Sections:
//   bars  0-7   intro       (≈ -22 dB, no kick)
//   bars  8-23  main A      (≈ -17.5 dB, full groove)
//   bars 24-31  breakdown   (≈ -24 dB, pads; its own riser over bars 30-31)
//   bars 32-47  main B      (≈ -17.5 dB, the drop)
//   bars 48-55  outro       (crash on 48, then winding down; the file ends ≈115.5 s)
// Main A and the breakdown share one 8-bar progression (F#m · A · F#m/D · B …;
// same-position chroma similarity 0.92-0.97), which is what makes the splice
// below harmonically seamless.
//
// The edit, derived entirely from the manifest (a re-record re-derives it):
//   1. main B's downbeat (bar 32) lands EXACTLY on CTA_HIT_ABS, the hard cut into
//      the end card — the drop, the impact SFX and the flash are one frame;
//   2. main A's first downbeat (bar 8) lands within ±0.25 s of the build line's
//      first word — whole bars back from the drop, with a ≤0.5% atempo on the
//      head only if no whole number of bars fits;
//   3. one splice from main A into the END of the breakdown (its closing bars and
//      its own riser play under the activity scene): the splice joins bar h to
//      bar h+8 — the same chord in the shared progression — so the one irregular
//      bar a non-multiple-of-4 distance forces reads as a held chord;
//   4. a musical ending: at the first bar line after the CTA line ends, splice
//      into the outro's bar 48 (its crash is the button), then fade with the picture.
// Splices are 30 ms equal-power crossfades completing 2 ms BEFORE the bar line,
// so the incoming downbeat transient arrives whole and the outgoing one never plays.
//
// The duck follows the words: -6 dB, a 120 ms attack that completes 40 ms
// before a line's first word, held until 120 ms after its last word, then a
// 400 ms release — so the bed breathes in every gap instead of pumping.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUDIO_DIR, VIDEO_ROOT, filmAnchors, readSceneConstants } from "./film-timing.mjs";
import { decodeToWav } from "./ffmpeg.mjs";
import { readWav, writeWav16, peak, dbfs } from "./wav.mjs";

export const TRACK_FILE = "paulyudin-tech-corporate-182507.mp3";
export const TRACK_PATH = path.join(VIDEO_ROOT, "assets-src", TRACK_FILE);
export const MUSIC_SAMPLE_RATE = 48000; // Remotion mixes at 48 kHz: no second resample

export const BPM = 118;
export const BAR = 240 / BPM;
export const BAR0 = 1.0508;
export const BARS = { mainA: 8, breakdown: 24, mainB: 32, outro: 48 };
/** Source time of a bar's downbeat. */
export const barSrc = (bar) => BAR0 + bar * BAR;

/** main A may enter this far from the build line's first word (s). */
export const MAIN_A_TOLERANCE = 0.25;
/** Largest tempo change the head may take to hit that window (0.5%). */
export const MAX_TEMPO_DEVIATION = 0.005;

export const DUCK = { depthDb: -6, attack: 0.12, pre: 0.04, hold: 0.12, release: 0.4 };
export const XFADE = { length: 0.03, beforeBarLine: 0.002 };
export const FADE_IN = 0.8;
export const FADE_OUT = 1.5;
/** The breakdown sits ~6 dB under the main sections; +3 dB keeps it a bed under the activity line. */
export const BREAKDOWN_LIFT_DB = 3;
/**
 * Fixed file gain: music.wav is written this far under the source so the
 * lifted, unducked drop never clips the 16-bit file. The audible level is set
 * by MUSIC_BASE in src/audio.ts — fixed rather than peak-normalized, so a
 * re-edit can never silently change the mix balance.
 */
export const FILE_GAIN_DB = -3;

const smoothstep = (x) => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};

/** The duck as a gain curve over absolute film seconds. */
export function duckCurve(spans, duck = DUCK) {
  const depth = 1 - Math.pow(10, duck.depthDb / 20);
  return (t) => {
    let on = 0;
    for (const { start, end } of spans) {
      if (t < start - duck.pre - duck.attack || t > end + duck.hold + duck.release) continue;
      const up = smoothstep((t - (start - duck.pre - duck.attack)) / duck.attack);
      const down = 1 - smoothstep((t - (end + duck.hold)) / duck.release);
      on = Math.max(on, Math.min(up, down));
    }
    return 1 - on * depth;
  };
}

/**
 * Plan the edit from the manifest. Pure (no I/O), so it can be checked
 * against any timeline: returns the segments, the anchors it hit and how close.
 */
export function planMusicEdit(manifest) {
  const a = filmAnchors(manifest);
  const fps = a.fps;
  const tHit = a.ctaHitFrame / fps;
  const buildRef = a.speechStartSec("build");
  const buildLineStart = a.lineStartSec("build"); // informational
  const activityCut = a.sceneFrom("activity") / fps;
  const ctaSpeechEnd = a.speechEndSec("cta");
  const total = a.totalSec;

  // 2. Whole bars from main A's entry to the drop; stretch the head only if needed.
  let best = null;
  for (const bars of [Math.round((tHit - buildRef) / BAR), Math.floor((tHit - buildRef) / BAR), Math.ceil((tHit - buildRef) / BAR)]) {
    const tA = tHit - bars * BAR;
    const err = tA - buildRef;
    if (Math.abs(err) <= MAIN_A_TOLERANCE) {
      best = { bars, tA, tempo: 1 };
      break;
    }
    if (!best) best = { bars, tA, tempo: null, err };
  }
  // 3. The breakdown's closing bars fill the activity scene: as many whole bars
  //    as fit between the activity cut and the drop (the splice lands just
  //    after the cut, never before it). At least 2 so its riser is whole.
  const breakdownBars = Math.max(2, Math.min(8, Math.floor((tHit - activityCut) / BAR)));
  const tSplice = tHit - breakdownBars * BAR;
  const headBars = best.bars - breakdownBars;
  if (headBars < 4 || headBars > 16) {
    throw new Error(
      `music edit: ${best.bars} bars from main A to the drop leave ${headBars} bars of main A ` +
        `(needs 4-16) — the film's build→CTA distance is outside what one splice can cover`,
    );
  }
  if (best.tempo === null) {
    // Move main A to the nearest edge of the tolerance window with a head-only atempo.
    const tA = buildRef + Math.sign(best.tA - buildRef) * MAIN_A_TOLERANCE * 0.98;
    const tempo = (headBars * BAR) / (tSplice - tA);
    if (Math.abs(tempo - 1) > MAX_TEMPO_DEVIATION) {
      // The drop is pinned to CTA_HIT_ABS, so only the build→CTA distance can
      // change: find the smallest shift of the CTA (any gapAfter from "build"
      // to "activity") that puts a whole number of bars back in the window.
      const fits = (shift) => {
        const x = (tHit + shift / fps - buildRef) / BAR;
        return Math.abs(x - Math.round(x)) * BAR <= MAIN_A_TOLERANCE;
      };
      let later = 1;
      while (!fits(later)) later++;
      let earlier = 1;
      while (!fits(-earlier)) earlier++;
      throw new Error(
        `music edit: main A would enter ${(best.err * 1000).toFixed(0)} ms from the build line's ` +
          `first word, and fixing it needs a ${((tempo - 1) * 100).toFixed(2)}% tempo change ` +
          `(limit ±0.5%). Move the CTA ${later} frame(s) later or ${earlier} earlier — e.g. change ` +
          `a gapAfter between "build" and "activity" in scripts/generate-audio.mjs — and re-run.`,
      );
    }
    best = { ...best, tA, tempo };
  }
  // With tempo r the head maps film t -> source headSrc0 + t*r, and main A's
  // downbeat (bar 8) lands at tA.
  const headSrc0 = barSrc(BARS.mainA) - best.tA * best.tempo;

  // 4. The ending: the first bar line at least 0.25 s after the CTA line's last
  //    word, if it leaves room for the outro's crash to ring before the fade.
  const endingBars = Math.ceil((ctaSpeechEnd + 0.25 - tHit) / BAR);
  const tEnding = tHit + endingBars * BAR;
  const hasEnding = endingBars >= 1 && total - tEnding >= FADE_OUT;

  const segments = [
    {
      label: "intro → main A",
      filmStart: 0,
      filmEnd: tSplice,
      srcStart: headSrc0,
      tempo: best.tempo,
      firstBar: BARS.mainA,
      lastBar: BARS.mainA + headBars - 1,
    },
    {
      label: `breakdown bars ${BARS.mainB - breakdownBars}-${BARS.mainB - 1} → main B`,
      filmStart: tSplice,
      filmEnd: hasEnding ? tEnding : total,
      srcStart: barSrc(BARS.mainB - breakdownBars),
      tempo: 1,
      liftUntil: tHit,
    },
  ];
  if (hasEnding) {
    segments.push({ label: "outro (bar 48 crash) → fade", filmStart: tEnding, filmEnd: total, srcStart: barSrc(BARS.outro), tempo: 1 });
  }
  const f = (t) => Number((t * fps).toFixed(2));
  return {
    fps,
    total,
    segments,
    spans: a.speechSpans(),
    report: {
      grid: { bpm: BPM, barSec: Number(BAR.toFixed(6)), bar0Sec: BAR0 },
      marks: {
        mainAFrame: f(best.tA),
        spliceFrame: f(tSplice),
        dropFrame: f(tHit),
        endingFrame: hasEnding ? f(tEnding) : null,
      },
      bars: { mainAToDrop: best.bars, mainA: headBars, breakdown: breakdownBars, afterDrop: hasEnding ? endingBars : null },
      headTempo: Number(best.tempo.toFixed(5)),
      anchorErrorsMs: {
        mainAvsBuildFirstWord: Math.round((best.tA - buildRef) * 1000),
        mainAvsBuildLineStart: Math.round((best.tA - buildLineStart) * 1000),
        dropVsCtaHit: 0,
        spliceAfterActivityCut: Math.round((tSplice - activityCut) * 1000),
        endingAfterCtaLastWord: hasEnding ? Math.round((tEnding - ctaSpeechEnd) * 1000) : null,
      },
    },
  };
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Decode `seconds` of the track from `srcStart` at `tempo` (atempo on the bundled ffmpeg). */
function decodeTrack(tmpDir, name, { srcStart = 0, seconds = null, tempo = 1 } = {}) {
  const out = path.join(tmpDir, `${name}.wav`);
  const filters = [];
  if (srcStart > 0 || seconds !== null) {
    filters.push(`atrim=start=${Math.max(0, srcStart).toFixed(6)}${seconds !== null ? `:duration=${seconds.toFixed(6)}` : ""}`);
    filters.push("asetpts=N/SR/TB");
  }
  if (tempo !== 1) filters.push(`atempo=${tempo.toFixed(6)}`);
  decodeToWav(TRACK_PATH, out, { sampleRate: MUSIC_SAMPLE_RATE, channels: 2, extraFilters: filters });
  const wav = readWav(out);
  fs.rmSync(out, { force: true });
  return wav;
}

/** Render the planned edit to music.wav. Returns the manifest's `music` section. */
function renderLicensed(plan) {
  if (!fs.existsSync(TRACK_PATH)) {
    throw new Error(
      `The licensed track is missing: ${TRACK_PATH}\n` +
        `Download Pixabay #182507 (paulyudin, "Tech Corporate") into video/assets-src/ ` +
        `(provenance: the header of scripts/lib/music-edit.mjs), or build the synthesized ` +
        `stand-in with --synth-music.`,
    );
  }
  const SR = MUSIC_SAMPLE_RATE;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dweeb-music-"));
  try {
    const whole = decodeTrack(tmpDir, "track");
    const head = plan.segments[0];
    // The head is re-decoded through atempo only when the plan needs a stretch,
    // and is then indexed from film 0. If main A enters later in the film than
    // in the track, the head starts before the file does: that lead-in is
    // silence (under the fade-in anyway).
    const headLead = Math.max(0, -head.srcStart / head.tempo);
    const stretched =
      head.tempo !== 1
        ? decodeTrack(tmpDir, "head", {
            srcStart: Math.max(0, head.srcStart),
            seconds: (head.filmEnd + XFADE.length - headLead) * head.tempo + 0.1,
            tempo: head.tempo,
          })
        : null;

    const n = Math.round(plan.total * SR);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    const lift = Math.pow(10, BREAKDOWN_LIFT_DB / 20);
    const duck = duckCurve(plan.spans);
    const fileGain = Math.pow(10, FILE_GAIN_DB / 20);

    // Sample of segment `s` at film time t (0 outside the source).
    const sampleOf = (s, t, ch) => {
      if (s === head && stretched) {
        const i = Math.round((t - headLead) * SR);
        return i >= 0 && i < stretched.length ? stretched.data[ch][i] : 0;
      }
      const i = Math.round((s.srcStart + (t - s.filmStart) * s.tempo) * SR);
      return i >= 0 && i < whole.length ? whole.data[ch][i] : 0;
    };
    const segGain = (s, t) => {
      if (!s.liftUntil) return 1;
      // Lift the breakdown; ramp it off over the 10 ms before the drop's downbeat.
      const r = (s.liftUntil - XFADE.beforeBarLine - t) / 0.01;
      return 1 + (lift - 1) * Math.max(0, Math.min(1, r));
    };

    const segs = plan.segments;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      // Which segment owns t, and is t inside the crossfade into the next one?
      let k = 0;
      while (k + 1 < segs.length && t >= segs[k + 1].filmStart - XFADE.beforeBarLine) k++;
      let l = 0;
      let r = 0;
      const next = segs[k + 1];
      const xfStart = next ? next.filmStart - XFADE.beforeBarLine - XFADE.length : Infinity;
      if (next && t >= xfStart) {
        const p = (t - xfStart) / XFADE.length;
        const gOut = Math.cos((p * Math.PI) / 2) * segGain(segs[k], t);
        const gIn = Math.sin((p * Math.PI) / 2) * segGain(next, t);
        l = sampleOf(segs[k], t, 0) * gOut + sampleOf(next, t, 0) * gIn;
        r = sampleOf(segs[k], t, 1) * gOut + sampleOf(next, t, 1) * gIn;
      } else {
        const g = segGain(segs[k], t);
        l = sampleOf(segs[k], t, 0) * g;
        r = sampleOf(segs[k], t, 1) * g;
      }
      const fadeIn = smoothstep(t / FADE_IN);
      const p = (t - (plan.total - FADE_OUT)) / FADE_OUT;
      const fadeOut = p <= 0 ? 1 : p >= 1 ? 0 : Math.cos((p * Math.PI) / 2);
      const g = fileGain * fadeIn * fadeOut * duck(t);
      L[i] = l * g;
      R[i] = r * g;
    }
    const pk = peak([L, R]);
    if (pk > Math.pow(10, -0.5 / 20)) {
      throw new Error(`music.wav would peak at ${dbfs(pk).toFixed(2)} dBFS — lower FILE_GAIN_DB`);
    }
    writeWav16(path.join(AUDIO_DIR, "music.wav"), L, R, SR);
    return {
      source: TRACK_FILE,
      sourceSha256: sha256File(TRACK_PATH),
      sampleRate: SR,
      fileGainDb: FILE_GAIN_DB,
      peakDbfs: Number(dbfs(pk).toFixed(2)),
      breakdownLiftDb: BREAKDOWN_LIFT_DB,
      duck: DUCK,
      fadeInSec: FADE_IN,
      fadeOutSec: FADE_OUT,
      ...plan.report,
      segments: plan.segments.map((s) => ({
        label: s.label,
        filmStart: Number(s.filmStart.toFixed(4)),
        filmEnd: Number(s.filmEnd.toFixed(4)),
        srcStart: Number(s.srcStart.toFixed(4)),
        tempo: Number(s.tempo.toFixed(5)),
      })),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Build music.wav for this manifest and return its `music` manifest section.
 * `synth: true` renders the synthesized stand-in bed (no licensed track needed)
 * against the same plan, so the picture's music cues stay valid either way.
 */
export async function buildFilmMusic(manifest, { synth = false } = {}) {
  readSceneConstants(); // fail early if timeline.ts can't be read
  const plan = planMusicEdit(manifest);
  if (synth) {
    const { buildSynthMusic } = await import("../audio-synth.mjs");
    return buildSynthMusic(plan);
  }
  const section = renderLicensed(plan);
  const m = section.marks;
  const e = section.anchorErrorsMs;
  console.log(
    `music.wav: ${plan.total.toFixed(2)} s from ${TRACK_FILE} — main A @${m.mainAFrame}f ` +
      `(${e.mainAvsBuildFirstWord} ms vs "build" first word), splice @${m.spliceFrame}f ` +
      `(+${e.spliceAfterActivityCut} ms after the activity cut), drop @${m.dropFrame}f = CTA_HIT_ABS, ` +
      `ending @${m.endingFrame}f; head tempo ${section.headTempo}; peak ${section.peakDbfs} dBFS`,
  );
  return section;
}
