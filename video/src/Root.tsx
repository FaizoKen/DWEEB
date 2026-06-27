import React from "react";
import { Composition } from "remotion";
import { DweebPromo } from "./DweebPromo";
import { TOTAL, FPS } from "./timeline";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="DweebPromo"
      component={DweebPromo}
      durationInFrames={TOTAL}
      fps={FPS}
      width={1920}
      height={1080}
    />
  );
};
