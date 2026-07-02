// Shared audio synthesis — the music score and the whole UI SFX kit, written as
// raw PCM WAV (44.1kHz stereo). No ffmpeg/python and, crucially, NO network: this
// module is imported by both `generate-audio.mjs` (full bed incl. TTS) and
// `generate-sfx.mjs` (SFX only, runnable offline), so the sound-design kit can be
// regenerated without re-recording the voice-over.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SR = 44100;

export function writeWav(OUT, filename, L, R) {
  const n = L.length;
  const buffer = Buffer.alloc(44 + n * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + n * 4, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i]));
    const r = Math.max(-1, Math.min(1, R[i]));
    buffer.writeInt16LE((l * 32767) | 0, 44 + i * 4);
    buffer.writeInt16LE((r * 32767) | 0, 44 + i * 4 + 2);
  }
  fs.writeFileSync(path.join(OUT, filename), buffer);
}

export const noteFreq = (semisFromA4) => 440 * Math.pow(2, semisFromA4 / 12);
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ─── Music score ─────────────────────────────────────────────────────────────
// A calm ambient bed for the launch film: warm chord pads + a sustained sub
// bass, nothing else. NO percussion of any kind — no kick, hats, claps, arps
// or pulsing envelopes; every repeating "tick/thud" element proved distracting
// under 70+ seconds of narration. The only dynamics are:
//   riseSec — a soft noise swell into the end card
//   ctaSec  — one impact, then the chords bloom and ring out
// Chord changes stay aligned to the scene cut points so the music "turns"
// exactly when the picture does.

// Progression (semitones from A4) — Am · F · C · G feel, warm and hopeful.
const PROG = [
  [-24, -12, -5, 0, 4, 7], // Am
  [-29, -9, -2, 3, 5, 12], // F
  [-24, -7, 0, 5, 9, 12], // C
  [-22, -5, 2, 7, 11, 14], // G
];
// Sidechain-style duck under the narration, baked into the file: the film
// then plays music at a CONSTANT volume. (A per-frame volume function on a
// long track expands to a huge ffmpeg expression — over the Windows
// command-line limit — so the duck must live in the waveform, not the prop.)
function duckCurve(voWindows, duckTo) {
  return (t) => {
    let active = 0;
    for (const w of voWindows) {
      const on = smoothstep(w.start - 0.25, w.start + 0.1, t) * (1 - smoothstep(w.end - 0.15, w.end + 0.45, t));
      active = Math.max(active, on);
    }
    return 1 - active * (1 - duckTo);
  };
}

/** The licensed bed (Pavel Yudin — "Tech Corporate", Pixabay). If this file
 *  sits in public/audio, the music step bakes IT into music.wav; otherwise the
 *  synthesized ambient bed below is used as a fallback. */
export const MUSIC_TRACK = "paulyudin-tech-corporate-182507.mp3";

/** Decode the licensed track (via Remotion's bundled ffmpeg — its slim build
 *  has no raw-PCM muxer, so decode to a temp WAV file), trim it to the film,
 *  duck it under every VO line and write it as music.wav. */
export function buildMusicFromTrack(OUT, srcPath, totalSec, voWindows = []) {
  const tmp = path.join(OUT, "_track-decode.tmp.wav");
  const res = spawnSync(
    "npx",
    ["remotion", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
     "-i", srcPath, "-t", totalSec.toFixed(3),
     "-ac", "2", "-ar", String(SR), "-c:a", "pcm_s16le", tmp],
    { maxBuffer: 1 << 30, shell: process.platform === "win32" },
  );
  if (res.status !== 0 || !fs.existsSync(tmp)) {
    throw new Error(`ffmpeg decode of ${srcPath} failed: ${res.stderr?.toString() ?? "no output"}`);
  }
  const wav = fs.readFileSync(tmp);
  fs.rmSync(tmp);
  // Locate the data chunk (header layout can vary — LIST chunks etc.).
  const dataAt = wav.indexOf(Buffer.from("data"), 12);
  if (dataAt < 0) throw new Error("decoded wav has no data chunk");
  const raw = wav.subarray(dataAt + 8);
  const nAvail = Math.floor(raw.length / 4);
  if (nAvail < SR) throw new Error("decoded wav is unexpectedly short");
  const n = Math.floor(totalSec * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const duckAt = duckCurve(voWindows, 0.4);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const idx = (i < nAvail ? i : i % nAvail) * 4; // loop if the track runs short
    const fade = smoothstep(0, 1.4, t) * smoothstep(0, 2.6, totalSec - t);
    const g = 0.9 * fade * duckAt(t);
    L[i] = (raw.readInt16LE(idx) / 32768) * g;
    R[i] = (raw.readInt16LE(idx + 2) / 32768) * g;
  }
  writeWav(OUT, "music.wav", L, R);
  console.log(`music.wav: ${totalSec.toFixed(1)}s (from ${path.basename(srcPath)}, duck baked in)`);
}

