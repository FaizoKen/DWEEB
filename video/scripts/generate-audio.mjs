// Generates the film's entire audio bed — neural voice-over (Microsoft Edge TTS,
// one mp3 per line), an original beat-synced music score, and a kit of UI sound
// effects — all written to public/audio with a manifest carrying exact durations
// (in frames) so the visual timeline stays perfectly in sync with the voice.
//
// No ffmpeg/python required: TTS comes from msedge-tts as CBR 48kbps mp3 (so
// duration = bytes / 6000), and the music/SFX are synthesized as raw PCM WAV
// (see audio-synth.mjs). To regenerate ONLY the SFX (offline), use `npm run sfx`.

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMusic, buildAllSfx } from "./audio-synth.mjs";

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

  buildMusic(OUT, totalFrames / FPS, cutSecs, ctaSec);
  buildAllSfx(OUT);

  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nTotal: ${manifest.totalSec}s (${totalFrames} frames)`);
  console.log("manifest.json written.");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
