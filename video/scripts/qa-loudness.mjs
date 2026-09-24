// Loudness gate (EBU R128 via ffmpeg's ebur128 filter): integrated loudness,
// true peak and loudness range for each file, checked against targets.
//
// Usage: node scripts/qa-loudness.mjs <file...> [--target -14] [--tolerance 1]
//          [--tp-max -1] [--lra-max <LU>]
//   --target     integrated loudness target (LUFS). Promo masters: -14; web cuts: -16.
//   --tolerance  allowed |I − target| in LU (default 1).
//   --tp-max     highest allowed true peak in dBTP (default -1.0).
//   --lra-max    optional ceiling for the loudness range (LU).
// Works on any file with an audio stream (wav, mp3, mp4). Exit code 1 on a fail.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fail, main, parseArgs } from "./qa-lib.mjs";

const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

/** Run ebur128 (true peak on) and parse the last Summary block. */
function measure(file) {
  const r = spawnSync(
    FFMPEG,
    ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-filter:a", "ebur128=peak=true", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 1 << 28 },
  );
  if (r.error) fail(`ffmpeg failed to start (${r.error.message})`);
  if (r.status !== 0) fail(`ffmpeg could not measure ${file}:\n${r.stderr.slice(-800)}`);
  const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const num = (re) => {
    const m = re.exec(summary);
    return m ? Number(m[1]) : NaN;
  };
  return {
    I: num(/I:\s+(-?[\d.]+|-inf) LUFS/),
    LRA: num(/LRA:\s+(-?[\d.]+) LU/),
    TP: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/),
  };
}

main(async () => {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (positional.length === 0) {
    fail("usage: node scripts/qa-loudness.mjs <file...> [--target -14] [--tolerance 1] [--tp-max -1] [--lra-max LU]");
  }
  const target = flags.target !== undefined ? Number(flags.target) : -14;
  const tolerance = flags.tolerance !== undefined ? Number(flags.tolerance) : 1;
  const tpMax = flags["tp-max"] !== undefined ? Number(flags["tp-max"]) : -1;
  const lraMax = flags["lra-max"] !== undefined ? Number(flags["lra-max"]) : null;

  let failures = 0;
  for (const file of positional) {
    if (!fs.existsSync(file)) fail(`no such file: ${file}`);
    const m = measure(file);
    const checks = [
      [`I ${m.I.toFixed(1)} LUFS (target ${target} ±${tolerance})`, Math.abs(m.I - target) <= tolerance],
      [`TP ${m.TP.toFixed(1)} dBTP (≤ ${tpMax})`, m.TP <= tpMax],
      ...(lraMax !== null ? [[`LRA ${m.LRA.toFixed(1)} LU (≤ ${lraMax})`, m.LRA <= lraMax]] : [[`LRA ${m.LRA.toFixed(1)} LU`, true]]),
    ];
    const ok = checks.every(([, pass]) => pass);
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${file}`);
    for (const [text, pass] of checks) console.log(`   ${pass ? " ok " : "FAIL"} ${text}`);
  }
  return failures ? 1 : 0;
});
