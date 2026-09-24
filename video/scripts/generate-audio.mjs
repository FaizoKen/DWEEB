// The film's audio pipeline: voice-over takes → manifest (the film clock) →
// music edit → SFX kit.
//
//   npm run audio                          # reuse every take whose script is unchanged
//   npm run audio -- --rerecord=send,cta   # re-record just these lines
//   npm run audio -- --rerecord=all        # a fresh session for all nine lines
//   npm run audio -- --synth-music         # no licensed track: synthesized fallback bed
//   npm run audio -- --no-music --no-sfx   # VO + manifest only
//
// VOICE-OVER. Microsoft Edge neural TTS via msedge-tts, one 96 kbps CBR mono mp3
// per line plus its word boundaries (<id>.words.json). Takes are NOT
// reproducible — re-synthesizing the same text moves words by up to ~0.35 s —
// so a take is reused (and its words re-derived from its sidecar) whenever the
// sidecar's text, rate, pitch, voice and format still match LINES and the mp3's
// sha256 still matches the one the sidecar recorded. Only changed lines, or lines
// named in --rerecord, go back to the network. There is exactly one voice: if it
// is unavailable the script throws instead of quietly recording another one.
//
// MANIFEST v2 (public/audio/manifest.json, committed) is the film clock: per
// line its exact mp3 duration, frames, gapAfter, startFrame, every word's
// start/end (seconds from the mp3 start, as heard) and the speech span.
// src/timeline.ts derives every scene cut and every at() word anchor from it,
// and the music edit derives its anchors from it — so a re-record re-times the
// picture and re-edits the score in one run.

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUDIO_DIR,
  FPS,
  END_HOLD,
  LEAD_IN,
  FRAME_PAD,
  layoutTimeline,
  lineFrames,
  readSceneConstants,
  writeManifest,
  MANIFEST_PATH,
} from "./lib/film-timing.mjs";
import {
  CODEC_DELAY_SEC,
  TTS_SAMPLE_RATE,
  coverage,
  gapReport,
  takeIssues,
  wordsFromMetadata,
} from "./lib/vo-words.mjs";
import { decodeToWav } from "./lib/ffmpeg.mjs";
import { readWav } from "./lib/wav.mjs";
import { integrated } from "./lib/loudness.mjs";

const VOICE = "en-US-AndrewMultilingualNeural";
// 96 kbps CBR mono mp3: 288-byte frames of 576 samples at 24 kHz, so the
// duration is exactly bytes / 12000 (cross-checked against a decode below).
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;
const BYTES_PER_SEC = 12000;
// Every take is normalized to this integrated loudness by a per-line gain the
// film applies (src/audio.ts voiceVolume): TTS lines vary by ~2 LU, which reads
// as the narrator moving toward and away from the mic and makes the bed sit
// unevenly under him. A FIXED target (not the session mean) means re-recording
// one line never changes another line's gain.
const VO_TARGET_LUFS = -21;
const MAX_LINE_GAIN_DB = 3;

// ─── Voice-over script (v6) ──────────────────────────────────────────────────
// One Season 4 campaign message travels from plain text to a working message in
// the server; Activity is a short coda. `rate` is per line: the hook and the
// assistant line run slower (+4%) because they carry the most on-screen action.
// `gapAfter` gives each scene its payoff beat before the next line leads in —
// send's 34 frames are the delivery + giveaway-click moment.
const LINES = [
  {
    id: "hook",
    rate: "+4%",
    gapAfter: 12,
    text: "Here's a boring Discord message. Let's turn it into something better.",
  },
  {
    id: "reveal",
    rate: "+8%",
    gapAfter: 10,
    text: "Meet DWEEB: the visual Discord message builder for webhooks, embeds, and Components V2.",
  },
  {
    id: "templates",
    rate: "+8%",
    gapAfter: 10,
    text: "Start with a ready-made template, then make every detail yours.",
  },
  {
    id: "build",
    rate: "+8%",
    gapAfter: 12,
    text: "Shape it with real Discord components while a high-fidelity preview updates live, and every limit is checked for you.",
  },
  {
    id: "assistant",
    rate: "+4%",
    gapAfter: 10,
    text: "Got another idea? Ask the AI assistant to add it directly to the message.",
  },
  {
    id: "plugins",
    rate: "+8%",
    gapAfter: 10,
    text: "Then turn that button into a real giveaway. Visual plugins power tickets, roles, forms, and more.",
  },
  {
    id: "send",
    rate: "+8%",
    gapAfter: 34,
    text: "Pick a channel and send. DWEEB handles the webhook. The moment it lands, your giveaway is live.",
  },
  {
    id: "activity",
    rate: "+8%",
    gapAfter: 14,
    text: "Need another pair of hands? Invite your team, then build together inside Discord — in real time.",
  },
  // The destination is shown under the end-card search bar, never spoken.
  { id: "cta", rate: "+8%", gapAfter: 0, text: "Build better Discord messages. Start free today." },
].map((l) => ({ pitch: "+0Hz", ...l }));

