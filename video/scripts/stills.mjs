// Dev-only visual QA: bundle once, then render a batch of frames as PNGs.
// Usage: node scripts/stills.mjs <outDir> <comp> <frame> [frame...]
//        node scripts/stills.mjs <outDir> both 80 200 340
// comp = DweebPromo | DweebPromoVertical | both
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [outDir, compArg, ...frameArgs] = process.argv.slice(2);
if (!outDir || !compArg || frameArgs.length === 0) {
  console.error("usage: node scripts/stills.mjs <outDir> <comp|both> <frame...>");
  process.exit(1);
}
const frames = frameArgs.map((f) => parseInt(f, 10));
const comps = compArg === "both" ? ["DweebPromo", "DweebPromoVertical"] : [compArg];
fs.mkdirSync(outDir, { recursive: true });

const serveUrl = await bundle({
  entryPoint: path.join(__dirname, "..", "src", "index.ts"),
  onProgress: () => {},
});

for (const compId of comps) {
  const composition = await selectComposition({ serveUrl, id: compId });
  for (const frame of frames) {
    const out = path.join(outDir, `${compId === "DweebPromo" ? "L" : "V"}-${String(frame).padStart(4, "0")}.png`);
    await renderStill({
      composition,
      serveUrl,
      output: out,
      frame,
      scale: compId === "DweebPromo" ? 0.5 : 0.5,
      imageFormat: "png",
      chromiumOptions: { gl: "angle" },
    });
    console.log(`rendered ${out}`);
  }
}
process.exit(0);
