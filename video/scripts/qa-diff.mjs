// Compare two PNG stills with the same metrics qa-cuts.mjs gates on — pixel
// stats, block-matching displacement, changed regions, tonal shift — and write
// an amplified diff (red boxes = changed regions, blue = moved blocks). For
// ad-hoc A/B checks: a font swap, a background change, a fix.
//
// Usage: node scripts/qa-diff.mjs <a.png> <b.png> [--out diff.png] [--amp 8] [--scale 0.5]
//   --scale is the render scale the stills were made at (area thresholds follow it).
import {
  amplifiedDiff,
  compareFrames,
  drawBoxes,
  fail,
  main,
  parseArgs,
  readRgb,
  writeRgb,
} from "./qa-lib.mjs";

main(async () => {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [fa, fb] = positional;
  if (!fa || !fb) fail("usage: node scripts/qa-diff.mjs <a.png> <b.png> [--out diff.png] [--amp 8] [--scale 0.5]");
  const scale = flags.scale !== undefined ? Number(flags.scale) : 0.5;
  const a = readRgb(fa);
  const b = readRgb(fb);
  const { stats: s, blocks: bm, changed: cr, tonal: ts } = compareFrames(a, b, scale);
  console.log(
    `pixels: max ${s.max}  mean ${s.mean.toFixed(3)}  p99 ${s.p99}  >2: ${s.over2}  >8: ${s.over8}  >24: ${s.over24}`,
  );
  console.log(
    `blocks: ${bm.moved}/${bm.textured} moved` +
      (bm.dominant ? `  dominant offset ${bm.dominant.offset} (${bm.dominant.blocks} blocks)` : ""),
  );
  console.log(
    `changed regions: ${cr.regions.length} (area ${cr.area} px)` +
      cr.regions
        .slice(0, 6)
        .map((r) => `  [${r.x0},${r.y0}–${r.x1},${r.y1} area ${r.area} peak ${r.peak}]`)
        .join(""),
  );
  console.log(`tonal: ${ts.cells.length} cells over threshold, worst ${ts.worst.toFixed(2)} levels`);
  if (flags.out) {
    const img = amplifiedDiff(a, b, flags.amp ? Number(flags.amp) : 8);
    drawBoxes(img, cr.regions, [255, 64, 64]);
    drawBoxes(img, bm.movedBoxes, [64, 160, 255]);
    writeRgb(flags.out, img);
    console.log(`wrote ${flags.out}`);
  }
  return 0;
});
