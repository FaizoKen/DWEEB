// Generates the film's entire audio bed — neural voice-over (Microsoft Edge TTS,
// one mp3 per line), an original beat-synced music score, and a kit of UI sound
// effects — all written to public/audio with a manifest carrying exact durations
// (in frames) so the visual timeline stays perfectly in sync with the voice.
//
// No ffmpeg/python required: TTS comes from msedge-tts as CBR 48kbps mp3 (so
// duration = bytes / 6000), and the music/SFX are synthesized as raw PCM WAV.

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "public", "audio");
fs.mkdirSync(OUT, { recursive: true });

const FPS = 30;

// ─── Voice-over ──────────────────────────────────────────────────────────────
// Tighter, benefit-led copy. Each line is written so the camera has clear
// "moments" to hit (the bracketed words drive the shot design in the scenes).
const LINES = [
  { id: "vo1", text: "This is DWEEB. It enhances your Discord messages." },
  { id: "vo2", text: "Design rich, interactive messages right in your browser. Add text, media, and buttons, and watch a pixel-perfect preview update live." },
  { id: "vo3", text: "Then make them do things. Tickets, giveaways, self-roles, polls, forms — a whole library of plugins, one click away." },
  { id: "vo4", text: "Send it through your very own custom bot, straight into any channel." },
  { id: "vo5", text: "And your members get buttons that actually work." },
  { id: "vo6", text: "Scheduling, A.I., sharing, and so much more — every feature, completely free. Just search dweeb on Google." },
];

const VOICE_CANDIDATES = [
  "en-US-AndrewMultilingualNeural",
  "en-US-AndrewNeural",
  "en-US-GuyNeural",
];

