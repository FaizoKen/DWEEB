// The UI sound kit (and the synthesized stand-in score), rendered offline as
// 16-bit stereo WAV. No network, no ffmpeg: `npm run sfx` rebuilds the kit on
// any machine, and every noise layer comes from a seeded generator, so the same
// source always writes the same bytes (the kit is committed).
//
// Sound design rules (v6):
// - The score is in F# minor, so every pitched sound is too: the chime is
//   C#6 → F#6 (V → I), the shimmer an A-major arpeggio (the relative major —
//   bright, "upgraded"), the impact's sub blooms on F#1, and the ping keeps its
//   E5 → A5 (diatonic).
// - Hierarchy lives in the mix levels (src/audio.ts VOL), not in the files: a
//   file peaks around -6…-10 dBFS so any volume ≤ 1 stays clean in Remotion's
//   16-bit per-asset stage.
// - Repeated UI events get seeded variants (click, pop, tick ×3) so eleven
//   clicks are eleven clicks, not one sample played eleven times.
// - Every length is a whole number of frames where it matters (riser, impact),
//   and sfx.json records every file's length so a <Sequence> never truncates one.

import fs from "node:fs";
import path from "node:path";
import { AUDIO_DIR, FPS } from "./lib/film-timing.mjs";
import { writeWav16, peak, dbfs } from "./lib/wav.mjs";
import { duckCurve, MUSIC_SAMPLE_RATE } from "./lib/music-edit.mjs";

export const SR = 44100;

export const noteFreq = (semisFromA4) => 440 * Math.pow(2, semisFromA4 / 12);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** xorshift32 in [-1, 1): replaces Math.random() so rebuilds are byte-identical. */
export const noiseGenerator = (seed) => {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffffffff) * 2 - 1;
  };
};

/** RBJ band-pass (constant 0 dB peak gain) as a stateful per-sample filter. */
function bandPass(freq, q, sampleRate = SR) {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** A sound: n samples of stereo, filled by fn(t, i) → [l, r]. */
function render(seconds, fn, sampleRate = SR) {
  const n = Math.round(seconds * sampleRate);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [l, r] = fn(i / sampleRate, i);
    L[i] = l;
    R[i] = r;
  }
  return { L, R };
}

/** Per-variant parameter jitter: variant 1 is the reference sound, 2 and 3 deviate. */
function variantParams(seed, variant) {
  if (variant === 1) return { pitch: 1, decay: 1, level: 1 };
  const rnd = noiseGenerator(seed * 7919 + variant * 104729);
  const sign = variant === 2 ? 1 : -1;
  return {
    pitch: 1 + sign * (0.025 + 0.015 * Math.abs(rnd())), // ±2.5…4%
    decay: 1 + 0.08 * rnd(),
    level: 1 + 0.05 * rnd(),
  };
}

// ─── Sounds ──────────────────────────────────────────────────────────────────

/** Mouse click: a noise transient + a short 1.3 kHz body + a faint low "thock". */
export function buildClick(variant = 1) {
  const p = variantParams(0xc11c, variant);
  const noise = noiseGenerator(0xdbee0003 + variant - 1);
  const tone = bandPass(4200 * p.pitch, 1.1);
  return render(0.1, (t) => {
    const body = Math.sin(2 * Math.PI * 1300 * p.pitch * t) * Math.exp((-t * 90) / p.decay) * 0.3;
    const tick = (tone(noise()) * 2.2 + noise() * 0.35) * Math.exp(-t * 420) * 0.3;
    const thock = Math.sin(2 * Math.PI * 180 * p.pitch * t) * Math.exp(-t * 110) * 0.1;
    const s = (body + tick + thock) * p.level;
    return [s, s];
  });
}

/** Pop: a quick downward-gliding bubble for UI elements appearing. */
export function buildPop(variant = 1) {
  const p = variantParams(0x9090, variant);
  let phase = 0;
  return render(0.2, (t) => {
    // 900 Hz falling toward ~360 Hz, as in the v5 pop (now phase-accurate).
    const f = (900 - 3000 * Math.min(t, 0.18)) * p.pitch;
    phase += (2 * Math.PI * Math.max(f, 200)) / SR;
    const attack = Math.min(1, t / 0.0015);
    const s = Math.sin(phase) * Math.exp((-t * 40) / p.decay) * 0.4 * attack * p.level;
    return [s, s];
  });
}

/**
 * Soft key tick for typing: a band-limited click over a small mid "thock".
 * Quieter and duller than the mouse click, so a burst of them reads as keys.
 */
