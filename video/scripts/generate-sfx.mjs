// Regenerate the whole UI sound-effects kit — click, tick, chime, pop, whoosh,
// riser and impact — WITHOUT touching the voice-over or the manifest. Runs fully
// offline (no TTS / network), so you can iterate on sound design freely:
//
//   npm run sfx
//
// The voice-over + timeline come from `npm run audio` instead.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllSfx } from "./audio-synth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "public", "audio");

buildAllSfx(OUT);
console.log("\nSFX kit regenerated.");
