import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from "remotion";
import { SCENES, SCENE_IDS, SceneId, TOTAL, VO, seqFrom } from "./timeline";
import { MUSIC, MUSIC_BASE, voiceVolume } from "./audio";
import { CAPTIONS } from "./captions";
import { FILM_SFX, SfxTrack } from "./sfxTrack";
import { SceneClock } from "./components/Camera";
import { CaptionTrack } from "./components/CaptionTrack";
import { SceneTransition, TransitionType } from "./components/SceneTransition";
import { SceneHook } from "./scenes/S01Hook";
import { SceneReveal } from "./scenes/S02Reveal";
import { SceneTemplates } from "./scenes/S03Templates";
import { SceneBuild } from "./scenes/S04Build";
import { SceneAssistant } from "./scenes/S05Assistant";
import { ScenePlugins } from "./scenes/S06Plugins";
import { SceneSend } from "./scenes/S07Send";
import { SceneActivity } from "./scenes/S08Activity";
import { SceneCta } from "./scenes/S09Cta";

const Fades: React.FC<{ total: number }> = ({ total }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 12, total - 20, total], [1, 0, 0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ background: "#000", opacity: o, pointerEvents: "none", zIndex: 50 }} />
  );
};

/** One component per scene, in play order (SceneProbe renders these alone). */
export const SCENE_COMPONENTS: Record<SceneId, React.FC> = {
  hook: SceneHook,
  reveal: SceneReveal,
  templates: SceneTemplates,
  build: SceneBuild,
  assistant: SceneAssistant,
  plugins: ScenePlugins,
  send: SceneSend,
  activity: SceneActivity,
  cta: SceneCta,
};

/**
 * How each scene enters (see SceneTransition). The film is one take on one
 * message: a MATCH cut from the hook's finished card into the editor that
 * assembles around it, then HOLD cuts — invisible, identical state on both
 * sides — from the assembled editor through the templates overlay, the build,
 * the assistant, the plugin and the send, a DIP through the stage colour into
 * the collaboration coda (a new place and a new message, where a crossfade
 * would double-expose two cards), and a hard CUT on the CTA hit.
 */
export const TRANSITIONS: Record<SceneId, TransitionType | null> = {
  hook: null,
  reveal: "match",
  templates: "hold",
  build: "hold",
  assistant: "hold",
  plugins: "hold",
  send: "hold",
  activity: "dip",
  cta: "cut",
};

export const DweebPromo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Audio src={staticFile(MUSIC)} volume={MUSIC_BASE} />

      {/* Voice-over per line (absolute timeline — never shifted by transitions),
          each at its take's normalized level (voiceVolume). Each line's window
          runs until the NEXT line begins, not just its estimated length, so a
          word tail can never be clipped; the mp3 ends inside the window and
          the slack is silence. */}
      {SCENE_IDS.map((id, i) => {
        const v = VO[id];
        const end = i === SCENE_IDS.length - 1 ? TOTAL : VO[SCENE_IDS[i + 1]].startFrame;
        return (
          <Sequence key={v.id} from={v.startFrame} durationInFrames={end - v.startFrame} name={`vo:${id}`}>
            <Audio src={staticFile(v.file)} volume={voiceVolume(id)} />
          </Sequence>
        );
      })}

      {/* Sounds no scene can own — the transition whooshes, the riser into
          the CTA hit, and the chimes that ring across a hold cut — in
          absolute frames, outside every scene, so each plays its full length
          (see sfxTrack.tsx). */}
      <SfxTrack cues={FILM_SFX} />

      {/* Each scene's Sequence starts T frames before its cut so its entrance
          plays over the outgoing shot, and ends on the next scene's cut.
          SceneClock hands the scene its place on the film timeline so its
          ambient motion (background, drift) runs on film time. */}
      {SCENE_IDS.map((id, i) => {
        const Scene = SCENE_COMPONENTS[id];
        const from = seqFrom(id);
        const end = i === SCENE_IDS.length - 1 ? TOTAL : SCENES[SCENE_IDS[i + 1]].from;
        return (
          <Sequence key={id} from={from} durationInFrames={end - from} name={id}>
            <SceneClock from={from}>
              <SceneTransition type={TRANSITIONS[id]}>
                <Scene />
              </SceneTransition>
            </SceneClock>
          </Sequence>
        );
      })}

      {/* One caption track above every scene and outside every transition, so
          a super can hold across a cut without fading or ghosting with it. */}
      <CaptionTrack cues={CAPTIONS} />

      <Fades total={TOTAL} />
    </AbsoluteFill>
  );
};
