// The film clock. Everything here derives from public/audio/manifest.json
// (written by `npm run audio`): each VO line's exact length and placement, and
// every word's start/end. Re-recording a line re-times every cut and every
// word-anchored beat, and the score is re-edited from the same manifest.
//
// scripts/lib/film-timing.mjs reads LEAD, TRANSITION_FRAMES and SCENE_IDS from
// THIS file (by pattern) so the music edit uses the picture's own numbers —
// keep them plain literals.

import manifestJson from "../public/audio/manifest.json";

// Re-exported so scenes keep importing sounds from the timeline; defined in
// ./audio with the rest of the kit.
export { MUSIC, WHOOSH, POP, CLICK, TICK, CHIME, PING, RISER, IMPACT } from "./audio";

export type VoWord = {
  /** The word as the TTS reported it ("DWEEB", "high-fidelity"). */
  text: string;
  /** Lower-case letters and digits only — the matching key for at(). */
  norm: string;
  /** Seconds from the start of the line's mp3, as heard (codec delay included). */
  start: number;
  end: number;
};

export type VoEntry = {
  id: SceneId;
  file: string;
  text: string;
  /** mp3 length in frames (+ a 2-frame pad), i.e. where the next line's gap starts. */
  frames: number;
  /** Absolute film frame the mp3 starts. */
  startFrame: number;
  gapAfter: number;
  words: VoWord[];
  /** First word's start → last word's end, seconds from the mp3 start. */
  speech: { start: number; end: number };
  loudness?: { integratedLufs: number; gainDb: number };
};

type ManifestV2 = {
  version: number;
  fps: number;
  totalFrames: number;
  timeline: VoEntry[];
  music?: { marks?: { mainAFrame: number; spliceFrame: number; dropFrame: number; endingFrame: number | null } };
};
const manifest = manifestJson as unknown as ManifestV2;

// One scene per VO line. Each scene leads its line by LEAD frames, then runs
// until the next scene's cut.
export const LEAD = 8;
/** Frames the incoming scene overlaps the outgoing one (entrance transition). */
export const TRANSITION_FRAMES = 16;
export const SCENE_IDS = [
  "hook",
  "reveal",
  "templates",
  "build",
  "assistant",
  "plugins",
  "send",
  "activity",
  "cta",
] as const;
export type SceneId = (typeof SCENE_IDS)[number];

// ─── Load-time validation ────────────────────────────────────────────────────
// A malformed or stale manifest must fail here, loudly, with the fix — not as
// a scene quietly drifting off its words.
{
  const fix = "Run `npm run audio` (it reuses the committed takes; no network needed).";
  if (manifest.version !== 2) {
    throw new Error(`public/audio/manifest.json is v${manifest.version ?? 1}; the film needs v2 (word timings). ${fix}`);
  }
  const ids = manifest.timeline.map((l) => l.id);
  if (ids.join(",") !== SCENE_IDS.join(",")) {
    throw new Error(`manifest lines [${ids.join(", ")}] must be exactly SCENE_IDS [${SCENE_IDS.join(", ")}], in order. ${fix}`);
  }
  manifest.timeline.forEach((l, i) => {
    if (!l.words?.length || !l.speech) throw new Error(`manifest line "${l.id}" has no word timings. ${fix}`);
    const prev = manifest.timeline[i - 1];
    if (prev && l.startFrame <= prev.startFrame) {
      throw new Error(`manifest line "${l.id}" starts at frame ${l.startFrame}, not after "${prev.id}" (${prev.startFrame}).`);
    }
  });
  if (manifest.totalFrames <= manifest.timeline[manifest.timeline.length - 1].startFrame) {
    throw new Error("manifest totalFrames ends before the last line starts.");
  }
}

export const FPS = manifest.fps;
export const TOTAL = manifest.totalFrames;

export const VO: Record<string, VoEntry> = Object.fromEntries(manifest.timeline.map((l) => [l.id, l]));
const line = (id: SceneId): VoEntry => VO[id];

const starts = SCENE_IDS.map((id) => line(id).startFrame);

function scene(i: number) {
  const from = i === 0 ? 0 : starts[i] - LEAD;
  const to = i === SCENE_IDS.length - 1 ? TOTAL : starts[i + 1] - LEAD;
  return { from, durationInFrames: to - from };
}

export const SCENES: Record<SceneId, { from: number; durationInFrames: number }> = Object.fromEntries(
  SCENE_IDS.map((id, i) => [id, scene(i)]),
) as Record<SceneId, { from: number; durationInFrames: number }>;

for (const id of SCENE_IDS) {
  if (SCENES[id].durationInFrames <= TRANSITION_FRAMES) {
    throw new Error(
      `Scene "${id}" is ${SCENES[id].durationInFrames} frames — it must outlast its ${TRANSITION_FRAMES}-frame ` +
        `entrance transition. Lengthen the line or its gapAfter in scripts/generate-audio.mjs.`,
    );
  }
}

/** Absolute frame the scene's <Sequence> actually starts (transition included). */
export const seqFrom = (id: SceneId): number => (SCENES[id].from === 0 ? 0 : SCENES[id].from - TRANSITION_FRAMES);

/**
 * Scene-LOCAL frame at which this scene's VO line begins. Local frame 0 is the
 * Sequence start — i.e. TRANSITION_FRAMES before the nominal cut — so beats
 * derived from this stay locked to the voice.
 */
export const voDelay = (id: SceneId): number => line(id).startFrame - seqFrom(id);

