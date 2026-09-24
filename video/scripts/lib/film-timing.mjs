// The film clock, shared by every audio script — ONE implementation of how the
// voice-over lays out the timeline and where the picture's cuts fall, so
// generate-audio.mjs (which writes the manifest) and rebuild-music.mjs (which
// re-edits the score from it) can never disagree about a frame.
//
// src/timeline.ts turns the same manifest into scene windows for the picture.
// The two constants the audio needs from it (LEAD, TRANSITION_FRAMES) are READ
// from that file rather than copied, so moving a scene's lead re-derives the
// music edit on the next `npm run music` instead of silently drifting from it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VIDEO_ROOT = path.resolve(__dirname, "..", "..");
export const AUDIO_DIR = path.join(VIDEO_ROOT, "public", "audio");
export const MANIFEST_PATH = path.join(AUDIO_DIR, "manifest.json");

export const FPS = 30;
/** Frames of picture before the first line starts. */
export const LEAD_IN = 14;
/** Frames the settled end card holds after the CTA line's mp3 ends. */
export const END_HOLD = 90;
/**
 * Frames added to each line's mp3 length before its gapAfter. NOT a correction:
 * the byte math is exact (no gapless header, so the decoded stream is exactly
 * bytes / 12000 s — verified on every take), and the mp3 already ends in ~0.3 s
 * of its own silence. It is part of the spacing the per-line gapAfter values
 * were tuned with, so it stays; the music duck no longer depends on it (it
 * follows the words).
 */
export const FRAME_PAD = 2;

let sceneConstants = null;
/** `{ LEAD, TRANSITION_FRAMES, SCENE_IDS }` parsed from src/timeline.ts (the picture's source of truth). */
export function readSceneConstants() {
  if (sceneConstants) return sceneConstants;
  const file = path.join(VIDEO_ROOT, "src", "timeline.ts");
  const src = fs.readFileSync(file, "utf8");
  const int = (name) => {
    const m = new RegExp(`export const ${name}\\s*=\\s*(\\d+)\\s*;`).exec(src);
    if (!m) throw new Error(`Could not read \`export const ${name} = <int>;\` from ${file}`);
    return Number(m[1]);
  };
  const ids = /export const SCENE_IDS\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!ids) throw new Error(`Could not read SCENE_IDS from ${file}`);
  sceneConstants = {
    LEAD: int("LEAD"),
    TRANSITION_FRAMES: int("TRANSITION_FRAMES"),
    SCENE_IDS: [...ids[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]),
  };
  return sceneConstants;
}

/** A line's length in frames: its exact mp3 duration, rounded up, plus the pad. */
export const lineFrames = (durationSec) => Math.ceil(durationSec * FPS - 1e-9) + FRAME_PAD;

/**
 * Lay the lines back to back: the first starts after LEAD_IN, each next one
 * `frames + gapAfter` later, and the end card holds END_HOLD after the last.
 * Returns the manifest's timeline fields.
 */
export function layoutTimeline(lines) {
  let cursor = LEAD_IN;
  const timeline = lines.map((line) => {
    const entry = { ...line, startFrame: cursor };
    cursor += line.frames + line.gapAfter;
    return entry;
  });
  const totalFrames = cursor + END_HOLD;
  return { timeline, totalFrames, totalSec: Number((totalFrames / FPS).toFixed(3)) };
}

/**
 * Film-clock anchors the score is edited against, all derived from the
 * manifest: scene cuts, word-accurate speech spans, and the climax frame.
 */
export function filmAnchors(manifest) {
  const { LEAD } = readSceneConstants();
  const byId = Object.fromEntries(manifest.timeline.map((l) => [l.id, l]));
  const need = (id) => {
    const l = byId[id];
    if (!l) throw new Error(`manifest has no line "${id}"`);
    if (!l.speech) throw new Error(`manifest line "${id}" has no speech span — re-run \`npm run audio\``);
    return l;
  };
  const sec = (frames) => frames / manifest.fps;
  /** Absolute frame of a scene's nominal cut (SCENES[id].from in timeline.ts). */
  const sceneFrom = (id) => (manifest.timeline[0].id === id ? 0 : need(id).startFrame - LEAD);
  const ids = manifest.timeline.map((l) => l.id);
  return {
    fps: manifest.fps,
    totalFrames: manifest.totalFrames,
    totalSec: sec(manifest.totalFrames),
    sceneFrom,
    /** CTA_HIT_ABS in timeline.ts: the hard cut into the end card. */
    ctaHitFrame: sceneFrom("cta"),
    /** Where a line's mp3 starts (its first word follows ~0.14 s later). */
    lineStartSec: (id) => sec(need(id).startFrame),
    speechStartSec: (id) => sec(need(id).startFrame) + need(id).speech.start,
    speechEndSec: (id) => sec(need(id).startFrame) + need(id).speech.end,
    /** Every line's speech span in absolute film seconds (drives the duck). */
    speechSpans: () =>
      ids.map((id) => ({
        id,
        start: sec(need(id).startFrame) + need(id).speech.start,
        end: sec(need(id).startFrame) + need(id).speech.end,
      })),
  };
}

export function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`${MANIFEST_PATH} is missing — run \`npm run audio\` first.`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

export function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}
