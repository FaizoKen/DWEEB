// Rebuild the UI sound kit + public/audio/sfx.json WITHOUT touching the
// voice-over, the manifest or the score. Offline and deterministic (seeded), so
// sound design can be iterated freely and the committed files only change when
// a sound's source does:
//
//   npm run sfx

import { buildSfxKit } from "./audio-synth.mjs";

buildSfxKit();
