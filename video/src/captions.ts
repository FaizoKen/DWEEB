// Every burned-in caption of the film, in play order. Each scene exports its
// own `captions` (absolute film frames, keyed to its VO), so a scene's supers
// live beside the beats they follow; this module only gathers them for the one
// top-level CaptionTrack in DweebPromo and for QA (npm run qa:captions).
import type { CaptionCue } from "./components/Caption";
import { captionReport } from "./components/CaptionTrack";
import { FPS } from "./timeline";
import { captions as hook } from "./scenes/S01Hook";
import { captions as reveal } from "./scenes/S02Reveal";
import { captions as templates } from "./scenes/S03Templates";
import { captions as build } from "./scenes/S04Build";
import { captions as assistant } from "./scenes/S05Assistant";
import { captions as plugins } from "./scenes/S06Plugins";
import { captions as send } from "./scenes/S07Send";
import { captions as activity } from "./scenes/S08Activity";
import { captions as cta } from "./scenes/S09Cta";

export const CAPTIONS: ReadonlyArray<CaptionCue> = [
  ...hook,
  ...reveal,
  ...templates,
  ...build,
  ...assistant,
  ...plugins,
  ...send,
  ...activity,
  ...cta,
].sort((a, b) => a.from - b.from);

/**
 * Reading-time and overlap audit of CAPTIONS (0.3 s/word + 0.5 s fully
 * legible, no two cues on screen at once per master). Computed on demand —
 * SceneProbe hands it to scripts/qa-captions.mjs.
 */
export const captionAudit = () => captionReport(CAPTIONS, FPS);
