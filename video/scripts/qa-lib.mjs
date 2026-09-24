// Shared plumbing for the film's QA scripts (stills.mjs, qa-cuts.mjs,
// qa-captions.mjs, qa-bench.mjs): one bundle, ONE browser for every render,
// the film timeline read back out of the bundle, frame-spec parsing, and PNG
// pixel access through ffmpeg (no image dependencies to install).
//
// Everything that renders goes through `withRenderer`, which always closes the
// browser and removes the run's temp folders — this machine is small and
// shared, so a stray headless Chrome (or 4 MB of profile per run) is a real
// cost, not a cosmetic one. A run that dies says so, with what it was doing.
import { bundle } from "@remotion/bundler";
import { openBrowser, renderFrames, renderStill, selectComposition } from "@remotion/renderer";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VIDEO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ── Temp folders this process owns ──────────────────────────────────────── */

// Remotion makes its temp folders directly in os.tmpdir(): the bundle
// (remotion-webpack-bundle-*), the browser profile (puppeteer_dev_chrome_profile-*)
// and one asset folder per render call (remotion-v<version>-assets*). It
// removes them only when a run finishes cleanly — and on Windows never removes
// the profile at all (it deletes it before taskkill has ended Chrome), so every
// run left ~4 MB behind and a run that died mid-render left all three.
// Recording every such folder THIS process creates lets the exit path remove
// exactly those, never a concurrent run's.
const TMP = path.resolve(os.tmpdir());
const OWNED_PREFIXES = ["remotion-", "puppeteer_dev_chrome_profile-"];
const ownedTemp = new Set();
const track = (dir) => {
  if (typeof dir !== "string") return;
  const p = path.resolve(dir);
  if (path.dirname(p) === TMP && OWNED_PREFIXES.some((pre) => path.basename(p).startsWith(pre))) ownedTemp.add(p);
};
{
  const mkdirSync = fs.mkdirSync;
  fs.mkdirSync = function (dir, ...rest) {
    const made = mkdirSync.call(this, dir, ...rest);
    track(dir);
    return made;
  };
  const mkdtemp = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function (...args) {
    const dir = await mkdtemp.apply(this, args);
    track(dir);
    return dir;
  };
  // The renderer's ESM build imports `mkdirSync` by name: re-point that binding too.
  syncBuiltinESMExports();
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Remove every temp folder this process created that still exists. Sync, so
 * it can run from the 'exit' listener. Chrome's processes release the profile
 * a few hundred ms after they are killed, so a locked folder is retried for up
 * to `patienceMs` (rmSync's own maxRetries does not retry that EPERM on
 * Windows); returns the folders that stayed locked.
 */
function removeOwnedTemp(patienceMs = 3000) {
  const failed = [];
  for (const dir of ownedTemp) {
    const t0 = Date.now();
    for (;;) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        ownedTemp.delete(dir);
        break;
      } catch (err) {
        if (Date.now() - t0 >= patienceMs) {
          failed.push(`${dir} (${err.code ?? err.message})`);
          break;
        }
        sleepSync(100);
      }
    }
  }
  return failed;
}

/* ── Dying loudly ────────────────────────────────────────────────────────── */

// A render that dies must say so: a stills batch once stopped after two frames
// with exit 127 and no message at all. Whatever is in flight is recorded, and
// on the way out the exit code (or the signal) is printed with it and this
// process's temp folders are removed. An exit while something is still in
// flight counts as a death even with code 0 — Node exits 0 when the event loop
// empties under a promise that never settles. (A hard kill — TerminateProcess,
// SIGKILL, a native crash — runs no handler at all.)
const SCRIPT = path.basename(process.argv[1] ?? "qa");
let inFlight = null;
const note = (msg) => {
  try {
    fs.writeSync(2, `[${SCRIPT}] ${msg}\n`); // sync: nothing async runs at exit
  } catch {
    // stderr gone
  }
};
/** Run `fn` with `what` recorded as in flight (reported if the process dies meanwhile). */
async function during(what, fn) {
  const outer = inFlight;
  inFlight = what;
  try {
    return await fn();
  } finally {
    inFlight = outer;
  }
}

