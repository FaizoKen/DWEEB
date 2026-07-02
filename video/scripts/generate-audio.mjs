// Generates the film's entire audio bed — neural voice-over (Microsoft Edge TTS,
// one mp3 per line), the original beat-synced score, and the UI SFX kit — all
// written to public/audio with a manifest carrying exact durations (in frames)
// so the visual timeline stays perfectly in sync with the voice.
//
// No ffmpeg/python required: TTS comes from msedge-tts as CBR 48kbps mp3 (so
// duration = bytes / 6000), and the music/SFX are synthesized as raw PCM WAV
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

// ─── Voice-over ──────────────────────────────────────────────────────────────
// The simplified cut: one clear story — problem → product → build → describe it →
// make it do things → send → templates → build together → CTA. Nine lines, no
// prior Discord knowledge required. `gapAfter` (frames) gives a scene extra air
// after its line ends — room for a payoff beat (a message landing, chips popping)
// before the next scene leads in.
const LINES = [
  { id: "hook",      gapAfter: 20, text: "Every day, your server posts messages that look like this. They could look like this." },
  { id: "reveal",    gapAfter: 18, text: "This is DWEEB — the ultimate toolkit for fancy Discord messages." },
  { id: "build",     gapAfter: 16, text: "Design with Discord's real building blocks — containers, sections, media galleries, buttons, select menus — and watch a pixel-accurate preview update live, while DWEEB enforces Discord's limits for you." },
  { id: "assistant", gapAfter: 18, text: "Or just describe it — the built-in AI assistant drafts the whole message, right in your editor." },
  { id: "plugins",   gapAfter: 16, text: "Now make it do things. Select a button, pick a plugin — support tickets, giveaways, role menus, pop-up forms — real behavior, set up visually." },
  { id: "send",      gapAfter: 26, text: "When it's ready, name the message, pick a channel — DWEEB finds or creates the webhook for you. One click. Posted." },
  { id: "templates", gapAfter: 18, text: "And you never start from zero — flip through ready-made templates, preview the message live, and open one to make it yours." },
  { id: "activity",  gapAfter: 20, text: "DWEEB also runs inside Discord. Open the Activity in a voice channel and build together — live presence, real-time co-editing, one-click publish." },
  { id: "cta",       gapAfter: 0,  text: "DWEEB. Way more features are waiting — explore them now, for free, right in your browser. Just search dweeb bot on Google, and start building." },
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
      rate: "+6%",
      pitch: "+0Hz",
    });
    fs.renameSync(audioFilePath, file);
    const bytes = fs.statSync(file).size;
    const durationSec = bytes / 6000; // 48 kbps CBR mono mp3
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
  tts.close();
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
  const totalFrames = cursor + 66; // hold on the end card
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