/**
 * The film's one climax frame: the hard cut into the end card. The riser ends
 * here, the music's drop (main B's downbeat) lands here, and the CTA scene
 * fires its impact, flash and camera recoil here (scene-local frame
 * TRANSITION_FRAMES).
 */
export const CTA_HIT_ABS = SCENES.cta.from;

// ─── Word anchors ────────────────────────────────────────────────────────────

export type AtOptions = {
  /** Which occurrence, 1-based, when the phrase is spoken more than once (required then). */
  nth?: number;
  /** "start" (default): the first word's start. "end": the last word's end. */
  edge?: "start" | "end";
  /** Frames added to the result — visual beats usually lead a word by 2–6 frames (offset: -4). */
  offset?: number;
};

/** Same rule as scripts/lib/vo-words.mjs normWord(): lower-case letters and digits only. */
const norm = (s: string) =>
  s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** Seconds (from the line's mp3 start) at which `phrase` starts or ends. */
function phraseTime(id: SceneId, phrase: string, opts: AtOptions): number {
  const words = line(id).words;
  const target = norm(phrase);
  const spoken = words.map((w) => w.text).join(" ");
  if (!target) throw new Error(`at("${id}", "${phrase}"): the phrase has no letters or digits.`);
  // A match is a run of whole words whose keys concatenate to the phrase's key,
  // so "ready-made" matches whether the TTS reported one word or two.
  const matches: { first: VoWord; last: VoWord }[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!words[i].norm) continue;
    let acc = "";
    for (let j = i; j < words.length; j++) {
      acc += words[j].norm;
      if (acc === target) {
        matches.push({ first: words[i], last: words[j] });
        break;
      }
      if (!target.startsWith(acc)) break;
    }
  }
  if (!matches.length) {
    throw new Error(`at("${id}", "${phrase}"): not spoken in this line. The line's words: ${spoken}`);
  }
  if (opts.nth === undefined && matches.length > 1) {
    const when = matches.map((m, k) => `#${k + 1} @${m.first.start.toFixed(2)}s`).join(", ");
    throw new Error(`at("${id}", "${phrase}"): spoken ${matches.length} times (${when}) — pass { nth: 1…${matches.length} }.`);
  }
  const nth = opts.nth ?? 1;
  if (!Number.isInteger(nth) || nth < 1 || nth > matches.length) {
    throw new Error(`at("${id}", "${phrase}", { nth: ${opts.nth} }): nth is 1-based; this phrase occurs ${matches.length} time(s).`);
  }
  const m = matches[nth - 1];
  return opts.edge === "end" ? m.last.end : m.first.start;
}

/**
 * Scene-local frame (the same frame space as voDelay) where `phrase` is heard
 * in scene `id`'s line: `at("send", "Pick")`, `at("build", "checked", { offset: -3 })`,
 * `at("plugins", "giveaway", { edge: "end" })`. Case and punctuation are
 * ignored; several words match as a run ("every limit"). THROWS — at module
 * load of the scene that calls it — when the phrase isn't spoken or is
 * ambiguous, so a VO rewrite that removes an anchor fails loudly instead of
 * silently drifting.
 */
export const at = (id: SceneId, phrase: string, opts: AtOptions = {}): number =>
  voDelay(id) + Math.round(phraseTime(id, phrase, opts) * FPS) + (opts.offset ?? 0);

/** Like at(), but an absolute film frame (for the top-level caption track, the mix, …). */
export const atAbs = (id: SceneId, phrase: string, opts: AtOptions = {}): number =>
  line(id).startFrame + Math.round(phraseTime(id, phrase, opts) * FPS) + (opts.offset ?? 0);

/** Scene-local frame of the line's first word. */
export const speechStart = (id: SceneId): number => voDelay(id) + Math.round(line(id).speech.start * FPS);
/** Scene-local frame where the line's last word ends. */
export const speechEnd = (id: SceneId): number => voDelay(id) + Math.round(line(id).speech.end * FPS);
/** Absolute film frame of the line's first word. */
export const speechStartAbs = (id: SceneId): number => line(id).startFrame + Math.round(line(id).speech.start * FPS);
/** Absolute film frame where the line's last word ends. */
export const speechEndAbs = (id: SceneId): number => line(id).startFrame + Math.round(line(id).speech.end * FPS);

/** The line's words with their timings (seconds from its mp3 start) — for captions/VTT. */
export const lineWords = (id: SceneId): readonly VoWord[] => line(id).words;

// ─── Music ───────────────────────────────────────────────────────────────────

/**
 * Where the score's edit lands, in absolute film frames (from the last
 * `npm run audio` / `npm run music`): main A's first downbeat, the splice into
 * the breakdown, the drop (= CTA_HIT_ABS), and the outro crash after the CTA
 * line (a natural sync point for the end card's last beat). Null before the
 * score has been built.
 */
export const MUSIC_MARKS = manifest.music?.marks
  ? {
      mainA: Math.round(manifest.music.marks.mainAFrame),
      splice: Math.round(manifest.music.marks.spliceFrame),
      drop: Math.round(manifest.music.marks.dropFrame),
      ending: manifest.music.marks.endingFrame === null ? null : Math.round(manifest.music.marks.endingFrame),
    }
  : null;

if (MUSIC_MARKS && MUSIC_MARKS.drop !== CTA_HIT_ABS) {
  // Not fatal (the film still plays), but the drop no longer hits the cut.
  console.warn(`music.wav was edited for a drop at frame ${MUSIC_MARKS.drop}, but CTA_HIT_ABS is ${CTA_HIT_ABS} — run \`npm run music\`.`);
}