/** Bake music.wav from the licensed track when present, else synthesize. */
export function buildMusicAuto(OUT, totalSec, cutSecs, marks, voWindows = []) {
  const track = path.join(OUT, MUSIC_TRACK);
  if (fs.existsSync(track)) {
    buildMusicFromTrack(OUT, track, totalSec, voWindows);
  } else {
    console.warn(`${MUSIC_TRACK} not found — using the synthesized fallback bed.`);
    buildMusic(OUT, totalSec, cutSecs, marks, voWindows);
  }
}

export function buildMusic(OUT, totalSec, cutSecs, marks, voWindows = []) {
  const { riseSec, ctaSec } = marks;
  const n = Math.floor(totalSec * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);

  const duckAt = duckCurve(voWindows, 0.45);

  const sectionAt = (t) => {
    let s = 0;
    for (let i = 0; i < cutSecs.length; i++) if (t >= cutSecs[i]) s = i;
    return s;
  };

  let lpL = 0, lpR = 0, hpPrev = 0, hp = 0;

  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const sec = sectionAt(t);
    const chord = PROG[sec % PROG.length];
    const root = noteFreq(chord[0]);

    let padL = 0, padR = 0;
    for (let v = 0; v < chord.length; v++) {
      const f = noteFreq(chord[v]);
      const sh = 1 + 0.0016 * Math.sin(2 * Math.PI * 4.5 * t + v * 1.7);
      const a = (0.5 / chord.length);
      padL += Math.sin(2 * Math.PI * f * sh * t) * a;
      padR += Math.sin(2 * Math.PI * f * 1.004 * sh * t) * a;
    }

    // Sustained sub bass — deliberately NOT pulsed per beat.
    const bass = Math.sin(2 * Math.PI * root * t) * 0.42 * smoothstep(0.6, 3, t);

    // Soft noise swell into the CTA (from riseSec), then the impact at ctaSec.
    let riser = 0;
    if (t > riseSec && t < ctaSec + 0.05) {
      const rp = clamp01((t - riseSec) / Math.max(0.001, ctaSec - riseSec));
      riser = (Math.random() * 2 - 1) * rp * rp * rp * 0.2;
    }
    let impact = 0;
    if (t >= ctaSec && t < ctaSec + 1.4) {
      const ip = t - ctaSec;
      impact =
        Math.sin(2 * Math.PI * (72 - ip * 30) * ip) * Math.exp(-ip * 3.6) * 0.62 +
        (Math.random() * 2 - 1) * Math.exp(-ip * 22) * 0.22;
    }

    const padLift = 1 + 0.25 * smoothstep(ctaSec - 0.1, ctaSec + 0.8, t); // chords bloom on the CTA
    const padMixL = padL * padLift + bass;
    const padMixR = padR * padLift + bass;

    let mL = padMixL * 0.42 + riser + impact;
    let mR = padMixR * 0.42 + riser + impact;

    const fade = smoothstep(0, 2, t) * smoothstep(0, 2.6, totalSec - t);
    const duck = duckAt(t);
    mL *= fade * duck; mR *= fade * duck;

    L[i] = Math.tanh(mL * 1.1) * 0.82;
    R[i] = Math.tanh(mR * 1.1) * 0.82;
  }

  const a = 0.32;
  for (let i = 0; i < n; i++) {
    lpL += a * (L[i] - lpL);
    lpR += a * (R[i] - lpR);
    const x = lpL * 0.92;
    hp = x - hpPrev + 0.999 * hp; hpPrev = x;
    L[i] = hp;
    R[i] = lpR * 0.92;
  }
  writeWav(OUT, "music.wav", L, R);
  console.log(`music.wav: ${totalSec.toFixed(1)}s`);
}

// ─── SFX kit ─────────────────────────────────────────────────────────────────

export function buildWhoosh(OUT) {
  const dur = 0.55;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, p = t / dur;
    const env = Math.sin(Math.PI * p) ** 1.4;
    const noise = Math.random() * 2 - 1;
    const cut = 0.02 + 0.16 * Math.sin(Math.PI * p);
    lp += cut * (noise - lp);
    const tone = Math.sin(2 * Math.PI * (200 + 1400 * p) * t) * 0.08 * env;
    const s = (lp * 1.4 + tone) * env * 0.55;
    L[i] = s * (1 - p * 0.4);
    R[i] = s * (0.6 + p * 0.4);
  }
  writeWav(OUT, "whoosh.wav", L, R);
  console.log("whoosh.wav");
}

export function buildClick(OUT) {
  const dur = 0.12;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 90);
    const body = Math.sin(2 * Math.PI * 1300 * t) * env * 0.3;
    const tick = (Math.random() * 2 - 1) * Math.exp(-t * 400) * 0.18;
    const s = body + tick;
    L[i] = s; R[i] = s;
  }
  writeWav(OUT, "click.wav", L, R);
  console.log("click.wav");
}

