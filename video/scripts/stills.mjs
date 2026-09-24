// Visual QA without a full render: bundle once, open ONE browser, render any
// set of frames as PNGs (optionally tiled into a labelled contact sheet).
//
// Usage:
//   node scripts/stills.mjs <outDir> <comps> <frame-spec...> [options]
//
// comps (comma-separated): DweebPromo | DweebPromoVertical | both
//   | SceneProbe | SceneProbeVertical | probes | Showcase | any composition id
//   SceneProbe renders ONE scene alone (no transitions, no captions) at a
//   scene-local frame — use it to compare the two sides of a cut.
//
// frame specs (see qa-lib.mjs parseFrameSpec):
//   120 · 100-140:5 · build+34 · build+10..60:10 · @build · @build-1
//   · @build-16..0:2 · 'build$' · 'build$-8..0:2'
//   Scene-relative specs are resolved from the bundle's own timeline, so they
//   follow the manifest when the voice-over is re-recorded.
//
// options:
//   --scale 0.5     render scale (default 0.5; use 1 to judge small text)
//   --sheet         also write sheet-<comp>.png (labelled contact sheet)
//   --cols 4        contact-sheet columns
//   --props '{..}'  inputProps JSON for other compositions (e.g. Showcase)
//   --entry <file>  bundle a different entry point (A/B snapshot experiments)
//   --public <dir>  public dir for that bundle (default: video/public)
//
// Browser console errors are collected and reported at the end (the film's
// acceptance bar is "no console errors"); the exit code is 2 when there were any.
import fs from "node:fs";
import path from "node:path";
import {
  contactSheet,
  fail,
  getTimeline,
  main,
  pad4,
  parseArgs,
  parseFrameSpec,
  renderPng,
  selectComp,
  specNeedsTimeline,
  toAbs,
  toProbe,
  withRenderer,
} from "./qa-lib.mjs";

const FILM = { DweebPromo: "L", DweebPromoVertical: "V" };
const PROBE = { SceneProbe: "P", SceneProbeVertical: "PV" };

main(async () => {
  const { flags, positional } = parseArgs(process.argv.slice(2), ["sheet"]);
  const [outDir, compArg, ...specs] = positional;
  if (!outDir || !compArg || specs.length === 0) {
    fail("usage: node scripts/stills.mjs <outDir> <comps|both|probes> <frame-spec...> [--scale 0.5] [--sheet]");
  }
  const scale = flags.scale !== undefined ? Number(flags.scale) : 0.5;
  if (!(scale > 0 && scale <= 2)) fail(`bad --scale ${flags.scale}`);
  const props = flags.props ? JSON.parse(flags.props) : {};
  const comps = compArg
    .split(",")
    .flatMap((c) =>
      c === "both" ? ["DweebPromo", "DweebPromoVertical"] : c === "probes" ? ["SceneProbe", "SceneProbeVertical"] : [c],
    );
  const targets = specs.flatMap(parseFrameSpec);
  fs.mkdirSync(outDir, { recursive: true });

  return withRenderer({ entry: flags.entry, publicDir: flags.public }, async (ctx) => {
    const needsTimeline =
      comps.some((c) => PROBE[c]) || targets.some(specNeedsTimeline);
    const tl = needsTimeline ? await getTimeline(ctx) : null;
    const times = [];

    for (const compId of comps) {
      const rendered = [];
      if (PROBE[compId]) {
        // One composition per scene (its duration and props depend on it).
        const cache = new Map();
        for (const t of targets) {
          const { scene, local } = toProbe(tl, t);
          if (!cache.has(scene)) cache.set(scene, await selectComp(ctx, compId, { scene }));
          const comp = cache.get(scene);
          if (local < 0 || local >= comp.durationInFrames) {
            fail(`${t.label}: scene-local frame ${local} is outside ${scene} (0..${comp.durationInFrames - 1})`);
          }
          const file = path.join(outDir, `${PROBE[compId]}-${scene}-${pad4(local)}.png`);
          const ms = await renderPng(ctx, comp, { frame: local, output: file, scale, inputProps: { scene } });
          times.push(ms);
          rendered.push({ file, label: `${PROBE[compId]} ${scene}+${local}  (${t.label})` });
          console.log(`rendered ${file}  ${ms} ms`);
        }
      } else {
        const comp = await selectComp(ctx, compId, props);
        const prefix = FILM[compId] ?? compId;
        for (const t of targets) {
          const frame = toAbs(tl, t);
          if (frame < 0 || frame >= comp.durationInFrames) {
            fail(`${t.label}: frame ${frame} is outside ${compId} (0..${comp.durationInFrames - 1})`);
          }
          const file = path.join(outDir, `${prefix}-${pad4(frame)}.png`);
          const ms = await renderPng(ctx, comp, { frame, output: file, scale, inputProps: props });
          times.push(ms);
          rendered.push({ file, label: `${prefix} ${pad4(frame)}  ${t.label === String(frame) ? "" : t.label}` });
          console.log(`rendered ${file}  ${ms} ms`);
        }
      }
      if (flags.sheet) {
        const sheet = path.join(outDir, `sheet-${FILM[compId] ?? PROBE[compId] ?? compId}.png`);
        contactSheet(rendered, sheet, { cols: flags.cols ? Number(flags.cols) : 4 });
        console.log(`sheet ${sheet}`);
      }
    }

    const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
    console.log(`${times.length} stills, ${avg.toFixed(0)} ms/still average (scale ${scale})`);
    const uniq = (xs) => [...new Set(xs)];
    if (ctx.logs.warnings.length) {
      console.log(`browser warnings (${ctx.logs.warnings.length}):`);
      for (const w of uniq(ctx.logs.warnings).slice(0, 12)) console.log(`  ${w.slice(0, 300)}`);
    }
    if (ctx.logs.errors.length) {
      console.log(`BROWSER CONSOLE ERRORS (${ctx.logs.errors.length}):`);
      for (const e of uniq(ctx.logs.errors).slice(0, 12)) console.log(`  ${e.slice(0, 300)}`);
      return 2;
    }
    return 0;
  });
});
