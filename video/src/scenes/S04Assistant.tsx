import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { AppWindow, ActionBar, AppTabs } from "../components/AppUI";
import {
  AssistantDock,
  CAMPAIGN_PROMPT,
  CampaignPreview,
  CampaignTree,
} from "../components/CampaignUI";
import { TypeText, useSpr } from "../components/Bits";
import { voDelay, seqFrom, SCENES, POP, TICK, CHIME } from "../timeline";
import { COLORS } from "../theme";

/** AI modifies the draft selected and refined in the previous two scenes. */
export const SceneAssistant: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("assistant");

  const tPanel = d + 2;
  const tPrompt = d + 14;
  const tThink = d + 62;
  const tApply = d + 88;

  const panelIn = useSpr(tPanel, { damping: 20, stiffness: 150 });
  const giveawayIn = useSpr(tApply, { damping: 14, stiffness: 165 });
  const replyIn = useSpr(tApply, { damping: 17, stiffness: 145 });
  const status = frame < tThink ? "prompt" : frame < tApply ? "thinking" : "done";

  // First keyframe continues the build scene's final framing and HOLDS through
  // the 16-frame overlap, so the visible cut lands on a static camera; the
  // last keyframe is what the plugins scene starts on. Both cuts: invisible.
  const shots: Shot[] = vert
    ? [
        { f: 16, x: 1440, y: 430, s: 1.72 },
        { f: tPrompt + 28, x: 1460, y: 430, s: 1.72 },
        { f: tApply + 34, x: 1215, y: 470, s: 1.48 },
      ]
    : [
        { f: 16, x: 1000, y: 500, s: 1.08 },
        { f: tPrompt + 26, x: 1120, y: 475, s: 1.18 },
        { f: tApply + 36, x: 1000, y: 500, s: 1.08 },
      ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots} phase={seqFrom("assistant")}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <AppWindow
            width={1680}
            height={900}
            leftWidth={520}
            left={
              <>
                <ActionBar />
                <AppTabs />
                <CampaignTree giveawayReveal={giveawayIn} />
              </>
            }
            right={
              <div
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "center",
                  marginTop: 18,
                  transform: `translateX(${-190 * panelIn}px)`,
                }}
              >
                <CampaignPreview
                  giveawayReveal={giveawayIn}
                  giveawayGlow={frame >= tApply && frame < tApply + 34}
                  punchy={frame >= tApply}
                  scale={0.98}
                />
              </div>
            }
            overlay={
              <AssistantDock
                reveal={panelIn}
                prompt={
                  <TypeText text={CAMPAIGN_PROMPT} start={tPrompt} cps={46} caretColor="#fff" />
                }
                status={status}
                replyReveal={replyIn}
              />
            }
          />
        </AbsoluteFill>
      </Camera>

      <Sequence from={tPanel} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.46} />
      </Sequence>
      {new Array(8).fill(0).map((_, i) => (
        <Sequence key={i} from={tPrompt + 4 + i * 5} durationInFrames={5}>
          <Audio src={staticFile(TICK)} volume={0.24} />
        </Sequence>
      ))}
      <Sequence from={tApply} durationInFrames={24}>
        <Audio src={staticFile(CHIME)} volume={0.58} />
      </Sequence>

      <Caption
        label="Built into the editor"
        parts={["Ask.", { hl: "Apply." }, "Keep building."]}
        delay={d + 8}
        out={SCENES.assistant.durationInFrames - 16}
        accent="#9b84ee"
      />
    </AbsoluteFill>
  );
};
