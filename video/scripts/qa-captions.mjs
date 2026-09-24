// Caption audit: every cue of the one caption track (src/captions.ts), with
// its absolute timing, how long it is FULLY legible (plate settled, last part
// risen, before the exit fade) against the spec's reading time
// (0.3 s/word + 0.5 s), and any overlap within a master. The numbers are
// computed inside the bundle (SceneProbe's timeline props), so they always
// match what renders.
//
// Usage: node scripts/qa-captions.mjs [--stills <outDir>] [--scale 0.5]
//   --stills  also render every cue at the middle of its legible span in both
//             masters, plus a contact sheet per master (placement check).
// Exit code 1 when a cue is too short to read or cues overlap.
import fs from "node:fs";
import path from "node:path";
import { contactSheet, getTimeline, main, pad4, parseArgs, renderPng, selectComp, withRenderer } from "./qa-lib.mjs";

main(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const scale = flags.scale !== undefined ? Number(flags.scale) : 0.5;

  return withRenderer({ entry: flags.entry, publicDir: flags.public }, async (ctx) => {
    const tl = await getTimeline(ctx);
    const { rows, issues } = tl.captionReport;
    const sec = (f) => (f / tl.fps).toFixed(2);
    const pad = (s, n) => String(s).padEnd(n);
    console.log(
      `\n${pad("id", 15)}${pad("aspect", 11)}${pad("from–to (f)", 16)}${pad("legible", 18)}${pad("need", 11)}${pad("", 7)}text`,
    );
    for (const r of rows) {
      console.log(
        `${pad(r.id, 15)}${pad(r.aspect, 11)}${pad(`${r.from}–${r.to}`, 16)}` +
          `${pad(`${r.legibleFrames} f (${sec(r.legibleFrames)}s)`, 18)}${pad(`${r.requiredFrames} f`, 11)}` +
          `${pad(r.ok ? "ok" : "SHORT", 7)}${r.label} · ${r.text}`,
      );
    }
    for (const j of tl.captionReport.joins ?? []) {
      console.log(`joined (${j.master}): ${j.a} → ${j.b} share one plate, seam ${j.start}–${j.end}`);
    }
    if (issues.length) {
      console.log(`\n${issues.length} issue(s):`);
      for (const i of issues) console.log(`  - ${i}`);
    } else {
      console.log("\nno issues");
    }

    if (flags.stills) {
      const outDir = path.resolve(flags.stills);
      fs.mkdirSync(outDir, { recursive: true });
      for (const [comp, key, aspect] of [
        ["DweebPromo", "L", "landscape"],
        ["DweebPromoVertical", "V", "vertical"],
      ]) {
        const composition = await selectComp(ctx, comp);
        const shot = [];
        for (const r of rows.filter((x) => x.aspect === "both" || x.aspect === aspect)) {
          const frame = Math.round((Math.max(r.legibleFrom, r.from) + Math.max(r.legibleTo, r.from + 1)) / 2);
          const file = path.join(outDir, `${key}-${r.id}-${pad4(frame)}.png`);
          await renderPng(ctx, composition, { frame, output: file, scale });
          shot.push({ file, label: `${key} ${pad4(frame)}  ${r.id}` });
          console.log(`rendered ${file}`);
        }
        contactSheet(shot, path.join(outDir, `sheet-captions-${key}.png`), { cols: key === "L" ? 3 : 5 });
      }
    }
    return issues.length ? 1 : 0;
  });
});
