// Two ffmpeg binaries, each used for what only it can do:
//
// - BUNDLED (Remotion's own n7.1 build, shipped in node_modules): every step that
//   produces an artifact — decoding the VO/music sources, AAC encoding with
//   libfdk_aac. It is pinned with Remotion, so a rebuild on another machine
//   decodes and resamples bit-identically, and it is the decoder the renderer
//   itself uses, so what we measure is what the film plays.
// - SYSTEM (`ffmpeg` on PATH): measurement and mastering only. The bundled build
//   is slim — no ebur128, no alimiter — so loudness metering and the true-peak
//   limiter need a full build. Nothing a render depends on is made with it.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function compositorDir() {
  const { platform, arch } = process;
  const candidates =
    platform === "win32"
      ? [`@remotion/compositor-win32-${arch}-msvc`]
      : platform === "darwin"
        ? [`@remotion/compositor-darwin-${arch}`]
        : [`@remotion/compositor-linux-${arch}-gnu`, `@remotion/compositor-linux-${arch}-musl`];
  for (const name of candidates) {
    try {
      return require(name).dir;
    } catch {
      // try the next libc flavour
    }
  }
  return null;
}

let bundled = undefined;
/** `{ bin, env }` for Remotion's bundled ffmpeg, or null if it can't be located. */
export function bundledFfmpeg() {
  if (bundled !== undefined) return bundled;
  const dir = compositorDir();
  const bin = dir && path.join(dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  bundled =
    bin && fs.existsSync(bin)
      ? // Remotion runs its binaries with their own directory on the loader path.
        { bin, env: { ...process.env, LD_LIBRARY_PATH: dir, DYLD_LIBRARY_PATH: dir } }
      : null;
  return bundled;
}

/** Run the bundled ffmpeg (falls back to `npx remotion ffmpeg`). Throws with stderr on failure. */
export function runBundled(args, { quiet = true } = {}) {
  const b = bundledFfmpeg();
  const full = [...(quiet ? ["-hide_banner", "-loglevel", "error"] : []), ...args];
  const res = b
    ? spawnSync(b.bin, full, { env: b.env, maxBuffer: 1 << 30 })
    : spawnSync("npx", ["remotion", "ffmpeg", ...full], {
        maxBuffer: 1 << 30,
        shell: process.platform === "win32",
      });
  if (res.status !== 0) {
    throw new Error(`bundled ffmpeg failed (${args.join(" ")}):\n${res.stderr?.toString() ?? ""}`);
  }
  return res;
}

/** Run the system ffmpeg/ffprobe on PATH. Throws a helpful error if it is missing. */
export function runSystem(tool, args, { allowFail = false } = {}) {
  const res = spawnSync(tool, args, { maxBuffer: 1 << 30, encoding: "utf8" });
  if (res.error && res.error.code === "ENOENT") {
    throw new Error(
      `'${tool}' was not found on PATH. Metering and mastering need a full ffmpeg build ` +
        `(ebur128 + alimiter), e.g. \`winget install Gyan.FFmpeg\` / \`brew install ffmpeg\`.`,
    );
  }
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${tool} failed (${args.join(" ")}):\n${res.stderr ?? ""}`);
  }
  return res;
}

/**
 * Decode any audio file to a 16-bit WAV with the bundled ffmpeg (its slim build
 * has no raw-PCM muxer and no float PCM encoder, so s16 WAV it is — ample for a
 * lossy source). Returns the path of the written file.
 */
export function decodeToWav(src, out, { sampleRate, channels, extraFilters = [] } = {}) {
  const args = ["-y", "-i", src];
  if (extraFilters.length) args.push("-af", extraFilters.join(","));
  if (channels) args.push("-ac", String(channels));
  if (sampleRate) args.push("-ar", String(sampleRate));
  args.push("-c:a", "pcm_s16le", out);
  runBundled(args);
  if (!fs.existsSync(out)) throw new Error(`decode of ${src} produced no file`);
  return out;
}