export function buildTick(variant = 1) {
  const p = variantParams(0x7e7e, variant);
  const noise = noiseGenerator(0xdbee0004 + variant - 1);
  const hi = bandPass(3200 * p.pitch, 0.9);
  return render(2 / FPS, (t) => {
    const attack = Math.min(1, t / 0.0008);
    const click = hi(noise()) * Math.exp((-t * 520) / p.decay) * 0.55;
    const thock = Math.sin(2 * Math.PI * 540 * p.pitch * t) * Math.exp(-t * 170) * 0.16;
    const floor = Math.sin(2 * Math.PI * 150 * p.pitch * t) * Math.exp(-t * 95) * 0.05;
    const s = (click + thock + floor) * attack * p.level;
    return [s, s * 0.97];
  });
}

/** One bell-like partial stack: fundamental + a quick bright 2nd + a faint glassy 4th. */
const bell = (f, t, decay) =>
  (Math.sin(2 * Math.PI * f * t) +
    0.22 * Math.sin(2 * Math.PI * 2 * f * t) * Math.exp(-t * 12) +
    0.05 * Math.sin(2 * Math.PI * 3.98 * f * t) * Math.exp(-t * 18)) *
  Math.exp(-t * decay);

/**
 * "Applied" chime, retuned into the score's key: C#6 → F#6, a rising fourth
 * (V → I). 6 ms attacks and a light top so it confirms without poking out;
 * its level in the mix (VOL.chime) keeps it ~9 LU under the narration.
 */
export function buildChime() {
  const f1 = noteFreq(16); // C#6
  const f2 = noteFreq(21); // F#6
  return render(24 / FPS, (t) => {
    const n1 = bell(f1, t, 6) * Math.min(1, t / 0.006) * 0.2;
    const t2 = t - 0.1;
    const n2 = t2 > 0 ? bell(f2, t2, 4.5) * Math.min(1, t2 / 0.006) * 0.2 : 0;
    return [n1 + n2 * 0.93, n1 * 0.93 + n2];
  });
}

/**
 * Makeover shimmer for the hook's transformation: an A-major arpeggio
 * (A5 C#6 E6 A6 — the key's relative major) over a breath of high air, sweeping
 * gently left to right. It lives in the VO pause; the ping stays exclusive to
 * delivery.
 */
export function buildShimmer() {
  const notes = [12, 16, 19, 24].map(noteFreq); // A5 C#6 E6 A6
  const noise = noiseGenerator(0xdbee0007);
  const air = bandPass(7000, 0.7);
  return render(27 / FPS, (t) => {
    let l = 0;
    let r = 0;
    notes.forEach((f, k) => {
      const tk = t - k * 0.045;
      if (tk <= 0) return;
      const v = bell(f, tk, 5.5) * Math.min(1, tk / 0.004) * 0.1;
      const pan = k / (notes.length - 1); // 0 = left … 1 = right
      l += v * (1 - 0.3 * pan);
      r += v * (0.7 + 0.3 * pan);
    });
    const breath = air(noise()) * Math.sin(Math.PI * Math.min(1, t / 0.55)) * Math.exp(-t * 2.5) * 0.05;
    return [l + breath, r + breath * 0.9];
  });
}

/** "Message landed" — E5 → A5 with a short shimmer tail. Delivery only. */
export function buildPing() {
  const f1 = noteFreq(7); // E5
  const f2 = noteFreq(12); // A5
  return render(0.5, (t) => {
    const attack = Math.min(1, t / 0.008);
    const n1 = Math.sin(2 * Math.PI * f1 * t) * Math.exp(-t * 9) * 0.26 * attack;
    const s2 = 0.09;
    const n2 = t > s2 ? Math.sin(2 * Math.PI * f2 * (t - s2)) * Math.exp(-(t - s2) * 6) * 0.3 : 0;
    const air = Math.sin(2 * Math.PI * f2 * 2 * t) * Math.exp(-t * 12) * 0.05;
    const s = n1 + n2 + air;
    return [s, s * 0.94];
  });
}

/** Transition whoosh: swept filtered noise with a rising tone, panning left → right. */
export function buildWhoosh() {
  const dur = 0.55;
  const noise = noiseGenerator(0xdbee0002);
  let lp = 0;
  return render(dur, (t) => {
    const p = t / dur;
    const env = Math.sin(Math.PI * p) ** 1.4;
    const cut = 0.02 + 0.16 * Math.sin(Math.PI * p);
    lp += cut * (noise() - lp);
    const tone = Math.sin(2 * Math.PI * (200 + 1400 * p) * t) * 0.08 * env;
    const s = (lp * 1.4 + tone) * env * 0.55;
    return [s * (1 - p * 0.4), s * (0.6 + p * 0.4)];
  });
}

/**
 * Soft air whoosh for the match cut and the dip: longer, darker and toneless,
 * so it reads as air moving rather than an object flying past.
 */
