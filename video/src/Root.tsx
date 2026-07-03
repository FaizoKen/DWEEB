import React from "react";
import { Composition } from "remotion";
import { DweebPromo } from "./DweebPromo";
import { TOTAL, FPS } from "./timeline";

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
    </>
  );
};
