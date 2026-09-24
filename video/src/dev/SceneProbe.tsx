import React from "react";
import { AbsoluteFill, CalculateMetadataFunction } from "remotion";
import { SCENE_COMPONENTS, TRANSITIONS } from "../DweebPromo";
import { CAPTIONS, captionAudit } from "../captions";
import { SceneClock } from "../components/Camera";
import type { CaptionCue } from "../components/Caption";
import type { CaptionReportJoin, CaptionReportRow } from "../components/CaptionTrack";
import type { TransitionType } from "../components/SceneTransition";
import { FPS, SCENES, SCENE_IDS, SceneId, TOTAL, TRANSITION_FRAMES, VO, seqFrom } from "../timeline";

/**
 * Dev-only: ONE scene alone — no transition, no captions — at a scene-local
 * frame (the same frame space as voDelay). Comparing the two sides of a cut
 * through the probe is the only honest boundary check: composite frames blend
 * the two scenes (that is how the hook→reveal ghosting slipped past review).
 * The scene runs on its film clock, so the probe's frame N is exactly what the
 * film shows at seqFrom(scene) + N, minus the transition and the captions.
 *
 * The composition also carries the film timeline and the caption audit as
 * props (via calculateMetadata), so the QA scripts read them from the bundle
 * instead of re-deriving timeline.ts in Node.
 */
export type ProbeScene = {
  id: SceneId;
  /** Cut frame: first frame the scene is fully on screen. */
  from: number;
  /** Film frame its <Sequence> starts (T before the cut). */
  seqFrom: number;
  /** First film frame after its last visible frame (the next cut). */
  end: number;
  /** Film frame its voice-over line starts (voDelay = voStart − seqFrom). */
  voStart: number;
  transition: TransitionType | null;
};

export type ProbeTimeline = {
  fps: number;
  total: number;
  T: number;
  scenes: ProbeScene[];
  captions: ReadonlyArray<CaptionCue>;
  captionReport: { rows: CaptionReportRow[]; issues: string[]; joins: CaptionReportJoin[] };
};

export type SceneProbeProps = { scene: SceneId; timeline?: ProbeTimeline };

export const probeTimeline = (): ProbeTimeline => ({
  fps: FPS,
  total: TOTAL,
  T: TRANSITION_FRAMES,
  scenes: SCENE_IDS.map((id, i) => ({
    id,
    from: SCENES[id].from,
    seqFrom: seqFrom(id),
    end: i === SCENE_IDS.length - 1 ? TOTAL : SCENES[SCENE_IDS[i + 1]].from,
    voStart: VO[id].startFrame,
    transition: TRANSITIONS[id],
  })),
  captions: CAPTIONS,
  captionReport: captionAudit(),
});

/**
 * Duration = the scene's whole <Sequence> plus T frames, so a scene can also be
 * rendered just past its own cut (to compare both sides at the same instant).
 */
export const calculateProbeMetadata: CalculateMetadataFunction<SceneProbeProps> = ({ props }) => {
  const timeline = probeTimeline();
  const scene = timeline.scenes.find((s) => s.id === props.scene);
  if (!scene) throw new Error(`SceneProbe: unknown scene "${props.scene}" (${SCENE_IDS.join(", ")})`);
  return {
    durationInFrames: scene.end - scene.seqFrom + TRANSITION_FRAMES,
    props: { ...props, timeline },
  };
};

export const SceneProbe: React.FC<SceneProbeProps> = ({ scene }) => {
  const Scene = SCENE_COMPONENTS[scene];
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <SceneClock from={seqFrom(scene)}>
        <Scene />
      </SceneClock>
    </AbsoluteFill>
  );
};