export function buildWhooshSoft() {
  const dur = 21 / FPS;
  const nl = noiseGenerator(0xdbee0008);
  const nr = noiseGenerator(0xdbee0009);
  let ll = 0;
  let lr = 0;
  return render(dur, (t) => {
    const p = t / dur;
    const env = Math.sin(Math.PI * p) ** 2;
    const cut = 0.012 + 0.07 * Math.sin(Math.PI * p);
    ll += cut * (nl() - ll);
    lr += cut * (nr() - lr);
    const s = env * 0.75;
    return [ll * s * (1 - p * 0.3), lr * s * (0.7 + p * 0.3)];
  });
}

/**
 * Riser into the end card: a soft, heavily filtered air swell with a warm
 * rising tone. The envelope is p³, so its LAST sample is its peak — place it to
 * end exactly on CTA_HIT_ABS (36 frames = 1.2 s).
 */
export function buildRiser() {
  const dur = 1.2;
  const noise = noiseGenerator(0xdbee0005);
  let lp = 0;
  return render(dur, (t) => {
    const p = t / dur;
    const cut = 0.006 + 0.05 * p * p;
    lp += cut * (noise() - lp);
    const tone = Math.sin(2 * Math.PI * (200 + 420 * p * p) * t) * 0.08 * p;
    const s = (lp * 1.1 + tone) * p * p * p * 0.32;
    return [s * (1 - p * 0.12), s * (0.88 + p * 0.12)];
  });
}

/**
 * CTA impact v2 — a hit that survives small speakers. Four layers:
 * - a saturated 190 → 110 Hz pitch-drop body: harmonics a phone/laptop speaker
 *   can reproduce (v5's impact was 99% below 150 Hz and vanished on them);
 * - a ≤30 ms band-passed 1–3 kHz crack for the transient (short, so it never
 *   reads as a snare);
 * - the low bloom: a 70 → 40 Hz drop plus a sub on F#1 (46.25 Hz, the key's
 *   root; v5's 44 Hz sat ~1 semitone flat);
 * - a decorrelated airy tail that widens the stereo image as it rings out.
 * 45 frames (1.5 s), so IMPACT_FRAMES plays it whole.
 */
export function buildImpact() {
  const dur = 1.5;
  const nl = noiseGenerator(0xdbee0006);
  const nr = noiseGenerator(0xdbee000a);
  const nc = noiseGenerator(0xdbee000b);
  const crackFilter = bandPass(1800, 0.75);
  const sub = noteFreq(-39); // F#1
  let phLow = 0;
  let phMid = 0;
  let airL = 0;
  let airR = 0;
  return render(dur, (t) => {
    const attack = Math.min(1, t / 0.004);
    const fLow = 70 - 30 * Math.min(1, t / 0.6);
    phLow += (2 * Math.PI * fLow) / SR;
    const low = Math.sin(phLow) * Math.exp(-t * 4.2) * 0.24 * attack;
    const bloom = Math.sin(2 * Math.PI * sub * t) * (1 - Math.exp(-t / 0.02)) * Math.exp(-t * 3.2) * 0.22;
    const fMid = 110 + 80 * Math.exp(-t / 0.045); // 190 → 110 Hz
    phMid += (2 * Math.PI * fMid) / SR;
    // Driven hard (tanh ×9, near-square) so its odd harmonics carry the hit on small speakers.
    const mid = Math.tanh(9 * Math.sin(phMid)) * Math.exp(-t * 6) * 0.6 * attack;
    const crackEnv = Math.min(1, t / 0.0005) * Math.exp(-t / 0.012) * (1 - smoothstep(0.02, 0.03, t));
    const crack = crackFilter(nc()) * crackEnv * 2.6;
    airL += 0.02 * (nl() - airL);
    airR += 0.02 * (nr() - airR);
    const tailEnv = Math.sin(Math.PI * Math.min(1, t / dur)) * 0.2;
    const core = low + bloom + mid;
    return [
      Math.tanh((core + crack + airL * tailEnv) * 1.05) * 0.72,
      Math.tanh((core + crack * 0.9 + airR * tailEnv) * 1.05) * 0.72,
    ];
  });
}

// ─── Kit ─────────────────────────────────────────────────────────────────────

/**
 * Every file the kit writes. Aliases (click, pop, tick) are byte copies of
 * variant 1, kept so code that plays "the click" keeps working unchanged.
 */
export const SFX_KIT = {
  "click-1": () => buildClick(1),
  "click-2": () => buildClick(2),
  "click-3": () => buildClick(3),
  "pop-1": () => buildPop(1),
  "pop-2": () => buildPop(2),
  "pop-3": () => buildPop(3),
  "tick-1": () => buildTick(1),
  "tick-2": () => buildTick(2),
  "tick-3": () => buildTick(3),
  chime: buildChime,
  shimmer: buildShimmer,
  ping: buildPing,
  whoosh: buildWhoosh,
  "whoosh-soft": buildWhooshSoft,
  riser: buildRiser,
  impact: buildImpact,
};
export const SFX_ALIASES = { click: "click-1", pop: "pop-1", tick: "tick-1" };