export function buildTick(OUT) {
  const dur = 0.05;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const s = (Math.random() * 2 - 1) * Math.exp(-t * 500) * 0.22 +
      Math.sin(2 * Math.PI * 2200 * t) * Math.exp(-t * 300) * 0.12;
    L[i] = s; R[i] = s;
  }
  writeWav(OUT, "tick.wav", L, R);
  console.log("tick.wav");
}

export function buildChime(OUT) {
  const dur = 0.7;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const f1 = noteFreq(3), f2 = noteFreq(10);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const n1 = Math.sin(2 * Math.PI * f1 * t) * Math.exp(-t * 5) * 0.3;
    const start2 = 0.11;
    const n2 = t > start2 ? Math.sin(2 * Math.PI * f2 * (t - start2)) * Math.exp(-(t - start2) * 4) * 0.3 : 0;
    const shimmer = Math.sin(2 * Math.PI * f2 * 2 * t) * Math.exp(-t * 8) * 0.06;
    const s = n1 + n2 + shimmer;
    L[i] = s; R[i] = s * 0.96;
  }
  writeWav(OUT, "chime.wav", L, R);
  console.log("chime.wav");
}

export function buildPop(OUT) {
  const dur = 0.18;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 40);
    const s = Math.sin(2 * Math.PI * (900 - t * 1500) * t) * env * 0.4;
    L[i] = s; R[i] = s;
  }
  writeWav(OUT, "pop.wav", L, R);
  console.log("pop.wav");
}

// Riser — a soft, airy swell rising into the CTA over ~1.2s. Deliberately gentle
// (heavily low-passed, no hiss) so it lifts the ear without the harsh "turbo
// spool" whoosh. Authored so the LAST sample is the peak: end it on the CTA.
export function buildRiser(OUT) {
  const dur = 1.2;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, p = t / dur;
    // gently filtered noise — low cutoff keeps it a soft "air" swell, not a hiss
    const noise = Math.random() * 2 - 1;
    const cut = 0.006 + 0.05 * p * p;
    lp += cut * (noise - lp);
    // a soft sweeping tone rising ~200 → ~620 Hz (kept low so it's warm)
    const tone = Math.sin(2 * Math.PI * (200 + 420 * p * p) * t) * 0.08 * p;
    const env = p * p * p; // hold back, then lift late
    const s = (lp * 1.1 + tone) * env * 0.32;
    L[i] = s * (1 - p * 0.12);
    R[i] = s * (0.88 + p * 0.12);
  }
  writeWav(OUT, "riser.wav", L, R);
  console.log("riser.wav");
}

// Impact — a warm, rounded low "bloom" that lands the CTA: a soft sub-drop with a
// gentle body and an airy tail. No bright noise crack, no aggressive boom — just
// enough weight to feel the climax land under the music.
export function buildImpact(OUT) {
  const dur = 1.5;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let air = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // soft low body: pitch drops 70 → ~40 Hz, gentle attack + medium decay
    const attack = Math.min(1, t / 0.012); // ~12ms fade-in removes the click
    const body = Math.sin(2 * Math.PI * (70 - 30 * Math.min(1, t / 0.6)) * t) * Math.exp(-t * 4.2) * 0.5 * attack;
    // warm sub reinforcement
    const sub = Math.sin(2 * Math.PI * 44 * t) * Math.exp(-t * 5) * 0.3 * attack;
    // a soft airy tail that swells then fades (no transient crack)
    const noise = Math.random() * 2 - 1;
    air += 0.02 * (noise - air);
    const tail = air * Math.sin(Math.PI * Math.min(1, t / dur)) * 0.25;
    const s = body + sub + tail;
    L[i] = Math.tanh(s * 1.05) * 0.7;
    R[i] = Math.tanh((body + sub + tail * 1.1) * 1.05) * 0.7;
  }
  writeWav(OUT, "impact.wav", L, R);
  console.log("impact.wav");
}

// Ping — a friendly two-note "message landed" notification (E5 → A5), soft
// attack and a short shimmer tail. Original, but reads instantly as "new
// message" next to the Discord mock.
export function buildPing(OUT) {
  const dur = 0.5;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const f1 = noteFreq(7); // E5
  const f2 = noteFreq(12); // A5
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const attack = Math.min(1, t / 0.008);
    const n1 = Math.sin(2 * Math.PI * f1 * t) * Math.exp(-t * 9) * 0.26 * attack;
    const s2 = 0.09;
    const n2 = t > s2 ? Math.sin(2 * Math.PI * f2 * (t - s2)) * Math.exp(-(t - s2) * 6) * 0.3 : 0;
    const air = Math.sin(2 * Math.PI * f2 * 2 * t) * Math.exp(-t * 12) * 0.05;
    const s = n1 + n2 + air;
    L[i] = s;
    R[i] = s * 0.94;
  }
  writeWav(OUT, "ping.wav", L, R);
  console.log("ping.wav");
}

export function buildAllSfx(OUT) {
  buildWhoosh(OUT);
  buildClick(OUT);
  buildTick(OUT);
  buildChime(OUT);
  buildPop(OUT);
  buildPing(OUT);
  buildRiser(OUT);
  buildImpact(OUT);
}