// ─── CLI ─────────────────────────────────────────────────────────────────────
const argValue = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const hasFlag = (name) => process.argv.includes(`--${name}`);

// `--only=` is the v5 spelling of the same thing; kept so old notes still work.
const rerecordArg = argValue("rerecord") ?? argValue("only");
const RERECORD =
  rerecordArg === "all"
    ? new Set(LINES.map((l) => l.id))
    : new Set((rerecordArg ?? "").split(",").filter(Boolean));
for (const id of RERECORD) {
  if (!LINES.some((l) => l.id === id)) throw new Error(`--rerecord: unknown line "${id}"`);
}

// Sanity: the script's lines must be exactly the picture's scenes, in order.
{
  const { SCENE_IDS } = readSceneConstants();
  const ids = LINES.map((l) => l.id).join(",");
  if (ids !== SCENE_IDS.join(",")) {
    throw new Error(`LINES (${ids}) must match SCENE_IDS in src/timeline.ts (${SCENE_IDS.join(",")})`);
  }
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const textHash = (text) => sha256(Buffer.from(text, "utf8"));

// ─── TTS session ─────────────────────────────────────────────────────────────
const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const REQUEST_TIMEOUT_MS = 45_000;

class TtsSession {
  tts = null;

  async open() {
    this.close();
    this.tts = new MsEdgeTTS();
    try {
      await this.tts.setMetadata(VOICE, FORMAT, { wordBoundaryEnabled: true });
    } catch (e) {
      throw new Error(
        `TTS voice ${VOICE} is unavailable (${e?.message ?? e}). Refusing to record the ` +
          `line in a different voice — retry later, or keep the committed takes.`,
      );
    }
  }

  close() {
    try {
      this.tts?.close();
    } catch {
      // already closed
    }
    this.tts = null;
  }

  /** One request → `{ mp3: Buffer, metadata: object }`. */
  async synthesize(line) {
    if (!this.tts) await this.open();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dweeb-tts-${line.id}-`));
    try {
      const request = this.tts.toFile(dir, escapeXml(line.text), { rate: line.rate, pitch: line.pitch });
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("TTS request timed out")), REQUEST_TIMEOUT_MS);
      });
      const { audioFilePath, metadataFilePath } = await Promise.race([request, timeout]).finally(() =>
        clearTimeout(timer),
      );
      if (!metadataFilePath) throw new Error("TTS returned no word-boundary metadata");
      return {
        mp3: fs.readFileSync(audioFilePath),
        metadata: JSON.parse(fs.readFileSync(metadataFilePath, "utf8")),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ─── Takes ───────────────────────────────────────────────────────────────────
const mp3Path = (id) => path.join(AUDIO_DIR, `${id}.mp3`);
const wordsPath = (id) => path.join(AUDIO_DIR, `${id}.words.json`);

/** Write via a temp file + rename so a concurrent bundle never reads a half-written file. */
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Why a line must be (re-)recorded, or null to reuse its take. The word sidecar
 * is self-describing — it names the script, prosody and the sha256 of the exact
 * mp3 it belongs to — so reuse needs no manifest: a fresh clone, a deleted
 * manifest, or a take restored by copying its two files all re-manifest offline.
 */
function reusable(line) {
  if (RERECORD.has(line.id)) return "re-record requested";
  if (!fs.existsSync(mp3Path(line.id))) return "no mp3";
  if (!fs.existsSync(wordsPath(line.id))) return "no word sidecar (pre-v6 take)";
  const sidecar = JSON.parse(fs.readFileSync(wordsPath(line.id), "utf8"));
  for (const key of ["text", "rate", "pitch"]) {
    if (sidecar[key] !== line[key]) return `${key} changed`;
  }
  if (sidecar.voice !== VOICE || sidecar.format !== FORMAT) return "voice/format changed";
  if (sidecar.mp3Sha256 !== sha256(fs.readFileSync(mp3Path(line.id)))) {
    return "mp3 does not match its word sidecar";
  }
  return null;
}

/**
 * Decode a take (with the renderer's own ffmpeg) and measure what the manifest
 * cross-checks: its decoded length, where speech resumes after each pause, and
 * its integrated loudness.
 */
function analyseDecoded(mp3File) {
  const tmp = path.join(os.tmpdir(), `dweeb-vo-${process.pid}-${path.basename(mp3File)}.wav`);
  try {
    decodeToWav(mp3File, tmp);
    const wav = readWav(tmp);
    if (wav.sampleRate !== TTS_SAMPLE_RATE) throw new Error(`${mp3File}: decoded at ${wav.sampleRate} Hz`);
    const x = wav.data[0];
    // 2 ms energy frames; an onset is the first frame above -45 dBFS after at
    // least 60 ms below -55 dBFS (a real pause, not a stop consonant).
    const hop = Math.round(wav.sampleRate * 0.002);
    const env = [];
    for (let i = 0; i + hop <= x.length; i += hop) {
      let s = 0;
      for (let j = i; j < i + hop; j++) s += x[j] * x[j];
      env.push(10 * Math.log10(s / hop + 1e-12));
    }
    const onsets = [];
    let quiet = 30; // treat the file start as preceded by silence
    for (let k = 0; k < env.length; k++) {
      if (env[k] < -55) quiet++;
      else {
        if (env[k] > -45 && quiet >= 30) onsets.push((k * hop) / wav.sampleRate);
        if (env[k] > -45) quiet = 0;
      }
    }
    return { decodedSec: wav.length / wav.sampleRate, onsets, integratedLufs: integrated([x], wav.sampleRate) };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Build the manifest entry for a take already on disk. */
function describeTake(line) {
  const mp3 = fs.readFileSync(mp3Path(line.id));
  const sidecar = JSON.parse(fs.readFileSync(wordsPath(line.id), "utf8"));
  const words = wordsFromMetadata(sidecar);
  const cov = coverage(line.text, words);
  if (!cov.ok) throw new Error(`${line.id}: ${cov.detail}`);
  const durationSec = mp3.length / BYTES_PER_SEC;
  const { decodedSec, onsets, integratedLufs } = analyseDecoded(mp3Path(line.id));
  const gainDb = Math.max(-MAX_LINE_GAIN_DB, Math.min(MAX_LINE_GAIN_DB, VO_TARGET_LUFS - integratedLufs));
  if (Math.abs(decodedSec - durationSec) > 0.001) {
    throw new Error(
      `${line.id}: decoded ${decodedSec.toFixed(4)} s but bytes/12000 = ${durationSec.toFixed(4)} s — ` +
        `the take is not the CBR stream this pipeline assumes`,
    );
  }
  const last = words[words.length - 1];
  if (last.end > durationSec) throw new Error(`${line.id}: last word ends after the mp3 does`);
  // Codec-delay check: each measured onset after a pause vs the nearest word start.
  const offsets = onsets
    .map((t) => {
      const w = words.reduce((a, b) => (Math.abs(b.start - t) < Math.abs(a.start - t) ? b : a));
      return t - w.start;
    })
    .filter((d) => Math.abs(d) < 0.12);
  return {
    entry: {
      id: line.id,
      file: `audio/${line.id}.mp3`,
      wordsFile: `audio/${line.id}.words.json`,
      text: line.text,
      textHash: textHash(line.text),
      voice: VOICE,
      format: FORMAT,
      rate: line.rate,
      pitch: line.pitch,
      sha256: sha256(mp3),
      bytes: mp3.length,
      durationSec: Number(durationSec.toFixed(3)),
      frames: lineFrames(durationSec),
      gapAfter: line.gapAfter,
      words,
      speech: { start: words[0].start, end: last.end },
      loudness: { integratedLufs: Number(integratedLufs.toFixed(2)), gainDb: Number(gainDb.toFixed(2)) },
    },
    onsetOffsets: offsets,
  };
}

const MAX_TAKES = 3;

async function recordLine(session, line) {
  let best = null;
  for (let take = 1; take <= MAX_TAKES; take++) {
    let result;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await session.synthesize(line);
        break;
      } catch (e) {
        session.close();
        if (attempt >= 3) throw new Error(`${line.id}: TTS failed 3 times: ${e?.message ?? e}`);
        console.warn(`  ${line.id}: ${e?.message ?? e} — reconnecting (attempt ${attempt + 1})`);
        await session.open();
      }
    }
    const words = wordsFromMetadata(result.metadata);
    const cov = words.length ? coverage(line.text, words) : { ok: false, detail: "no words" };
    const issues = cov.ok ? takeIssues(line.text, words) : [cov.detail];
    const candidate = { ...result, issues, complete: cov.ok };
    if (!best || (candidate.complete && (!best.complete || issues.length < best.issues.length))) {
      best = candidate;
    }
    if (candidate.complete && issues.length === 0) break;
    console.warn(`  ${line.id}: take ${take} — ${issues.join("; ")}`);
  }
  if (!best.complete) throw new Error(`${line.id}: no take had a complete word list`);
  if (best.issues.length) console.warn(`  ${line.id}: keeping the best take (${best.issues.join("; ")})`);
  const shaMp3 = sha256(best.mp3);
  atomicWrite(mp3Path(line.id), best.mp3);
  atomicWrite(
    wordsPath(line.id),
    JSON.stringify(
      {
        id: line.id,
        text: line.text,
        voice: VOICE,
        format: FORMAT,
        rate: line.rate,
        pitch: line.pitch,
        mp3Sha256: shaMp3,
        recordedAt: new Date().toISOString(),
        // Exactly what the service sent (Offset/Duration in 100-ns ticks).
        Metadata: best.metadata.Metadata,
      },
      null,
      2,
    ) + "\n",
  );
}

async function voiceOver() {
  const plan = LINES.map((line) => ({ line, why: reusable(line) }));
  const toRecord = plan.filter((p) => p.why);
  const session = new TtsSession();
  try {
    if (toRecord.length) {
      console.log(`Recording ${toRecord.length} line(s) with ${VOICE}:`);
      await session.open();
    }
    for (const { line, why } of plan) {
      if (why) {
        console.log(`  ${line.id} (${why}) …`);
        await recordLine(session, line);
      }
    }
  } finally {
    session.close();
  }

  const lines = [];
  const allOffsets = [];
  for (const { line, why } of plan) {
    const { entry, onsetOffsets } = describeTake(line);
    lines.push(entry);
    allOffsets.push(...onsetOffsets);
    const verb = why ? "recorded" : "reused  ";
    console.log(
      `${verb} ${line.id.padEnd(9)} ${entry.durationSec.toFixed(3)} s  ${String(entry.frames).padStart(3)} f  ` +
        `speech ${entry.speech.start.toFixed(3)}–${entry.speech.end.toFixed(3)} s  ${entry.words.length} words  ${line.rate}`,
    );
  }
  // The decoded audio must agree with the word timings: speech onsets after
  // pauses land on word starts once the codec delay is added. A large residual
  // would mean the delay model is wrong and every at() anchor is off.
  if (allOffsets.length) {
    const sorted = [...allOffsets].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(
      `word timing check: ${sorted.length} pause→speech onsets sit ${(median * 1000).toFixed(0)} ms ` +
        `(median) from their word starts (codec delay ${(CODEC_DELAY_SEC * 1000).toFixed(1)} ms applied)`,
    );
    if (Math.abs(median) > 0.035) {
      throw new Error("decoded speech onsets disagree with the word timings by > 35 ms — check the delay model");
    }
  }
  return lines;
}

function printWords(lines) {
  for (const l of lines) {
    const rows = gapReport(l.text, l.words);
    console.log(
      `  ${l.id}: ` +
        rows.map((r) => `${r.word}${r.punct}@${r.start.toFixed(2)}${r.gapAfter != null && r.gapAfter > 0.08 ? ` ⟨${r.gapAfter.toFixed(2)}⟩` : ""}`).join(" "),
    );
  }
}

const main = async () => {
  const previous = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) : null;
  const lines = await voiceOver();
  const { timeline, totalFrames, totalSec } = layoutTimeline(lines);
  const manifest = {
    version: 2,
    fps: FPS,
    voice: VOICE,
    format: FORMAT,
    codecDelaySec: Number(CODEC_DELAY_SEC.toFixed(5)),
    voTargetLufs: VO_TARGET_LUFS,
    leadIn: LEAD_IN,
    framePad: FRAME_PAD,
    endHold: END_HOLD,
    lines,
    timeline,
    totalFrames,
    totalSec,
    // Written by the music edit (kept across VO-only runs until it is rebuilt).
    ...(previous?.music ? { music: previous.music } : {}),
  };
  writeManifest(manifest);
  if (hasFlag("words")) printWords(lines);
  console.log(`\nTotal: ${totalSec.toFixed(2)} s (${totalFrames} frames)`);
  if (totalSec >= 60) throw new Error("The film must stay under 60 s.");

  // Loaded lazily so a VO-only run never needs the music/SFX code paths.
  if (!hasFlag("no-music")) {
    const { buildFilmMusic } = await import("./lib/music-edit.mjs");
    const music = await buildFilmMusic(manifest, { synth: hasFlag("synth-music") });
    writeManifest({ ...manifest, music });
  }
  if (!hasFlag("no-sfx")) {
    const { buildSfxKit } = await import("./audio-synth.mjs");
    buildSfxKit();
  }
  console.log("manifest.json written.");
};

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