/** Write the kit + sfx.json (every file's length in frames). Returns the table. */
export function buildSfxKit(outDir = AUDIO_DIR) {
  const sounds = {};
  for (const [name, build] of Object.entries(SFX_KIT)) {
    const { L, R } = build();
    writeWav16(path.join(outDir, `${name}.wav`), L, R, SR);
    sounds[name] = {
      file: `audio/${name}.wav`,
      frames: Math.ceil((L.length / SR) * FPS - 1e-9),
      sec: Number((L.length / SR).toFixed(4)),
      peakDbfs: Number(dbfs(peak([L, R])).toFixed(2)),
    };
  }
  for (const [alias, of] of Object.entries(SFX_ALIASES)) {
    fs.copyFileSync(path.join(outDir, `${of}.wav`), path.join(outDir, `${alias}.wav`));
    sounds[alias] = { ...sounds[of], file: `audio/${alias}.wav`, aliasOf: of };
  }
  const table = { fps: FPS, sampleRate: SR, sounds };
  fs.writeFileSync(path.join(outDir, "sfx.json"), JSON.stringify(table, null, 2) + "\n");
  console.log(
    `SFX kit: ${Object.keys(sounds).length} files — ` +
      Object.entries(sounds)
        .filter(([, s]) => !s.aliasOf)
        .map(([n, s]) => `${n} ${s.frames}f`)
        .join(", "),
  );
  return table;
}

// ─── Synthesized stand-in score (--synth-music) ──────────────────────────────
// For machines without the licensed track: warm pads + a sustained sub, no
// percussion, following the SAME plan as the real edit — the chord changes on
// the edit's section marks, a noise swell into the drop, a bloom on it — so
// every music cue the picture keys to stays valid.

const PROG = [
  [-15, -3, 0, 4, 9, 12], // F#m
  [-12, 0, 4, 7, 12, 16], // A
  [-19, -7, 0, 5, 9, 12], // D
  [-22, -10, -1, 3, 6, 11], // B (sus feel)
];

export function buildSynthMusic(plan) {
  const sr = MUSIC_SAMPLE_RATE;
  const total = plan.total;
  const n = Math.round(total * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const noise = noiseGenerator(0xdbee0001);
  const duck = duckCurve(plan.spans);
  const marks = plan.report.marks;
  const drop = marks.dropFrame / plan.fps;
  const barLen = plan.report.grid.barSec;
  const mainA = marks.mainAFrame / plan.fps;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const bar = Math.floor((t - mainA) / barLen);
    const chord = PROG[((bar % 4) + 4) % 4];
    let padL = 0;
    let padR = 0;
    chord.forEach((semi, v) => {
      const f = noteFreq(semi);
      const sh = 1 + 0.0016 * Math.sin(2 * Math.PI * 4.5 * t + v * 1.7);
      padL += Math.sin(2 * Math.PI * f * sh * t) / chord.length;
      padR += Math.sin(2 * Math.PI * f * 1.004 * sh * t) / chord.length;
    });
    const energy = t < mainA ? 0.55 : t < drop - 6 ? 0.8 : t < drop ? 0.6 : 1;
    const bass = Math.sin(2 * Math.PI * noteFreq(chord[0] - 12) * t) * 0.3 * smoothstep(0.6, 3, t);
    const rise = t > drop - 2 && t < drop ? noise() * ((t - (drop - 2)) / 2) ** 3 * 0.15 : 0;
    const bloom = t >= drop ? Math.sin(2 * Math.PI * 46.25 * (t - drop)) * Math.exp(-(t - drop) * 3) * 0.4 : 0;
    const fade = smoothstep(0, 0.8, t) * (1 - smoothstep(total - 1.5, total, t));
    // 0.285: the stand-in measures the same integrated loudness as the licensed
    // edit (≈ -24 LUFS), so MUSIC_BASE balances either bed against the narration.
    const g = fade * duck(t) * 0.285;
    L[i] = Math.tanh((padL * energy + bass + rise + bloom) * 1.1) * g;
    R[i] = Math.tanh((padR * energy + bass + rise + bloom) * 1.1) * g;
  }
  writeWav16(path.join(AUDIO_DIR, "music.wav"), L, R, sr);
  console.log(`music.wav: ${total.toFixed(2)} s — SYNTHESIZED stand-in (no licensed track)`);
  return { source: "synth", sampleRate: sr, peakDbfs: Number(dbfs(peak([L, R])).toFixed(2)), ...plan.report };
}
