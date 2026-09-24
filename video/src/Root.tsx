import React from "react";
import { Composition } from "remotion";
import { DweebPromo } from "./DweebPromo";
import { ActivityPreview } from "./ActivityPreview";
import { SHOWCASE_FRAMES, Showcase } from "./dev/Showcase";
import { SceneProbe, SceneProbeProps, calculateProbeMetadata } from "./dev/SceneProbe";
import { TOTAL, FPS } from "./timeline";

const PROBE_DEFAULTS: SceneProbeProps = { scene: "hook" };

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DweebPromo"
        component={DweebPromo}
        durationInFrames={TOTAL}
        fps={FPS}
        width={1920}
        height={1080}
      />
      {/* The 9:16 cut films the same 1920×1080 world (see Camera.tsx) with
          per-scene portrait framing — same scenes, audio and timeline. */}
      <Composition
        id="DweebPromoVertical"
        component={DweebPromo}
        durationInFrames={TOTAL}
        fps={FPS}
        width={1080}
        height={1920}
      />
      <Composition
        id="ActivityPreview"
        component={ActivityPreview}
        durationInFrames={300}
        fps={30}
        width={640}
        height={360}
      />
      {/* Dev-only: shared UI building blocks for still review (not the film). */}
      <Composition
        id="Showcase"
        component={Showcase}
        durationInFrames={SHOWCASE_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
      />
      {/* Dev-only QA: one scene alone (no transition, no captions) at a
          scene-local frame, per master; inputProps { scene }. Used by
          scripts/stills.mjs (SceneProbe, probes) and scripts/qa-cuts.mjs. */}
      <Composition
        id="SceneProbe"
        component={SceneProbe}
        durationInFrames={1}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={PROBE_DEFAULTS}
        calculateMetadata={calculateProbeMetadata}
      />
      <Composition
        id="SceneProbeVertical"
        component={SceneProbe}
        durationInFrames={1}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={PROBE_DEFAULTS}
        calculateMetadata={calculateProbeMetadata}
      />
    </>
  );
};
