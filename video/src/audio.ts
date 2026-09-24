// Every sound the film plays, and how loud. Owned by the audio pipeline
// (scripts/generate-audio.mjs, audio-synth.mjs, lib/music-edit.mjs): file
// lengths come from public/audio/sfx.json (written with the kit) and the levels
// below were MEASURED through Remotion's own mix chain (per-asset volume, -3 dB
// mono upmix, 48 kHz sum), not set by ear.
//
// This module must not import ./timeline at runtime — timeline.ts re-exports the
// path constants from here, and a cycle would hand one of them `undefined`.

import manifest from "../public/audio/manifest.json";
import sfx from "../public/audio/sfx.json";
import type { SceneId } from "./timeline";

// ─── Files ───────────────────────────────────────────────────────────────────

export const MUSIC = "audio/music.wav";

/** Every file in the SFX kit (without variants' aliases). */
const SFX_NAMES = [
  "click-1",
  "click-2",
  "click-3",
  "pop-1",
  "pop-2",
  "pop-3",
  "tick-1",
  "tick-2",
  "tick-3",
  "chime",
  "shimmer",
  "ping",
  "whoosh",
  "whoosh-soft",
  "riser",
  "impact",
  // Aliases of variant 1, for code that plays "the click".
  "click",
  "pop",
  "tick",
] as const;
export type SfxName = (typeof SFX_NAMES)[number];

type SfxEntry = { file: string; frames: number; sec: number; peakDbfs: number; aliasOf?: string };
const table = (sfx as unknown as { sounds: Record<string, SfxEntry> }).sounds;
for (const name of SFX_NAMES) {
  if (!table[name]) {
    throw new Error(`public/audio/sfx.json has no "${name}" — rebuild the kit with \`npm run sfx\`.`);
  }
}

/** Staticfile path of a sound: `staticFile(sfxPath("chime"))`. */
export const sfxPath = (name: SfxName): string => table[name].file;

/** Every sound's staticFile path by name: `SFX["whoosh-soft"]`, `SFX["click-2"]`. */
export const SFX = Object.fromEntries(SFX_NAMES.map((n) => [n, table[n].file])) as Record<SfxName, string>;

/** Length of each sound in frames — use it as the <Sequence durationInFrames> so nothing is cut. */
export const SFX_FRAMES = Object.fromEntries(SFX_NAMES.map((n) => [n, table[n].frames])) as Record<
  SfxName,
  number
>;

// The historical single-file constants (timeline.ts re-exports these).
export const CLICK = sfxPath("click");
export const POP = sfxPath("pop");
export const TICK = sfxPath("tick");
export const CHIME = sfxPath("chime");
export const PING = sfxPath("ping");
export const WHOOSH = sfxPath("whoosh");
export const WHOOSH_SOFT = sfxPath("whoosh-soft");
export const SHIMMER = sfxPath("shimmer");
export const RISER = sfxPath("riser");
export const IMPACT = sfxPath("impact");

/** Frames the riser runs; it peaks on its LAST sample — start it RISER_FRAMES before the hit. */
export const RISER_FRAMES = SFX_FRAMES.riser;
/** Frames the CTA impact runs (its airy tail included). */
export const IMPACT_FRAMES = SFX_FRAMES.impact;

/**
 * Seeded variants of the repeated UI sounds. Pick by the event's index in its
 * scene (0, 1, 2, …) so consecutive clicks never repeat the same sample:
 * `sfxVariant("click", i)`. Deterministic, so every render sounds the same.
 */
export const sfxVariant = (kind: "click" | "pop" | "tick", index: number): string =>
  sfxPath(`${kind}-${(((Math.round(index) % 3) + 3) % 3) + 1}` as SfxName);

// ─── Levels ──────────────────────────────────────────────────────────────────

/**
 * Music bus gain. music.wav carries its edit, the duck under every line and
 * the fades, written 3 dB under the source for headroom; 0.59 puts the bed
 * 10.8–11.6 LU under the narration in the main sections (build → CTA),
 * 13.6–14.7 LU in the intro scenes and the breakdown, and at -25 LUFS on the
 * end card (measured, per-line gains applied).
 */
export const MUSIC_BASE = 0.59;

/**
 * Narration gain. Remotion upmixes the mono mp3 at -3 dB per side, so 1.55 is
 * really +0.8 dB. Apply it per line through voiceVolume(), which adds that
 * take's loudness normalization.
 */
export const VOICE_GAIN = 1.55;

type LineLoudness = { id: string; loudness?: { gainDb: number } };
const lineGainDb: Record<string, number> = Object.fromEntries(
  (manifest as unknown as { lines: LineLoudness[] }).lines.map((l) => [l.id, l.loudness?.gainDb ?? 0]),
);

/**
 * Volume for one VO line: VOICE_GAIN × the take's normalization gain. TTS lines
 * differ by ~2 LU; the manifest records each take's gain to a common -21 LUFS
 * so the narrator holds one level and the bed sits evenly under him.
 */
export const voiceVolume = (id: SceneId): number => VOICE_GAIN * Math.pow(10, (lineGainDb[id] ?? 0) / 20);

/**
 * Recommended <Audio volume> per sound. Each sits where the mix hierarchy
 * wants it, as max momentary loudness relative to the in-mix narration
 * (-17.8 LUFS inside speech):
 *   impact -2.6 LU, ping -3.0 LU            — the two hero moments (hit, delivery)
 *   chime -8.9 LU, shimmer -10.0 LU         — confirmations; keep them in VO pauses
 *   whoosh -10.1 LU, whooshSoft -11.0 LU    — transitions, in the gaps
 *   click -12.9 LU, pop -14.0 LU            — every cursor press / element appearing
 *   tick -19.0 LU per key                   — typing texture (a burst sums ~6 dB higher)
 *   riser -20.0 LU                          — a thin top layer over the score's own riser
 * Scale a single event by ±3 dB (×0.7…×1.4) for emphasis rather than inventing
 * a new level; beyond that the hierarchy breaks.
 */
export const VOL = {
  impact: 0.4,
  ping: 0.59,
  chime: 0.32,
  shimmer: 0.46,
  whoosh: 0.3,
  whooshSoft: 0.43,
  click: 0.66,
  pop: 0.39,
  tick: 0.97,
  riser: 0.45,
} as const;
