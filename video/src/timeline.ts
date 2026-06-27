import manifest from "../public/audio/manifest.json";

export const FPS = manifest.fps;
export const TOTAL = manifest.totalFrames;

type VoEntry = {
  id: string;
  file: string;
  text: string;
  frames: number;
  startFrame: number;
};

export const VO: Record<string, VoEntry> = Object.fromEntries(
  manifest.timeline.map((l) => [l.id, l as VoEntry]),
);

export const MUSIC = "audio/paulyudin-tech-corporate-182507.mp3";
export const WHOOSH = "audio/whoosh.wav";
export const POP = "audio/pop.wav";
export const CLICK = "audio/click.wav";
export const TICK = "audio/tick.wav";
export const CHIME = "audio/chime.wav";

// Each scene leads its VO line by a few frames, then runs until the next line
// leads in. Derived from the manifest so re-recording the VO re-syncs the cuts.
const LEAD = 8;
const ids = ["vo1", "vo2", "vo3", "vo4", "vo5", "vo6"] as const;
const starts = ids.map((id) => VO[id].startFrame);

function scene(i: number) {
  const from = i === 0 ? 0 : starts[i] - LEAD;
  const to = i === ids.length - 1 ? TOTAL : starts[i + 1] - LEAD;
  return { from, durationInFrames: to - from };
}

export const SCENES = {
  open: scene(0),
  build: scene(1),
  plugins: scene(2),
  custombot: scene(3),
  interact: scene(4),
  morecta: scene(5),
} as const;
