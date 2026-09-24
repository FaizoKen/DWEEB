// Render-cost benchmark: renders a contiguous frame range in ONE page
// (concurrency 1, so numbers are comparable on a shared machine) and reports
// ms/frame. Use it before/after a render-perf change, ideally A/B against a
// snapshot of src/ via --entry so nothing else differs.
//
// Usage:
//   node scripts/qa-bench.mjs <comp> <from-to> [<from-to>...] [--scale 1] [--entry <file>] [--public <dir>]
// e.g.
//   node scripts/qa-bench.mjs DweebPromo 640-659 1020-1039 --scale 1
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail, main, parseArgs, renderRange, selectComp, withRenderer } from "./qa-lib.mjs";

main(async () => {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [compId, ...ranges] = positional;
  if (!compId || ranges.length === 0) fail("usage: node scripts/qa-bench.mjs <comp> <from-to>... [--scale 1]");
  const scale = flags.scale !== undefined ? Number(flags.scale) : 1;
  const spans = ranges.map((r) => {
    const m = /^(\d+)-(\d+)$/.exec(r);
    if (!m) fail(`bad range "${r}" (want from-to)`);
    return [+m[1], +m[2]];
  });

  return withRenderer({ entry: flags.entry, publicDir: flags.public }, async (ctx) => {
    const comp = await selectComp(ctx, compId);
    const all = [];
    for (const [from, to] of spans) {
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "dweeb-bench-"));
      try {
        const t0 = Date.now();
        const times = await renderRange(ctx, comp, { from, to, scale, outputDir });
        const wall = Date.now() - t0;
        // The first frame of a range pays for page setup and font loading;
        // "steady" statistics leave it out.
        const ms = times.map((t) => t.ms);
        const steady = ms.slice(1);
        all.push(...steady);
        const sorted = [...steady].sort((a, b) => a - b);
        console.log(
          `${compId} ${from}-${to}: steady mean ${(steady.reduce((a, b) => a + b, 0) / steady.length).toFixed(0)} ms, ` +
            `median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms over ${steady.length} frames ` +
            `(first frame ${ms[0].toFixed(0)} ms; wall ${(wall / ms.length).toFixed(0)} ms/frame)`,
        );
        console.log(`  per frame: ${times.map((t) => `${t.frame}:${t.ms.toFixed(0)}`).join(" ")}`);
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    }
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    const sorted = [...all].sort((a, b) => a - b);
    console.log(
      `TOTAL ${all.length} steady frames: mean ${mean.toFixed(0)} ms/frame, median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms/frame (scale ${scale})`,
    );
    if (ctx.logs.errors.length) console.log(`browser console errors: ${ctx.logs.errors.length}`);
    return 0;
  });
});
