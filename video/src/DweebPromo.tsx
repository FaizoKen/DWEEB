import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from "remotion";
import { SCENES, SCENE_IDS, VO, MUSIC, WHOOSH, RISER, TOTAL, SceneId } from "./timeline";
import { SceneTransition, TRANSITION_FRAMES, TransitionType } from "./components/SceneTransition";
import { SceneHook } from "./scenes/S01Hook";
import { SceneReveal } from "./scenes/S02Reveal";
import { SceneBuild } from "./scenes/S03Build";
import { SceneAssistant } from "./scenes/S04Assistant";
import { ScenePlugins } from "./scenes/S05Plugins";
import { SceneSend } from "./scenes/S06Send";
import { SceneTemplates } from "./scenes/S07Templates";
import { SceneActivity } from "./scenes/S08Activity";
import { SceneCta } from "./scenes/S09Cta";

// Music bus. music.wav is the licensed bed baked to length by the audio
// scripts — trimmed, faded, and with the duck under the narration already in
// the waveform (a per-frame volume function would expand into a huge ffmpeg
// expression and blow the Windows command-line limit at stitch time). So the
// prop stays a constant. VO and music are lifted together to leave the finished
// web master close to -16 LUFS without flattening the deliberately gentle bed.
const MUSIC_BASE = 0.35;
const VOICE_GAIN = 1.55;

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

const COMPONENTS: Record<SceneId, React.FC> = {
  hook: SceneHook,
  reveal: SceneReveal,
  build: SceneBuild,
  assistant: SceneAssistant,
  plugins: ScenePlugins,
  send: SceneSend,
  templates: SceneTemplates,
  activity: SceneActivity,
  cta: SceneCta,
};

// Cut style per scene entrance — dissolves for tone shifts, one push into the
// editor act, then HOLD cuts all the way to delivery: build → assistant →
// plugins → send match camera framing on both sides of every boundary, so the
// whole middle of the film reads as one continuous take on one message. (A
// push between two shots of the same window at different zooms smeared two
// copies of the UI across the screen — that is why send is not a push.)
const TRANSITIONS: Record<SceneId, TransitionType> = {
  hook: "dissolve",
  reveal: "dissolve",
  build: "push",
  assistant: "hold",
  plugins: "hold",
  send: "hold",
  templates: "push",
  activity: "dissolve",
  cta: "dissolve",
};

// Sound only the structural turns. A whoosh on every edit made the old cut feel
// like a slide deck and weakened the transitions that actually change context.
const AUDIBLE_TRANSITIONS = new Set<SceneId>(["reveal", "templates", "activity", "cta"]);

export const DweebPromo: React.FC = () => {
  const T = TRANSITION_FRAMES;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Audio src={staticFile(MUSIC)} volume={MUSIC_BASE} />

      {/* Voice-over per line (absolute timeline — never shifted by transitions).
          Each line's window runs until the NEXT line begins, not just its
          estimated length: `frames` is derived from CBR byte math and can
          undershoot the real mp3 by a few frames, which used to clip word
          tails. The mp3 ends inside the window, so the slack is silence. */}
      {SCENE_IDS.map((id, i) => {
        const v = VO[id];
        const end = i === SCENE_IDS.length - 1 ? TOTAL : VO[SCENE_IDS[i + 1]].startFrame;
        return (
          <Sequence key={v.id} from={v.startFrame} durationInFrames={end - v.startFrame}>
            <Audio src={staticFile(v.file)} volume={VOICE_GAIN} />
          </Sequence>
        );
      })}

      {/* Riser into the end card — ends exactly on the CTA impact (the scene
          plays the impact itself at its 2nd frame; riser.wav peaks on its last
          sample and runs 36 frames). */}
      <Sequence from={SCENES.cta.from - 54} durationInFrames={38}>
        <Audio src={staticFile(RISER)} volume={0.55} />
      </Sequence>

      {/* Transition whooshes at each cut (skip the first scene; a "hold" is a
          matched cut meant to be inaudible — the scene plays its own panel
          whoosh instead). */}
      {SCENE_IDS.slice(1).map((id) => {
        const type = TRANSITIONS[id];
        if (type === "hold" || !AUDIBLE_TRANSITIONS.has(id)) return null;
        const vol = type === "whip" ? 0.55 : type === "push" ? 0.42 : 0.28;
        return (
          <Sequence key={`w-${id}`} from={SCENES[id].from - T} durationInFrames={22}>
            <Audio src={staticFile(WHOOSH)} volume={vol} />
          </Sequence>
        );
      })}

      {/* Scenes overlap by T frames so the incoming transition plays over the
          outgoing shot. */}
      {SCENE_IDS.map((id, i) => {
        const Comp = COMPONENTS[id];
        const start = SCENES[id].from;
        const end = i === SCENE_IDS.length - 1 ? TOTAL : SCENES[SCENE_IDS[i + 1]].from;
        const from = i === 0 ? 0 : start - T;
        return (
          <Sequence key={id} from={from} durationInFrames={end - from}>
            <SceneTransition type={TRANSITIONS[id]}>
              <Comp />
            </SceneTransition>
          </Sequence>
        );
      })}

      <Fades total={TOTAL} />
    </AbsoluteFill>
  );
};
