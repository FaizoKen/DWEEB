// Boundary check for every cut in both masters, through SceneProbe (each
// scene rendered ALONE — no transition blending, no captions — at the frames
// either side of its cut, on the film clock).
//
//   hold  — the outgoing scene's last visible frame vs the incoming scene's
//           first visible frame must be the same picture: no block displaced
//           (block matching), no region that appeared/vanished/changed, no
//           tonal shift. Anything else is a visible pop at an "invisible" cut.
//   match — both scenes at the same instant, at the start and the end of the
//           crossfade: whatever the two shots share (the message card) must
//           be registered — no displaced blocks. New content (the editor
//           assembling) may differ; it is reported, not failed.
//   dip / cut — different pictures by design: measured and shown, not gated.
//
// Usage: node scripts/qa-cuts.mjs [--out out/qa/cuts] [--scale 0.5]
//          [--aspect both|landscape|vertical] [--cuts templates,build] [--same-instant]
//   --same-instant  compare holds at the cut frame on both sides (removes the
//                   one frame of ambient motion between last and first frame).
// Writes <out>/<L|V>-<scene>-{a,b}.png, …-diff.png (|A−B|×8; red = changed
// regions, blue = displaced blocks), …-pair.png (A | B | diff), report.json.
// Exit code 1 when a gated cut fails.
import fs from "node:fs";
import path from "node:path";
import {
  VIDEO_ROOT,
  amplifiedDiff,
  compareFrames,
  drawBoxes,
  ffmpeg,
  getTimeline,
  main,
  parseArgs,
  readRgb,
  renderPng,
  selectComp,
  withRenderer,
  writeRgb,
} from "./qa-lib.mjs";

const MASTERS = [
  { key: "L", aspect: "landscape", probe: "SceneProbe" },
  { key: "V", aspect: "vertical", probe: "SceneProbeVertical" },
];

main(async () => {
  const { flags } = parseArgs(process.argv.slice(2), ["same-instant"]);
  const outDir = path.resolve(flags.out ?? path.join(VIDEO_ROOT, "out", "qa", "cuts"));
  const scale = flags.scale !== undefined ? Number(flags.scale) : 0.5;
  const masters = MASTERS.filter((m) => !flags.aspect || flags.aspect === "both" || flags.aspect === m.aspect);
  const only = flags.cuts ? new Set(String(flags.cuts).split(",")) : null;
  const sameInstant = !!flags["same-instant"];
  fs.mkdirSync(outDir, { recursive: true });

  return withRenderer({ entry: flags.entry, publicDir: flags.public }, async (ctx) => {
    const tl = await getTimeline(ctx);
    const comps = new Map();
    const probe = async (master, scene) => {
      const key = `${master.probe}:${scene}`;
      if (!comps.has(key)) comps.set(key, await selectComp(ctx, master.probe, { scene }));
      return comps.get(key);
    };
    const shoot = async (master, scene, abs, file) => {
      const s = tl.scenes.find((x) => x.id === scene);
      const local = abs - s.seqFrom;
      const comp = await probe(master, scene);
      await renderPng(ctx, comp, { frame: local, output: file, scale, inputProps: { scene } });
      return local;
    };

    const rows = [];
    for (const master of masters) {
      for (let i = 1; i < tl.scenes.length; i++) {
        const out = tl.scenes[i - 1];
        const inc = tl.scenes[i];
        if (only && !only.has(inc.id)) continue;
        const type = inc.transition;
        // Film frames to compare: [outgoing, incoming] pairs.
        const pairs =
          type === "match"
            ? [
                [inc.from - tl.T, inc.from - tl.T],
                [inc.from - 1, inc.from - 1],
              ]
            : type === "hold" && sameInstant
              ? [[inc.from, inc.from]]
              : [[inc.from - 1, inc.from]];

        const checks = [];
        for (const [pi, [fa, fb]] of pairs.entries()) {
          const stem = path.join(outDir, `${master.key}-${inc.id}${pairs.length > 1 ? `-${pi + 1}` : ""}`);
          const la = await shoot(master, out.id, fa, `${stem}-a.png`);
          const lb = await shoot(master, inc.id, fb, `${stem}-b.png`);
          const A = readRgb(`${stem}-a.png`);
          const B = readRgb(`${stem}-b.png`);
          const m = compareFrames(A, B, scale);
          const diff = amplifiedDiff(A, B, 8);
          drawBoxes(diff, m.changed.regions, [255, 64, 64]);
          drawBoxes(diff, m.blocks.movedBoxes, [64, 160, 255]);
          writeRgb(`${stem}-diff.png`, diff);
          ffmpeg(["-y", "-i", `${stem}-a.png`, "-i", `${stem}-b.png`, "-i", `${stem}-diff.png`, "-filter_complex", "hstack=inputs=3", `${stem}-pair.png`]);
          checks.push({
            frames: `${out.id}+${la} | ${inc.id}+${lb}`,
            abs: [fa, fb],
            moved: m.blocks.moved,
            textured: m.blocks.textured,
            dominant: m.blocks.dominant,
            regions: m.changed.regions.map((r) => ({
              x0: Math.round(r.x0 / scale),
              y0: Math.round(r.y0 / scale),
              x1: Math.round(r.x1 / scale),
              y1: Math.round(r.y1 / scale),
              area: Math.round(r.area / (scale * scale)),
              peak: r.peak,
            })),
            changedArea: Math.round(m.changed.area / (scale * scale)),
            tonalCells: m.tonal.cells.length,
            tonalWorst: +m.tonal.worst.toFixed(2),
            maxDiff: m.stats.max,
            files: { pair: `${stem}-pair.png`, diff: `${stem}-diff.png` },
          });
        }

        let verdict;
        if (type === "hold") {
          const c = checks[0];
          verdict = c.moved === 0 && c.regions.length === 0 && c.tonalCells === 0 ? "PASS" : "FAIL";
        } else if (type === "match") {
          verdict = checks.every((c) => c.moved === 0) ? "PASS" : "FAIL";
        } else {
          verdict = "info";
        }
        rows.push({ master: master.key, cut: inc.id, from: out.id, type, verdict, checks });
      }
    }

    // Table
    const pad = (s, n) => String(s).padEnd(n);
    console.log(
      `\n${pad("", 2)}${pad("cut", 22)}${pad("type", 7)}${pad("frames (scene+local)", 34)}${pad("moved", 16)}${pad("changed", 20)}${pad("tonal", 12)}verdict`,
    );
    for (const r of rows) {
      r.checks.forEach((c, k) => {
        const moved = `${c.moved}/${c.textured}${c.dominant ? ` ${c.dominant.offset}` : ""}`;
        const changed = `${c.regions.length} (${c.changedArea} px)`;
        const tonal = `${c.tonalCells} (${c.tonalWorst})`;
        console.log(
          `${pad(r.master, 2)}${pad(k === 0 ? `${r.from}→${r.cut}` : "", 22)}${pad(k === 0 ? r.type : "", 7)}${pad(c.frames, 34)}${pad(moved, 16)}${pad(changed, 20)}${pad(tonal, 12)}${k === 0 ? r.verdict : ""}`,
        );
      });
    }
    const gated = rows.filter((r) => r.verdict !== "info");
    const failed = gated.filter((r) => r.verdict === "FAIL");
    console.log(`\n${gated.length - failed.length}/${gated.length} gated cuts pass (scale ${scale}). Diffs: ${outDir}`);
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ scale, sameInstant, rows }, null, 2));
    if (ctx.logs.errors.length) console.log(`browser console errors: ${ctx.logs.errors.length}`);
    return failed.length ? 1 : 0;
  });
});
