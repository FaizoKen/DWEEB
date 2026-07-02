// Rebuilds ONLY music.wav from the existing manifest — no TTS, no network, and
// no timing changes (the manifest, and therefore every scene cut, stays put).
// Use after tweaking the score or the baked-in ducking in audio-synth.mjs:
//
//   npm run music

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMusicAuto } from "./audio-synth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "public", "audio");

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
const FPS = manifest.fps;
const timeline = manifest.timeline;

const at = (id) => timeline.find((l) => l.id === id).startFrame / FPS;
const cutSecs = timeline.map((l) => l.startFrame / FPS);
const voWindows = timeline.map((l) => ({
  start: l.startFrame / FPS,
  end: (l.startFrame + l.frames) / FPS,
}));

const marks = {
  grooveSec: at("build"),
  liftSec: at("templates"),
  breakdownSec: at("activity"),
  riseSec: at("cta") - 5,
  ctaSec: at("cta"),
};

buildMusicAuto(OUT, manifest.totalFrames / FPS, cutSecs, marks, voWindows);
console.log("music.wav rebuilt (ducking baked in).");
