import manifest from "../public/audio/manifest.json";

export const FPS = manifest.fps;
export const TOTAL = manifest.totalFrames;

type VoEntry = {
  id: string;
  file: string;
  text: string;
  frames: number;
  startFrame: number;
  gapAfter: number;
};

export const VO: Record<string, VoEntry> = Object.fromEntries(
  manifest.timeline.map((l) => [l.id, l as VoEntry]),
);

export const MUSIC = "audio/music.wav";
export const WHOOSH = "audio/whoosh.wav";
export const POP = "audio/pop.wav";
export const CLICK = "audio/click.wav";
export const TICK = "audio/tick.wav";
export const CHIME = "audio/chime.wav";
export const PING = "audio/ping.wav";
export const RISER = "audio/riser.wav";
export const IMPACT = "audio/impact.wav";

// One scene per VO line. Each scene leads its line by a few frames, then runs
// until the next line leads in. Derived from the manifest so re-recording the
// VO re-syncs every cut.
export const LEAD = 8;
export const SCENE_IDS = [
  "hook",
  "reveal",
  "build",
  "assistant",
  "plugins",
  "send",
  "templates",
  "activity",
  "cta",
] as const;
export type SceneId = (typeof SCENE_IDS)[number];

const starts = SCENE_IDS.map((id) => VO[id].startFrame);

/** Frames the incoming scene overlaps the outgoing one (entrance transition). */
export const TRANSITION_FRAMES = 20;

function scene(i: number) {
  const from = i === 0 ? 0 : starts[i] - LEAD;
  const to = i === SCENE_IDS.length - 1 ? TOTAL : starts[i + 1] - LEAD;
  return { from, durationInFrames: to - from };
}

export const SCENES: Record<SceneId, { from: number; durationInFrames: number }> =
  Object.fromEntries(SCENE_IDS.map((id, i) => [id, scene(i)])) as Record<
    SceneId,
    { from: number; durationInFrames: number }
  >;

/** Absolute frame the scene's <Sequence> actually starts (transition included). */
export const seqFrom = (id: SceneId): number =>
  SCENES[id].from === 0 ? 0 : SCENES[id].from - TRANSITION_FRAMES;

/**
 * Scene-LOCAL frame at which this scene's VO line begins. Local frame 0 is the
 * Sequence start — i.e. TRANSITION_FRAMES before the nominal cut — so beats
 * derived from this stay locked to the voice.
 */
export const voDelay = (id: SceneId): number => VO[id].startFrame - seqFrom(id);
