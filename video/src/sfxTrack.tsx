import React from "react";
import { Audio, Sequence, staticFile } from "remotion";
import { CHIME, RISER, RISER_FRAMES, SFX_FRAMES, VOL, WHOOSH_SOFT } from "./audio";
import { CTA_HIT_ABS, SCENES, TOTAL, TRANSITION_FRAMES, seqFrom, type SceneId } from "./timeline";
import { CHIME_AT as BUILD_CHIME_AT } from "./scenes/build/beats";
import { PLUG } from "./scenes/S06Plugins";

/**
 * The film-level sound track: every sound a scene cannot own. A scene's audio
 * lives only inside its layer — nothing is mounted before the scene's first
 * visible frame (SceneTransition), and its Sequence ends on the next cut — so
 * a sound that rings across a cut, or belongs to a transition, would be cut
 * short there. These cues are ABSOLUTE film frames, rendered once in
 * DweebPromo outside every scene and transition (like the caption track), so
 * each plays its full length. Beats a scene owns are still keyed in that scene
 * and imported here, so a VO re-time moves the sound with its picture.
 */
export type FilmSfxCue = {
  /** Stable id (Sequence name in the Studio). */
  id: string;
  /** Absolute film frame the sound starts. */
  at: number;
  /** staticFile path. */
  src: string;
  volume: number;
  /** Full length in frames (SFX_FRAMES) — never trimmed. */
  frames: number;
};

/** A soft air whoosh under the match crossfade and under the dip, starting with the overlap. */
const whoosh = (id: SceneId): FilmSfxCue => ({
  id: `whoosh:${id}`,
  at: SCENES[id].from - TRANSITION_FRAMES,
  src: WHOOSH_SOFT,
  volume: VOL.whooshSoft,
  frames: SFX_FRAMES["whoosh-soft"],
});

export const FILM_SFX: ReadonlyArray<FilmSfxCue> = [
  // Only the two transitions that change the look get one; hold cuts are
  // meant to be inaudible, and the CTA cut is carried by the riser + impact.
  whoosh("reveal"),
  // "…every limit is checked for you": the chime rings in the pause after
  // "for you" and runs into the build → assistant cut.
  { id: "chime:build", at: seqFrom("build") + BUILD_CHIME_AT, src: CHIME, volume: VOL.chime, frames: SFX_FRAMES.chime },
  // "…and more": the plugin attaches in the pause and its chime runs into the
  // plugins → send cut.
  { id: "chime:plugins", at: seqFrom("plugins") + PLUG.chime, src: CHIME, volume: VOL.chime, frames: SFX_FRAMES.chime },
  whoosh("activity"),
  // The riser peaks on its last sample, which lands exactly on the hard cut
  // into the end card (CTA_HIT_ABS), where the CTA scene fires the impact.
  { id: "riser", at: CTA_HIT_ABS - RISER_FRAMES, src: RISER, volume: VOL.riser, frames: RISER_FRAMES },
];

for (const c of FILM_SFX) {
  if (c.at < 0 || c.at + c.frames > TOTAL) {
    throw new Error(`sfxTrack: "${c.id}" runs ${c.at}–${c.at + c.frames}, outside the film (0–${TOTAL}).`);
  }
}

/** Rendered once in DweebPromo, outside every scene. */
export const SfxTrack: React.FC<{ cues: ReadonlyArray<FilmSfxCue> }> = ({ cues }) => (
  <>
    {cues.map((c) => (
      <Sequence key={c.id} from={c.at} durationInFrames={c.frames} name={`sfx:${c.id}`}>
        <Audio src={staticFile(c.src)} volume={c.volume} />
      </Sequence>
    ))}
  </>
);