/** Open browsers → their main process id (Remotion's own kill at exit is async, too late for the profile). */
const openBrowsers = new Map();
const killNow = (pid) => {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
};
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 };
for (const [sig, n] of Object.entries(SIGNALS)) {
  try {
    process.on(sig, () => {
      note(`received ${sig}${inFlight ? ` while ${inFlight}` : ""} — closing the browser and cleaning up`);
      const closing = Promise.all([...openBrowsers.keys()].map((b) => b.close({ silent: true }).catch(() => {})));
      const timeout = new Promise((r) => setTimeout(r, 3000));
      Promise.race([closing, timeout]).finally(() => process.exit(128 + n));
    });
  } catch {
    // signal not supported on this platform
  }
}
process.on("exit", (code) => {
  if (inFlight) {
    note(
      `died with exit code ${code} while ${inFlight}` +
        (code === 0 ? " (the event loop emptied under a promise that never settled)" : ""),
    );
    if (code === 0) process.exitCode = 1;
  } else if (code !== 0) {
    note(`exiting with code ${code}`);
  }
  // Chrome holds its profile folder open: end it first, synchronously.
  for (const pid of openBrowsers.values()) killNow(pid);
  const left = removeOwnedTemp();
  if (left.length) note(`could not remove ${left.length} temp folder(s): ${left.join(", ")}`);
});

/* ── CLI helpers ─────────────────────────────────────────────────────────── */

/**
 * Minimal argv parser: `--key value`, `--key=value`, bare `--flag` (true) and
 * positionals. `booleans` names flags that never take a value.
 */
export function parseArgs(argv, booleans = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (booleans.includes(a.slice(2)) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = true;
    } else {
      flags[a.slice(2)] = argv[++i];
    }
  }
  return { flags, positional };
}

/**
 * Abort with a readable message. Throws (never process.exit) so withRenderer's
 * cleanup still closes the browser; `main()` below prints it and sets the exit
 * code.
 */
export class QaError extends Error {}
export const fail = (msg) => {
  throw new QaError(msg);
};

/** Run a script's async entry point with uniform error reporting. */
export function main(fn) {
  fn().then(
    (code) => {
      process.exitCode = typeof code === "number" ? code : 0;
    },
    (err) => {
      console.error(err instanceof QaError ? err.message : err);
      process.exitCode = 1;
    },
  );
}

/* ── Bundle + browser ────────────────────────────────────────────────────── */

/**
 * Bundle the film once. `entry` / `publicDir` let an A/B experiment bundle a
 * snapshot of src/ (see stills.mjs --entry) without touching the live tree.
 */
