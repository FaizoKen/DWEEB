import React from "react";
import { Composition } from "remotion";
import { DweebPromo } from "./DweebPromo";
import { TOTAL, FPS } from "./timeline";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* 16:9 master */}
      <Composition
        id="DweebPromo"
        component={DweebPromo}
        durationInFrames={TOTAL}
        fps={FPS}
        width={1920}
        height={1080}
      />
      {/* 9:16 social cut — same film; scenes detect the portrait viewport and
          swap in vertical camera framings (and a few responsive layouts). */}
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
