// Re-edit ONLY music.wav from the current manifest — no TTS, no network, no
// timing change (the voice-over and every scene cut stay put). The edit is
// planned by the same code `npm run audio` uses (lib/music-edit.mjs on
// lib/film-timing.mjs), so both always land the drop on the same frame.
//
//   npm run music                  # from the licensed track in assets-src/
//   npm run music -- --synth-music # synthesized stand-in, no track needed
//   npm run music -- --plan        # print the edit plan only

import { readManifest, writeManifest } from "./lib/film-timing.mjs";
import { buildFilmMusic, planMusicEdit } from "./lib/music-edit.mjs";

const manifest = readManifest();
if (process.argv.includes("--plan")) {
  const plan = planMusicEdit(manifest);
  console.log(JSON.stringify({ ...plan.report, segments: plan.segments }, null, 2));
} else {
  const music = await buildFilmMusic(manifest, { synth: process.argv.includes("--synth-music") });
  writeManifest({ ...manifest, music });
}