export async function makeBundle({ entry, publicDir } = {}) {
  const entryPoint = path.resolve(entry ?? path.join(VIDEO_ROOT, "src", "index.ts"));
  const t0 = Date.now();
  const serveUrl = await bundle({
    entryPoint,
    publicDir: publicDir ? path.resolve(publicDir) : path.join(VIDEO_ROOT, "public"),
    onProgress: () => {},
  });
  console.log(`bundled ${path.relative(VIDEO_ROOT, entryPoint)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return serveUrl;
}

/** Browser console lines worth surfacing (the acceptance bar is "no console errors"). */
export function makeLogCollector() {
  const errors = [];
  const warnings = [];
  const onBrowserLog = (log) => {
    if (log.type === "error") errors.push(log.text);
    else if (log.type === "warning") warnings.push(log.text);
  };
  return { errors, warnings, onBrowserLog };
}

/**
 * Bundle, open ONE headless Chrome, run `fn({ serveUrl, browser, logs })`, and
 * always clean up — browser closed, this run's temp folders (bundle, browser
 * profile, asset folders) deleted — on success, on error and on a signal; if
 * the process dies anyway, the 'exit' listener above says so and cleans up.
 */
export async function withRenderer(opts, fn) {
  const serveUrl = await during("bundling", () => makeBundle(opts));
  const browser = await during("opening the browser", () => openBrowser("chrome", { chromiumOptions: { gl: "angle" } }));
  const info = await browser.connection.send("SystemInfo.getProcessInfo").catch(() => null);
  openBrowsers.set(browser, info?.value?.processInfo?.find((p) => p.type === "browser")?.id);
  const logs = makeLogCollector();
  try {
    return await fn({ serveUrl, browser, logs });
  } finally {
    await during("closing the browser", () => browser.close({ silent: true }).catch(() => {}));
    openBrowsers.delete(browser);
    removeOwnedTemp();
  }
}

export async function selectComp(ctx, id, inputProps = {}) {
  return during(`selecting composition ${id}`, () =>
    selectComposition({
      serveUrl: ctx.serveUrl,
      id,
      inputProps,
      puppeteerInstance: ctx.browser,
      onBrowserLog: ctx.logs.onBrowserLog,
    }),
  );
}

/** Render one PNG still with the shared browser; returns elapsed ms. */
export async function renderPng(ctx, composition, { frame, output, scale = 0.5, inputProps = {} }) {
  const t0 = Date.now();
  await during(`rendering ${composition.id} frame ${frame} → ${output}`, () =>
    renderStill({
      composition,
      serveUrl: ctx.serveUrl,
      output,
      frame,
      scale,
      inputProps,
      imageFormat: "png",
      overwrite: true,
      puppeteerInstance: ctx.browser,
      onBrowserLog: ctx.logs.onBrowserLog,
      chromiumOptions: { gl: "angle" },
    }),
  );
  return Date.now() - t0;
}

/**
 * Render a contiguous frame range in one page (no per-still page setup), for
 * benchmarks. Returns the per-frame render times Remotion reports.
 */
export async function renderRange(ctx, composition, { from, to, scale = 1, outputDir, imageFormat = "png" }) {
  const times = [];
  await during(`rendering ${composition.id} frames ${from}–${to}`, () =>
    renderFrames({
      composition,
      serveUrl: ctx.serveUrl,
      inputProps: composition.props ?? {},
      frameRange: [from, to],
      outputDir,
      imageFormat,
      scale,
      concurrency: 1,
      puppeteerInstance: ctx.browser,
      onBrowserLog: ctx.logs.onBrowserLog,
      chromiumOptions: { gl: "angle" },
      onStart: () => {},
      onFrameUpdate: (_done, frame, ms) => times.push({ frame, ms }),
    }),
  );
  return times;
}

/* ── Timeline (read from the bundle, never re-derived here) ──────────────── */

/**
 * The film timeline as the bundle computes it (SceneProbe's calculateMetadata
 * returns it as props), so these scripts can never drift from timeline.ts.
 * Shape: { fps, total, T, scenes: [{ id, from, seqFrom, end, transition }],
 * captions, captionReport }.
 */
export async function getTimeline(ctx) {
  const comp = await selectComp(ctx, "SceneProbe", { scene: "hook" });
  const tl = comp.props?.timeline;
  if (!tl) fail("The bundle has no SceneProbe timeline — is src/dev/SceneProbe.tsx registered in Root.tsx?");
  return tl;
}

export const sceneById = (tl, id) => {
  const s = tl.scenes.find((x) => x.id === id);
  if (!s) fail(`Unknown scene "${id}". Scenes: ${tl.scenes.map((x) => x.id).join(", ")}`);
  return s;
};

/* ── Frame specs ─────────────────────────────────────────────────────────── */

/**
 * Parse one frame spec into a list of targets. A target is either
 * `{ abs }` (film frame) or `{ scene, local }` (scene-local frame, the same
 * frame space as voDelay / useCurrentFrame inside a scene). Both forms are
 * resolvable for both kinds of composition (film or SceneProbe).
 *
 *   120            film frame 120
 *   100-140:5      film frames 100,105,…,140 (step optional)
 *   build+34       scene-local frame 34 of build (relative to its Sequence start)
 *   build+10..60:5 scene-local range
 *   @build         the cut into build (first frame it is fully on screen)
 *   @build-1       the last frame before that cut (the outgoing scene)
 *   @build-16..0:2 a range around the cut (offsets relative to it)
 *   build$         the last frame build is on screen in the film
 *   build$-8..0:2  a range ending there
 * (Quote specs containing `$` in a POSIX shell: 'build$'.)
 */
export function parseFrameSpec(spec) {
  let m;
  if ((m = /^(\d+)(?:-(\d+))?(?::(\d+))?$/.exec(spec))) {
    const a = +m[1];
    const b = m[2] !== undefined ? +m[2] : a;
    const step = m[3] !== undefined ? +m[3] : 1;
    return range(a, b, step).map((abs) => ({ abs, label: String(abs) }));
  }
  if ((m = /^([a-z]+)([+-]\d+)(?:\.\.([+-]?\d+))?(?::(\d+))?$/i.exec(spec))) {
    const scene = m[1];
    const a = +m[2];
    const b = m[3] !== undefined ? +m[3] : a;
    const step = m[4] !== undefined ? +m[4] : 1;
    return range(a, b, step).map((local) => ({ scene, local, label: `${scene}+${local}` }));
  }
  const signed = (off) => (off ? (off > 0 ? "+" : "") + off : "");
  if ((m = /^@([a-z]+)([+-]\d+)?(?:\.\.([+-]?\d+))?(?::(\d+))?$/i.exec(spec))) {
    const scene = m[1];
    const a = m[2] !== undefined ? +m[2] : 0;
    const b = m[3] !== undefined ? +m[3] : a;
    const step = m[4] !== undefined ? +m[4] : 1;
    return range(a, b, step).map((off) => ({ cut: scene, off, label: `@${scene}${signed(off)}` }));
  }
  if ((m = /^([a-z]+)\$([+-]\d+)?(?:\.\.([+-]?\d+))?(?::(\d+))?$/i.exec(spec))) {
    const scene = m[1];
    const a = m[2] !== undefined ? +m[2] : 0;
    const b = m[3] !== undefined ? +m[3] : a;
    const step = m[4] !== undefined ? +m[4] : 1;
    return range(a, b, step).map((off) => ({ last: scene, off, label: `${scene}$${signed(off)}` }));
  }
  fail(
    `Can't parse frame spec "${spec}" (try 120, 100-140:5, build+34, build+0..60:10, @build, @build-1, ` +
      "@build-16..0:2, build$, build$-8..0:2)",
  );
}