async function synth() {
  const tts = new MsEdgeTTS();
  let chosen = null;
  for (const v of VOICE_CANDIDATES) {
    try {
      await tts.setMetadata(v, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      chosen = v;
      break;
    } catch (e) {
      console.warn(`voice ${v} unavailable: ${e?.message ?? e}`);
    }
  }
  if (!chosen) throw new Error("No usable TTS voice found.");
  console.log(`Using voice: ${chosen}`);

  const manifest = { fps: FPS, voice: chosen, lines: [] };
  for (const line of LINES) {
    const file = path.join(OUT, `${line.id}.mp3`);
    const { audioFilePath } = await tts.toFile(OUT, line.text, {
      rate: "+8%",
      pitch: "+0Hz",
    });
    fs.renameSync(audioFilePath, file);
    const bytes = fs.statSync(file).size;
    const durationSec = bytes / 6000; // 48 kbps CBR mono mp3
    const frames = Math.ceil(durationSec * FPS);
    manifest.lines.push({
      id: line.id,
      file: `audio/${line.id}.mp3`,
      text: line.text,
      durationSec: Number(durationSec.toFixed(3)),
      frames,
    });
    console.log(`${line.id}: ${durationSec.toFixed(2)}s (${frames}f)`);
  }
  tts.close();
  return manifest;
}

// ─── Synthesis helpers (raw PCM WAV, 44.1kHz stereo) ─────────────────────────

const SR = 44100;

function writeWav(filename, L, R) {
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

const noteFreq = (semisFromA4) => 440 * Math.pow(2, semisFromA4 / 12);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ─── Music score ─────────────────────────────────────────────────────────────
// Cinematic, optimistic tech bed. Energy ramps across the film, drops for a
// breath, then a riser lifts into the final CTA which lands on an impact.
// Chord changes are aligned to the voice-over cut points so the music "turns"
// exactly when the picture does.

const BPM = 112;
const SPB = 60 / BPM; // seconds per beat
// Progression (semitones from A4) — Am · F · C · G feel, warm and hopeful.
const PROG = [
  [-24, -12, -5, 0, 4, 7], // Am
  [-29, -9, -2, 3, 5, 12], // F
  [-24, -7, 0, 5, 9, 12], // C
  [-22, -5, 2, 7, 11, 14], // G
];

function buildMusic(totalSec, cutSecs, ctaSec) {
  const n = Math.floor(totalSec * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);

  // Section index from the voice-over cut points (chord turns on each cut).
  const sectionAt = (t) => {
    let s = 0;
    for (let i = 0; i < cutSecs.length; i++) if (t >= cutSecs[i]) s = i;
    return s;
  };
  // Energy envelope: builds, dips before the CTA for contrast, then swells.
  const energyAt = (t) => {
    const base = smoothstep(0, 3, t) * 0.5 + 0.5 * clamp01(t / totalSec);
    const dip = 1 - 0.45 * smoothstep(ctaSec - 2.2, ctaSec - 0.4, t) * (t < ctaSec ? 1 : 0);
    const lift = 0.5 + 0.5 * smoothstep(ctaSec - 0.2, ctaSec + 1.4, t);
    return clamp01(base * dip + (t >= ctaSec ? lift * 0.5 : 0));
  };

  let lpL = 0, lpR = 0, hpPrev = 0, hp = 0;
  let kickDuck = 0; // sidechain-style pump

  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const sec = sectionAt(t);
    const chord = PROG[sec % PROG.length];
    const energy = energyAt(t);
    const beat = t / SPB;
    const beatPhase = beat - Math.floor(beat);
    const root = noteFreq(chord[0]);

    // Evolving pad (chord tones, detuned for width, slow shimmer)
    let padL = 0, padR = 0;
    for (let v = 0; v < chord.length; v++) {
      const f = noteFreq(chord[v]);
      const sh = 1 + 0.0016 * Math.sin(2 * Math.PI * 4.5 * t + v * 1.7);
      const a = (0.5 / chord.length);
      padL += Math.sin(2 * Math.PI * f * sh * t) * a;
      padR += Math.sin(2 * Math.PI * f * 1.004 * sh * t) * a;
    }

    // Sub bass — root, with a soft pulse on every beat
    const bassEnv = 0.6 + 0.4 * Math.exp(-beatPhase * 4);
    const bass = Math.sin(2 * Math.PI * root * t) * 0.5 * bassEnv * smoothstep(0.6, 3, t);

    // Kick — synthesized, enters once the track opens up
    const kEnv = Math.exp(-beatPhase * 12);
    const kPitch = 110 - beatPhase * 70;
    const kickGate = smoothstep(1.4, 3.2, t) * (energy > 0.18 ? 1 : 0);
    const kick = Math.sin(2 * Math.PI * kPitch * t) * kEnv * 0.7 * kickGate;
    kickDuck = Math.max(kickDuck * 0.9992, kEnv * kickGate); // pump source

    // Hat — quiet off-beat noise tick for groove
    const eighth = (beat * 2) - Math.floor(beat * 2);
    const hatEnv = Math.exp(-eighth * 40);
    const hat = (Math.random() * 2 - 1) * hatEnv * 0.06 * smoothstep(4, 7, t) * energy;

    // Plucked arp — eighth notes up the chord, enters on the build
    const arpGate = smoothstep(cutSecs[1] ?? 3, (cutSecs[1] ?? 3) + 1.5, t);
    const step = Math.floor(beat * 2) % chord.length;
    const arpF = noteFreq(chord[step] + 12);
    const arpEnv = Math.exp(-eighth * 6);
    const arp = Math.sin(2 * Math.PI * arpF * t) * arpEnv * 0.14 * arpGate * energy;

    // Riser — filtered noise sweeping up into the CTA
    let riser = 0;
    if (t > ctaSec - 1.8 && t < ctaSec + 0.1) {
      const rp = clamp01((t - (ctaSec - 1.8)) / 1.9);
      const rn = (Math.random() * 2 - 1);
      riser = rn * rp * rp * 0.3;
    }
    // Impact — low boom + noise hit landing on the CTA
    let impact = 0;
    if (t >= ctaSec && t < ctaSec + 1.2) {
      const ip = t - ctaSec;
      impact =
        Math.sin(2 * Math.PI * (70 - ip * 30) * ip) * Math.exp(-ip * 4) * 0.6 +
        (Math.random() * 2 - 1) * Math.exp(-ip * 22) * 0.25;
    }

    // Sidechain pump applied to sustained elements
    const pump = 1 - kickDuck * 0.5;
    const padMix = (padL + bass) * pump;
    const padMixR = (padR + bass) * pump;

    let mL = padMix * 0.42 + arp + kick + hat + riser + impact;
    let mR = padMixR * 0.42 + arp * 0.9 + kick + hat * 0.8 + riser + impact;

    // Global swell + fades
    const fade = smoothstep(0, 2, t) * smoothstep(0, 2.2, totalSec - t);
    mL *= fade; mR *= fade;

    // gentle saturation
    L[i] = Math.tanh(mL * 1.1) * 0.82;
    R[i] = Math.tanh(mR * 1.1) * 0.82;
  }

  // one-pole lowpass to soften, plus DC blocker
  const a = 0.32;
  for (let i = 0; i < n; i++) {
    lpL += a * (L[i] - lpL);
    lpR += a * (R[i] - lpR);
    const x = lpL * 0.92;
    hp = x - hpPrev + 0.999 * hp; hpPrev = x;
    L[i] = hp;
    // mirror for R (independent DC blocker would be ideal; close enough)
    R[i] = lpR * 0.92;
  }
  writeWav("music.wav", L, R);
  console.log(`music.wav: ${totalSec.toFixed(1)}s`);
}

// ─── SFX kit ─────────────────────────────────────────────────────────────────

function buildWhoosh() {
  const dur = 0.55;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, p = t / dur;
    const env = Math.sin(Math.PI * p) ** 1.4;
    const noise = Math.random() * 2 - 1;
    // filter cutoff sweeps up then down -> classic "whoosh"
    const cut = 0.02 + 0.16 * Math.sin(Math.PI * p);
    lp += cut * (noise - lp);
    const tone = Math.sin(2 * Math.PI * (200 + 1400 * p) * t) * 0.08 * env;
    const s = (lp * 1.4 + tone) * env * 0.55;
    L[i] = s * (1 - p * 0.4);
    R[i] = s * (0.6 + p * 0.4);
  }
  writeWav("whoosh.wav", L, R);
  console.log("whoosh.wav");
}

