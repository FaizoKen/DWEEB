import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  interpolate,
} from "remotion";
import { SCENES, VO, MUSIC, WHOOSH, TOTAL } from "./timeline";
import { SceneOpening } from "./scenes/SceneOpening";
import { SceneBuild } from "./scenes/SceneBuild";
import { ScenePlugins } from "./scenes/ScenePlugins";
import { SceneChannel } from "./scenes/SceneChannel";
import { SceneMoreCta } from "./scenes/SceneMoreCta";
import { SceneTransition, TRANSITION_FRAMES, TransitionType } from "./components/SceneTransition";

// Music bus: fade in/out + sidechain-style duck under every voice-over line, so
// the track breathes up in the gaps and pulls back while narration plays.
const MUSIC_BASE = 0.26;
const DUCK = 0.42; // music drops to 42% under the voice
const musicVolume = (f: number): number => {
  let activity = 0;
  for (const v of Object.values(VO)) {
    const s = v.startFrame;
    const e = v.startFrame + v.frames;
    const env = Math.min(
      interpolate(f, [s - 8, s + 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      interpolate(f, [e - 6, e + 14], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
    );
    activity = Math.max(activity, env);
  }
  const fadeIn = interpolate(f, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = interpolate(f, [TOTAL - 42, TOTAL - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return MUSIC_BASE * fadeIn * fadeOut * (1 - activity * (1 - DUCK));
};

const Fades: React.FC<{ total: number }> = ({ total }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 12, total - 18, total], [1, 0, 0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return <AbsoluteFill style={{ background: "#000", opacity: o, pointerEvents: "none", zIndex: 50 }} />;
};

export const DweebPromo: React.FC = () => {
  // Visual scene boundaries (the custom-bot post + interaction share one scene).
  const T = TRANSITION_FRAMES;
  const defs: { key: string; Comp: React.FC; start: number; end: number; type: TransitionType }[] = [
    { key: "open", Comp: SceneOpening, start: SCENES.open.from, end: SCENES.build.from, type: "dissolve" },
    { key: "build", Comp: SceneBuild, start: SCENES.build.from, end: SCENES.plugins.from, type: "push" },
    { key: "plugins", Comp: ScenePlugins, start: SCENES.plugins.from, end: SCENES.custombot.from, type: "whip" },
    { key: "channel", Comp: SceneChannel, start: SCENES.custombot.from, end: SCENES.morecta.from, type: "push" },
    { key: "morecta", Comp: SceneMoreCta, start: SCENES.morecta.from, end: TOTAL, type: "dissolve" },
  ];

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Audio src={staticFile(MUSIC)} volume={musicVolume} />

      {/* Voice-over per line (absolute timeline — never shifted by transitions) */}
      {Object.values(VO).map((v) => (
        <Sequence key={v.id} from={v.startFrame} durationInFrames={v.frames + 8}>
          <Audio src={staticFile(v.file)} volume={1} />
        </Sequence>
      ))}

      {/* Transition whooshes at each cut (skip the first scene). Volume tracks
          the transition energy so kinetic "whip" cuts hit harder than gentle
          "dissolve" settles — keeps the repeated swoosh from feeling flat. */}
      {defs.slice(1).map(({ key, start, type }) => {
        const vol = type === "whip" ? 0.6 : type === "push" ? 0.45 : 0.3;
        return (
          <Sequence key={`w-${key}`} from={start - T} durationInFrames={22}>
            <Audio src={staticFile(WHOOSH)} volume={vol} />
          </Sequence>
        );
      })}

      {/* Scenes overlap by T frames so the incoming scene's transition plays
          over the outgoing one. */}
      {defs.map(({ key, Comp, start, end, type }, i) => {
        const from = i === 0 ? 0 : start - T;
        return (
          <Sequence key={key} from={from} durationInFrames={end - from}>
            <SceneTransition type={type}>
              <Comp />
            </SceneTransition>
          </Sequence>
        );
      })}

      <Fades total={TOTAL} />
    </AbsoluteFill>
  );
};