const range = (a, b, step) => {
  if (step <= 0) fail("frame step must be positive");
  const out = [];
  for (let f = a; a <= b ? f <= b : f >= b; f += a <= b ? step : -step) out.push(f);
  return out;
};

export const specNeedsTimeline = (t) => t.abs === undefined;

/** Resolve a parsed target to an absolute film frame. */
export function toAbs(tl, t) {
  if (t.abs !== undefined) return t.abs;
  if (t.scene) return sceneById(tl, t.scene).seqFrom + t.local;
  if (t.cut) return sceneById(tl, t.cut).from + t.off;
  if (t.last) return sceneById(tl, t.last).end - 1 + t.off;
  fail("bad target");
}

/**
 * Resolve a parsed target to `{ scene, local }` for SceneProbe. A plain film
 * frame maps to the scene that is on screen at that frame (the incoming scene
 * once its cut has happened).
 */
export function toProbe(tl, t) {
  if (t.scene) return { scene: t.scene, local: t.local };
  if (t.cut) {
    const s = sceneById(tl, t.cut);
    return { scene: s.id, local: s.from - s.seqFrom + t.off };
  }
  if (t.last) {
    const s = sceneById(tl, t.last);
    return { scene: s.id, local: s.end - 1 - s.seqFrom + t.off };
  }
  const s = tl.scenes.find((x) => t.abs >= x.from && t.abs < x.end) ?? tl.scenes[tl.scenes.length - 1];
  return { scene: s.id, local: t.abs - s.seqFrom };
}

