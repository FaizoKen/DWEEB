// Generates the film's entire audio bed — neural voice-over (Microsoft Edge TTS,
// one mp3 per line), the original beat-synced score, and the UI SFX kit — all
// written to public/audio with a manifest carrying exact durations (in frames)
// so the visual timeline stays perfectly in sync with the voice.
//
// No ffmpeg/python required: TTS comes from msedge-tts as CBR 96kbps mp3 (so
// duration = bytes / 12000), and the music/SFX are synthesized as raw PCM WAV
// (see audio-synth.mjs). To regenerate ONLY the SFX (offline), use `npm run sfx`.

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMusicAuto, buildAllSfx } from "./audio-synth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "public", "audio");
fs.mkdirSync(OUT, { recursive: true });

const FPS = 30;

// 96 kbps CBR mono mp3 — twice the bitrate of the old 48 kbps bed, so the
// neural voice lands with noticeably fewer compression artifacts. CBR is exact
// (verified 2.000× byte ratio), so the duration estimate stays byte-derived:
// seconds = bytes / (96000 / 8) = bytes / 12000.
const TTS_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;
const BYTES_PER_SEC = 12000;

// ─── Voice-over ──────────────────────────────────────────────────────────────
// The continuity cut: one ordinary message gets a visual makeover, then travels
// from a template through refinement, an AI-assisted addition, plugin behavior,
// and finally publish.
// Activity is a short epilogue rather than a second product story. The language
// is intentionally compact: the picture demonstrates the feature while the VO
// states the benefit, keeping the whole film below a minute.
const LINES = [
  {
    id: "hook",
    gapAfter: 12,
    text: "Here's a boring Discord message. Let's turn it into something better.",
  },
  {
    id: "reveal",
    gapAfter: 10,
    text: "Meet DWEEB — the visual builder for Discord webhooks, embeds, and Components V2.",
  },
  {
    id: "templates",
    gapAfter: 10,
    text: "Start with a ready-made template, then make every detail yours.",
  },
  {
    id: "build",
    gapAfter: 12,
    text: "Shape it with real Discord components while a pixel-accurate preview updates live, and every limit is checked for you.",
  },
  {
    id: "assistant",
    gapAfter: 10,
    text: "Need another idea? Ask the AI assistant to add it directly to the message.",
  },
  {
    id: "plugins",
    gapAfter: 10,
    text: "Then turn that button into a real giveaway. Visual plugins power tickets, roles, forms, and more.",
  },
  {
    id: "send",
    gapAfter: 16,
    text: "Choose a channel and send. DWEEB finds or creates the webhook, then posts in one click.",
  },
  {
    id: "activity",
    gapAfter: 12,
    text: "Need another pair of hands? Invite your team, then build together inside Discord — in real time.",
  },
  // The destination is shown below the end-card search bar, never spoken.
  { id: "cta", gapAfter: 0, text: "Build better Discord messages. Start free today." },
];

const VOICE_CANDIDATES = [
  "en-US-AndrewMultilingualNeural",
  "en-US-AndrewNeural",
  "en-US-GuyNeural",
];

// `--only=cta` (comma list) re-records just those lines and reuses the existing
// mp3 for every other one, so a single-line rewording cannot drift the rest of
// the film's verified timings by a frame. Durations always come from the CBR
// byte math, so reused files re-manifest identically.
const ONLY =
  process.argv
    .find((a) => a.startsWith("--only="))
    ?.slice("--only=".length)
    .split(",")
    .filter(Boolean) ?? null;

async function synth() {
  const toRecord = LINES.filter((line) => {
    const file = path.join(OUT, `${line.id}.mp3`);
    return !ONLY || ONLY.includes(line.id) || !fs.existsSync(file);
  });

  let tts = null;
  if (toRecord.length > 0) {
    tts = new MsEdgeTTS();
    let chosen = null;
    for (const v of VOICE_CANDIDATES) {
      try {
        await tts.setMetadata(v, TTS_FORMAT);
        chosen = v;
        break;
      } catch (e) {
        console.warn(`voice ${v} unavailable: ${e?.message ?? e}`);
      }
    }
    if (!chosen) throw new Error("No usable TTS voice found.");
    console.log(`Using voice: ${chosen}`);
  }

  const manifest = { fps: FPS, voice: "en-US-AndrewMultilingualNeural", lines: [] };
  for (const line of LINES) {
    const file = path.join(OUT, `${line.id}.mp3`);
    if (toRecord.includes(line)) {
      const { audioFilePath } = await tts.toFile(OUT, line.text, {
        rate: "+8%",
        pitch: "+0Hz",
      });
      fs.renameSync(audioFilePath, file);
    } else {
      console.log(`${line.id}: reusing existing recording`);
    }
    const bytes = fs.statSync(file).size;
    const durationSec = bytes / BYTES_PER_SEC; // 96 kbps CBR mono mp3
    // +2 safety frames: the byte estimate can undershoot the decoded tail, and
    // this pad keeps the music duck covering the last syllable.
    const frames = Math.ceil(durationSec * FPS) + 2;
    manifest.lines.push({
      id: line.id,
      file: `audio/${line.id}.mp3`,
      text: line.text,
      durationSec: Number(durationSec.toFixed(3)),
      frames,
      gapAfter: line.gapAfter,
    });
    console.log(`${line.id}: ${durationSec.toFixed(2)}s (${frames}f)`);
  }
  tts?.close();
  return manifest;
}

const main = async () => {
  const manifest = await synth();

  // Lay lines back-to-back; each line's own gapAfter gives its scene room for a
  // payoff beat before the next line leads in.
  let cursor = 14;
  const timeline = [];
  for (const l of manifest.lines) {
    timeline.push({ ...l, startFrame: cursor });
    cursor += l.frames + l.gapAfter;
  }
  const totalFrames = cursor + 54; // confident hold on the end card
  manifest.timeline = timeline;
  manifest.totalFrames = totalFrames;
  manifest.totalSec = Number((totalFrames / FPS).toFixed(2));

  const at = (id) => timeline.find((l) => l.id === id).startFrame / FPS;
  const cutSecs = timeline.map((l) => l.startFrame / FPS);

  // Arrangement markers for the score — the music turns with the story:
  // drums enter at *build*, a lift at *templates* (the fast montage near the
  // end), a breakdown under *activity* (the calm "build together" beat), then
  // the riser starts 5s out and the impact lands on *cta*.
  const marks = {
    grooveSec: at("build"),
    liftSec: at("templates"),
    breakdownSec: at("activity"),
    riseSec: at("cta") - 5,
    ctaSec: at("cta"),
  };

  const voWindows = timeline.map((l) => ({
    start: l.startFrame / FPS,
    end: (l.startFrame + l.frames) / FPS,
  }));
  buildMusicAuto(OUT, totalFrames / FPS, cutSecs, marks, voWindows);
  buildAllSfx(OUT);

  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nTotal: ${manifest.totalSec}s (${totalFrames} frames)`);
  console.log("manifest.json written.");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
