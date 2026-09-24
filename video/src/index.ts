// Must stay the FIRST import. Remotion's bundle evaluates this root file
// BEFORE its own render entry, and that entry imports `remotion/no-react`,
// whose module init resets `window.remotion_delayRenderTimeouts`. Every
// delayRender() made at module level — src/fonts.ts holds rendering on its
// faces that way — then loses its timeout record: continueRender() still
// releases the frame, but can no longer cancel the timer, which fires
// cancelRender() once the timeout is up. Every full render then died one
// timeout in, on whatever frame was being drawn, while stills (done in
// seconds) never saw it. Evaluated here first, no-react's later import is a
// cache hit and resets nothing.
import "remotion/no-react";
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