/* ── PNG pixels via ffmpeg ───────────────────────────────────────────────── */

const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

export function ffmpeg(args, { input, cwd } = {}) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-v", "error", ...args], {
    input,
    cwd,
    maxBuffer: 1 << 30,
  });
  if (r.error) fail(`ffmpeg failed to start (${r.error.message}). Is ffmpeg on PATH? Set FFMPEG=... to override.`);
  if (r.status !== 0) fail(`ffmpeg ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}

/** PNG width/height straight from the IHDR chunk. */
export function pngSize(file) {
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(24);
  fs.readSync(fd, b, 0, 24, 0);
  fs.closeSync(fd);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** Decode a PNG to packed RGB bytes. */
export function readRgb(file) {
  const { w, h } = pngSize(file);
  const data = ffmpeg(["-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  if (data.length !== w * h * 3) fail(`unexpected decode size for ${file}`);
  return { w, h, data };
}

export function writeRgb(file, { w, h, data }) {
  ffmpeg(["-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "pipe:0", file], {
    input: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
  });
}

/* ── Contact sheets ──────────────────────────────────────────────────────── */

const LABEL_FONTS = [
  "C:/Windows/Fonts/consola.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
];

/**
 * Tile PNGs (all the same size) into one sheet with each tile's label burned
 * in. Labels go through textfile= and the font is copied next to the tiles so
 * no Windows drive-letter colon ever reaches an ffmpeg filter string.
 */
export function contactSheet(items, output, { cols = 4, thumbWidth = 480 } = {}) {
  if (items.length === 0) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dweeb-sheet-"));
  try {
    const font = LABEL_FONTS.find((f) => fs.existsSync(f));
    if (font) fs.copyFileSync(font, path.join(tmp, "font.ttf"));
    else console.warn("contact sheet: no label font found; tiles will be unlabeled");
    items.forEach((item, i) => {
      const n = String(i + 1).padStart(4, "0");
      fs.writeFileSync(path.join(tmp, `label-${n}.txt`), item.label);
      const draw = font
        ? `,drawtext=fontfile=font.ttf:textfile=label-${n}.txt:fontcolor=white:fontsize=22:x=10:y=10:box=1:boxcolor=black@0.72:boxborderw=6`
        : "";
      ffmpeg(["-y", "-i", path.resolve(item.file), "-vf", `scale=${thumbWidth}:-2${draw}`, `thumb-${n}.png`], {
        cwd: tmp,
      });
    });
    const rows = Math.ceil(items.length / cols);
    ffmpeg(
      [
        "-y",
        "-framerate",
        "1",
        "-i",
        "thumb-%04d.png",
        "-vf",
        `tile=${cols}x${rows}:padding=6:margin=6:color=0x202225`,
        "-frames:v",
        "1",
        path.resolve(output),
      ],
      { cwd: tmp },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export const pad4 = (n) => String(n).padStart(4, "0");

/* ── Image comparison ────────────────────────────────────────────────────── */
// All metrics work on two same-size RGB images ({ w, h, data }). Thresholds are
// in 0–255 levels; areas are in pixels of the images as rendered, so callers
// scale them by (render scale)².

const luma = ({ w, h, data }) => {
  const y = new Float32Array(w * h);
  for (let i = 0, p = 0; i < y.length; i++, p += 3) y[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return y;
};

const assertSameSize = (a, b) => {
  if (a.w !== b.w || a.h !== b.h) fail(`image sizes differ: ${a.w}x${a.h} vs ${b.w}x${b.h}`);
};

const maxChannelDiff = (a, b, p) =>
  Math.max(
    Math.abs(a.data[p] - b.data[p]),
    Math.abs(a.data[p + 1] - b.data[p + 1]),
    Math.abs(a.data[p + 2] - b.data[p + 2]),
  );

/** Per-pixel max-channel |A−B|: max, mean, p99 and counts over thresholds. */
export function diffStats(a, b) {
  assertSameSize(a, b);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let p = 0; p < a.data.length; p += 3) {
    const d = maxChannelDiff(a, b, p);
    hist[d]++;
    sum += d;
  }
  const n = a.w * a.h;
  let max = 0;
  for (let d = 255; d >= 0; d--) {
    if (hist[d]) {
      max = d;
      break;
    }
  }
  let acc = 0;
  let p99 = 0;
  for (let d = 0; d < 256; d++) {
    acc += hist[d];
    if (acc >= n * 0.99) {
      p99 = d;
      break;
    }
  }
  const over = (t) => {
    let c = 0;
    for (let d = t + 1; d < 256; d++) c += hist[d];
    return c;
  };
  return { max, mean: sum / n, p99, over2: over(2), over8: over(8), over24: over(24), pixels: n };
}

/** |A−B| × amp as an RGB image (black = identical). */
export function amplifiedDiff(a, b, amp = 8) {
  assertSameSize(a, b);
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.abs(a.data[i] - b.data[i]) * amp);
  return { w: a.w, h: a.h, data: out };
}

/** Draw 2-px rectangle outlines onto an RGB image in place. */
export function drawBoxes(img, boxes, rgb = [255, 64, 64]) {
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
    const p = (y * img.w + x) * 3;
    img.data[p] = rgb[0];
    img.data[p + 1] = rgb[1];
    img.data[p + 2] = rgb[2];
  };
  for (const { x0, y0, x1, y1 } of boxes) {
    for (let t = 0; t < 2; t++) {
      for (let x = x0 - t; x <= x1 + t; x++) {
        put(x, y0 - t);
        put(x, y1 + t);
      }
      for (let y = y0 - t; y <= y1 + t; y++) {
        put(x0 - t, y);
        put(x1 + t, y);
      }
    }
  }
  return img;
}

/**
 * Block matching: for every textured block of A, find the offset (within
 * ±radius) that best matches B. A block counts as MOVED only when a non-zero
 * offset explains the difference (it beats the in-place match by `gain` and the
 * in-place difference is above anti-aliasing noise) — this is what separates a
 * real 1–2 px jump from re-rasterized edges, which raw PSNR cannot.
 */
export function blockMatch(a, b, { block = 16, radius = 6, minStd = 4, noise = 1.2, gain = 0.6 } = {}) {
  assertSameSize(a, b);
  const { w, h } = a;
  const ya = luma(a);
  const yb = luma(b);
  const n = block * block;
  const blocks = [];
  for (let by = 0; by + block <= h; by += block) {
    for (let bx = 0; bx + block <= w; bx += block) {
      let s = 0;
      let s2 = 0;
      for (let y = 0; y < block; y++) {
        for (let x = 0; x < block; x++) {
          const v = ya[(by + y) * w + bx + x];
          s += v;
          s2 += v * v;
        }
      }
      const std = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
      if (std < minStd) continue;
      const sad = (dx, dy) => {
        let t = 0;
        for (let y = 0; y < block; y++) {
          const ra = (by + y) * w + bx;
          const rb = (by + y + dy) * w + bx + dx;
          for (let x = 0; x < block; x++) t += Math.abs(ya[ra + x] - yb[rb + x]);
        }
        return t / n;
      };
      const zero = sad(0, 0);
      let best = zero;
      let bdx = 0;
      let bdy = 0;
      if (zero > noise) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (by + dy < 0 || by + dy + block > h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            if ((dx === 0 && dy === 0) || bx + dx < 0 || bx + dx + block > w) continue;
            const v = sad(dx, dy);
            if (v < best) {
              best = v;
              bdx = dx;
              bdy = dy;
            }
          }
        }
      }
      const moved = (bdx !== 0 || bdy !== 0) && best < zero * gain;
      blocks.push({ x: bx, y: by, dx: moved ? bdx : 0, dy: moved ? bdy : 0, zero, best, moved });
    }
  }
  const moved = blocks.filter((k) => k.moved);
  const votes = new Map();
  for (const k of moved) votes.set(`${k.dx},${k.dy}`, (votes.get(`${k.dx},${k.dy}`) ?? 0) + 1);
  const dominant = [...votes.entries()].sort((p, q) => q[1] - p[1])[0];
  return {
    textured: blocks.length,
    moved: moved.length,
    dominant: dominant ? { offset: dominant[0], blocks: dominant[1] } : null,
    movedBoxes: moved.map((k) => ({ x0: k.x, y0: k.y, x1: k.x + block - 1, y1: k.y + block - 1 })),
  };
}

/**
 * Connected regions where |A−B| exceeds `threshold` (max channel), keeping only
 * those of at least `minArea` pixels — elements that appeared, vanished or
 * changed. Isolated anti-aliasing pixels and the drifting background dust fall
 * under the area floor.
 */
export function changedRegions(a, b, { threshold = 24, minArea = 24 } = {}) {
  assertSameSize(a, b);
  const { w, h } = a;
  const mask = new Uint8Array(w * h);
  const diff = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    const d = maxChannelDiff(a, b, p);
    diff[i] = d;
    mask[i] = d > threshold ? 1 : 0;
  }
  const regions = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1) continue;
    let top = 0;
    stack[top++] = start;
    mask[start] = 2;
    let area = 0;
    let peak = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (top) {
      const i = stack[--top];
      const x = i % w;
      const y = (i / w) | 0;
      area++;
      peak = Math.max(peak, diff[i]);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] === 1) {
            mask[j] = 2;
            stack[top++] = j;
          }
        }
      }
    }
    if (area >= minArea) regions.push({ x0, y0, x1, y1, area, peak });
  }
  regions.sort((p, q) => q.area - p.area);
  return { regions, area: regions.reduce((s, r) => s + r.area, 0) };
}

/**
 * Low-frequency change (a glow or background tone that shifts without any
 * edge): mean luma per `cell`×`cell` cell, flagged above `threshold` levels.
 */
export function tonalShift(a, b, { cell = 32, threshold = 1.5 } = {}) {
  assertSameSize(a, b);
  const { w, h } = a;
  const ya = luma(a);
  const yb = luma(b);
  const cells = [];
  let worst = 0;
  for (let cy = 0; cy + cell <= h; cy += cell) {
    for (let cx = 0; cx + cell <= w; cx += cell) {
      let d = 0;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const i = (cy + y) * w + cx + x;
          d += ya[i] - yb[i];
        }
      }
      d = Math.abs(d / (cell * cell));
      worst = Math.max(worst, d);
      if (d > threshold) cells.push({ x0: cx, y0: cy, x1: cx + cell - 1, y1: cy + cell - 1, d });
    }
  }
  return { cells, worst };
}

/**
 * The full comparison qa-cuts gates on, with thresholds scaled to the render
 * scale (they are tuned at scale 1 and 0.5 and hold in between).
 */
export function compareFrames(a, b, scale = 0.5) {
  const s2 = scale * scale;
  return {
    stats: diffStats(a, b),
    blocks: blockMatch(a, b, { block: scale >= 0.75 ? 32 : 16, radius: Math.max(4, Math.round(12 * scale)) }),
    changed: changedRegions(a, b, { minArea: Math.max(4, Math.round(96 * s2)) }),
    tonal: tonalShift(a, b, { cell: Math.max(8, Math.round(64 * scale)) }),
  };
}