function buildClick() {
  // Soft, modern UI click (for cursor presses / selections).
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
  writeWav("click.wav", L, R);
  console.log("click.wav");
}

function buildTick() {
  // Tiny keystroke tick for the search-bar typing.
  const dur = 0.05;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const s = (Math.random() * 2 - 1) * Math.exp(-t * 500) * 0.22 +
      Math.sin(2 * Math.PI * 2200 * t) * Math.exp(-t * 300) * 0.12;
    L[i] = s; R[i] = s;
  }
  writeWav("tick.wav", L, R);
  console.log("tick.wav");
}

function buildChime() {
  // Pleasant success chime (two-note, C->G up), for the reward claim.
  const dur = 0.7;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const f1 = noteFreq(3), f2 = noteFreq(10); // C5-ish, G5-ish
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const n1 = Math.sin(2 * Math.PI * f1 * t) * Math.exp(-t * 5) * 0.3;
    const start2 = 0.11;
    const n2 = t > start2 ? Math.sin(2 * Math.PI * f2 * (t - start2)) * Math.exp(-(t - start2) * 4) * 0.3 : 0;
    const shimmer = Math.sin(2 * Math.PI * f2 * 2 * t) * Math.exp(-t * 8) * 0.06;
    const s = n1 + n2 + shimmer;
    L[i] = s; R[i] = s * 0.96;
  }
  writeWav("chime.wav", L, R);
  console.log("chime.wav");
}

function buildPop() {
  const dur = 0.18;
  const n = Math.floor(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 40);
    const s = Math.sin(2 * Math.PI * (900 - t * 1500) * t) * env * 0.4;
    L[i] = s; R[i] = s;
  }
  writeWav("pop.wav", L, R);
  console.log("pop.wav");
}

const main = async () => {
  const manifest = await synth();

  // Lay lines back-to-back with gaps that give each scene room to breathe and
  // for the camera to travel between shots.
  const GAP = 16;
  let cursor = 12;
  const timeline = [];
  for (const l of manifest.lines) {
    timeline.push({ ...l, startFrame: cursor });
    cursor += l.frames + GAP;
  }
  const totalFrames = cursor + 30; // tail for the final hold
  manifest.timeline = timeline;
  manifest.totalFrames = totalFrames;
  manifest.totalSec = Number((totalFrames / FPS).toFixed(2));

  const cutSecs = timeline.map((l) => l.startFrame / FPS);
  const ctaSec = timeline[timeline.length - 1].startFrame / FPS; // last line = CTA

  buildMusic(totalFrames / FPS, cutSecs, ctaSec);
  buildWhoosh();
  buildClick();
  buildTick();
  buildChime();
  buildPop();

  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nTotal: ${manifest.totalSec}s (${totalFrames} frames)`);
  console.log("manifest.json written.");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
