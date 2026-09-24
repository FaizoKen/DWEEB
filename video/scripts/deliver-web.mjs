// Web delivery: the in-app intro's compressed cuts, posters and narration
// captions, made from the mastered renders in ONE reproducible step (the old
// cuts were hand-made with an ffmpeg command that only lived in commit prose,
// and their "light on phones" settings silently regressed between re-cuts).
//
//   npx remotion render src/index.ts DweebPromo out/dweeb-promo.mp4 --separate-audio-to=out/dweeb-promo.wav
//   npm run master -- out/dweeb-promo.mp4 --audio out/dweeb-promo.wav
//   (the same two steps for DweebPromoVertical → out/dweeb-promo-vertical.*)
//   npm run deliver:web            [--only=landscape|vertical|vtt] [--codec=av1|h264]
//
// writes ../public/media/ (the web app's public dir, outside the SW precache):
//   intro.av1.mp4           landscape 1920×1080, AV1 — served first (<source>)
//   intro.mp4               landscape 1920×1080, H.264 High — the fallback
//   intro-vertical.av1.mp4  portrait 1080×1920, AV1
//   intro-vertical.mp4      portrait 720×1280, H.264 High
//   intro-poster.jpg / intro-poster-vertical.jpg   the settled end card
//   intro.en.vtt            the narration as captions (both cuts share the clock)
//
// Why each choice:
// - The modal shows the landscape cut ≤ 960 CSS px wide, i.e. up to 1920 device
//   px on a 2× screen — a 720p source could never be sharp there, and most of
//   the measured quality gain comes from resolution. AV1 carries 1080p at about
//   the old 720p file's size; H.264 is the universal fallback.
// - `-tune animation` + aq-mode 3 suit flat UI with thin borders; screen-content
//   mode (scm) does the same for SVT-AV1.
// - Keyframes land ON the scene cuts (H.264) and every 2 s, so scrubbing the
//   native controls is cheap and a cut never smears across a GOP boundary.
// - The web cuts skip the master's black fade-in/out (Fades in DweebPromo.tsx):
//   a poster → black flash at autoplay and a modal resting on a black frame at
//   the end both read as broken. The cut starts on the lit hook and ends on the
//   settled end card, which is also the poster.
// - Audio is the master's −16 LUFS web mix (one AAC generation, libfdk_aac via
//   Remotion's bundled ffmpeg), trimmed with the picture and faded over 0.3 s.
// - Colour tags: BT.709 primaries/matrix like the masters, but the sRGB
//   transfer where the masters say BT.709 — UI captures are sRGB, and Safari
//   applies its BT.709 gamma only to content tagged with a BT.709 transfer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audioEditListMediaTime, lagSamples } from "./lib/av-sync.mjs";
import { runBundled, runSystem } from "./lib/ffmpeg.mjs";
import { FPS, VIDEO_ROOT, readManifest, readSceneConstants } from "./lib/film-timing.mjs";

const SR = 48000;

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT = path.resolve(flag("out", path.join(VIDEO_ROOT, "..", "public", "media")));
const IN = path.resolve(flag("in", path.join(VIDEO_ROOT, "out")));
const ONLY = flag("only"); // "landscape" | "vertical" | "vtt"
const CODEC = flag("codec"); // "av1" | "h264" — re-encode one codec, keep the other's file
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dweeb-deliver-"));
fs.mkdirSync(OUT, { recursive: true });

const manifest = readManifest();
const TOTAL = manifest.totalFrames;

// The master's picture fades (DweebPromo.tsx `Fades`): read, not copied, so a
// retimed fade can't leave the web cut starting or ending on a dark frame.
function readFades() {
  const src = fs.readFileSync(path.join(VIDEO_ROOT, "src", "DweebPromo.tsx"), "utf8");
  const m = /interpolate\(frame,\s*\[0,\s*(\d+),\s*total\s*-\s*(\d+),\s*total\]/.exec(src);
  if (!m) throw new Error("Could not read the Fades keyframes from src/DweebPromo.tsx");
  return { fadeIn: Number(m[1]), fadeOut: Number(m[2]) };
}
const { fadeIn, fadeOut } = readFades();
const HEAD = fadeIn; // first fully lit frame
const TAIL = TOTAL - fadeOut; // first frame of the fade to black (exclusive end)

// Visible scene cuts (timeline.ts SCENES[id].from), as web-cut frame numbers.
const { LEAD } = readSceneConstants();
const cutFrames = manifest.timeline
  .slice(1)
  .map((l) => l.startFrame - LEAD - HEAD)
  .filter((f) => f > 0 && f < TAIL - HEAD);

const COLOR = ["-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-colorspace", "bt709", "-color_range", "tv"];

function mb(file) {
  return (fs.statSync(file).size / 1e6).toFixed(2) + " MB";
}

function need(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing — ${hint}`);
  return file;
}

/**
 * The trimmed −16 LUFS web mix: `ref` is the exact PCM the encoder is fed (the
 * sync check's reference), `aac` that PCM as AAC-LC 128k (libfdk_aac) in an
 * audio-only MP4 — the bundled ffmpeg has no .m4a (ipod) muxer, and the MP4's
 * edit list is what carries the encoder priming through the later stream copy.
 */
function encodeAudio(name) {
  const wav = need(path.join(IN, `${name}.web.wav`), `run \`npm run master -- out/${name}.mp4 --audio out/${name}.wav\``);
  const ref = path.join(tmp, `${name}.ref.wav`);
  const aac = path.join(tmp, `${name}.aac.mp4`);
  const dur = (TAIL - HEAD) / FPS;
  runSystem("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", wav,
    "-af", `atrim=start=${(HEAD / FPS).toFixed(6)}:end=${(TAIL / FPS).toFixed(6)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=0.02,afade=t=out:st=${(dur - 0.3).toFixed(3)}:d=0.3`,
    "-ac", "2", "-ar", String(SR), "-c:a", "pcm_f32le",
    ref,
  ]);
  runBundled(["-y", "-i", ref, "-c:a", "libfdk_aac", "-b:a", "128k", aac]);
  return { ref, aac };
}

/** One video encode of the trimmed master picture (system ffmpeg: libx264 / libsvtav1). */
function encodeVideo(name, { codec, width, height, crf, level, refs }) {
  const src = need(path.join(IN, `${name}.mp4`), `render it first (npm run render / render:vertical)`);
  const out = path.join(tmp, `${name}.${codec}.mp4`);
  const vf = [`trim=start_frame=${HEAD}:end_frame=${TAIL}`, "setpts=PTS-STARTPTS"];
  if (width) vf.push(`scale=${width}:${height}:flags=lanczos`);
  const common = ["-y", "-i", src, "-an", "-vf", vf.join(","), "-pix_fmt", "yuv420p", ...COLOR, "-g", "60"];
  const codecArgs =
    codec === "h264"
      ? [
          "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-crf", String(crf),
          "-tune", "animation", "-x264-params", "aq-mode=3",
          // The level WelcomeVideo.tsx declares in its `codecs` string, and the
          // reference count that level's frame buffer holds at this size:
          // `slow` + `-tune animation` asks for 10, which silently lifted the
          // 1080p cut to level 5.0 (set after the tune, so it wins).
          "-level:v", level, "-refs", String(refs),
          // A bare expression (no filtergraph around it), so its commas stay unescaped.
          "-force_key_frames", `expr:${cutFrames.map((f) => `eq(n,${f})`).join("+")}`,
        ]
      : ["-c:v", "libsvtav1", "-preset", "5", "-crf", String(crf), "-svtav1-params", "scm=1:tune=0"];
  runSystem("ffmpeg", ["-hide_banner", "-loglevel", "error", ...common, ...codecArgs, out]);
  return out;
}

/** Mux picture + audio with the moov atom up front (instant start in the modal). */
function mux(video, audio, out) {
  runSystem("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", video, "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
    "-movflags", "+faststart",
    out,
  ]);
}

/** The settled end card (the last web-cut frame) as a JPEG poster. */
function poster(name, out, { width, height }) {
  const src = path.join(IN, `${name}.mp4`);
  const vf = [`select=eq(n\\,${TAIL - 1})`];
  if (width) vf.push(`scale=${width}:${height}:flags=lanczos`);
  runSystem("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", src, "-vf", vf.join(","), "-fps_mode", "passthrough", "-frames:v", "1", "-q:v", "3",
    out,
  ]);
}

function report(file, lag) {
  const r = runSystem("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);
  const s = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const I = /I:\s+(-?[\d.]+) LUFS/.exec(s)?.[1];
  const TP = /True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(s)?.[1];
  const p = runSystem("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,profile,level,width,height", "-of", "compact", file]);
  console.log(`  ${path.basename(file).padEnd(24)} ${mb(file).padStart(8)}  ${p.stdout.trim().replace(/\n/g, " | ")}  I ${I} LUFS  TP ${TP} dBTP  A/V lag ${lag} samples`);
}

function deliverCut(name, outBase, variants, posterSize) {
  const audio = encodeAudio(name);
  for (const v of variants.filter((v) => !CODEC || v.codec === CODEC)) {
    const video = encodeVideo(name, v);
    const out = path.join(OUT, `${outBase}${v.codec === "h264" ? "" : ".av1"}.mp4`);
    mux(video, audio.aac, out);
    // The delivered file must decode sample-aligned with the PCM it came from
    // (the SFX clicks land on on-screen presses): a lost edit list = 43 ms late.
    const { lag } = lagSamples(audio.ref, out, { sampleRate: SR, tmpDir: tmp });
    if (Math.abs(lag) > 48) throw new Error(`${path.basename(out)}: audio is ${lag} samples off the picture (edit list media time ${audioEditListMediaTime(out)})`);
    report(out, lag);
  }
  poster(name, path.join(OUT, `${outBase === "intro" ? "intro-poster" : "intro-poster-vertical"}.jpg`), posterSize);
}

/* ── Narration captions (WebVTT) ────────────────────────────────────────── */

/**
 * The script's own tokens (with punctuation) aligned to the TTS word timings,
 * so a cue reads exactly like the line was written. Tokens the voice doesn't
 * speak on their own (an em dash) ride with the word before them.
 */
function alignTokens(line) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const tokens = line.text.split(/\s+/).filter(Boolean);
  const words = line.words;
  const out = [];
  let w = 0;
  for (const token of tokens) {
    const n = norm(token);
    if (!n) {
      if (out.length) out[out.length - 1].text += ` ${token}`;
      continue;
    }
    // A token may cover several reported words ("ready-made" → ready, made).
    let acc = "";
    const first = w;
    while (w < words.length && acc.length < n.length) acc += words[w++].norm;
    if (acc !== n) throw new Error(`VTT alignment failed on "${token}" in "${line.id}" (got "${acc}")`);
    out.push({ text: token, start: words[first].start, end: words[w - 1].end });
  }
  return out;
}

const MAX_LINE = 44;
const joined = (toks) => toks.map((t) => t.text).join(" ");

/**
 * Split one sentence into cues of at most two ~42-char lines, choosing the
 * most balanced break and preferring one after a comma / colon / dash — so a
 * long sentence reads as two natural phrases, never a phrase plus an orphan.
 */
function splitSentence(toks) {
  if (joined(toks).length <= MAX_LINE * 2) return [toks];
  let best = null;
  for (let i = 1; i < toks.length; i++) {
    const a = toks.slice(0, i);
    const b = toks.slice(i);
    const la = joined(a).length;
    const lb = joined(b).length;
    const score = Math.max(la, lb) - (/[,:;—]$/.test(a[a.length - 1].text) ? 12 : 0);
    if (!best || score < best.score) best = { score, a, b };
  }
  return [...splitSentence(best.a), ...splitSentence(best.b)];
}

/**
 * Editorial phrase breaks (a cue ends after these tokens) for the lines whose
 * natural phrasing the balancing heuristic can't know. Keyed by line id; a
 * token that no longer exists in a re-written line is simply ignored.
 */
const CUE_BREAKS = {
  reveal: ["builder"], // "Meet DWEEB: the visual Discord message builder / for webhooks, embeds, and Components V2."
  build: ["components", "live,"], // "Shape it with real Discord components / while … updates live, / and every limit …"
};

/** Split a line into cues: one per sentence / editorial phrase, long ones into balanced halves. */
function cuesFor(line) {
  const toks = alignTokens(line);
  const breaks = new Set(CUE_BREAKS[line.id] ?? []);
  const sentences = [];
  let cur = [];
  for (const t of toks) {
    cur.push(t);
    if (/[.?!]$/.test(t.text) || breaks.has(t.text)) {
      sentences.push(cur);
      cur = [];
    }
  }
  if (cur.length) sentences.push(cur);
  const cues = sentences.flatMap(splitSentence);
  const lineStart = line.startFrame / FPS;
  return cues.map((c) => ({
    start: lineStart + c[0].start - HEAD / FPS,
    end: lineStart + c[c.length - 1].end - HEAD / FPS,
    text: wrap(c.map((x) => x.text).join(" ")),
  }));
}

/** Words that must not end a caption line (they lead into what follows). */
const WEAK_END = new Set(["a", "an", "the", "to", "of", "your", "for", "with", "and", "or", "in", "into", "on", "at", "by", "then"]);
/** Words that open a phrase, so a line may well start with them. */
const PHRASE_START = new Set(["to", "and", "then", "for", "with", "while", "inside", "into", "the", "in", "or", "but"]);
/** Objects that belong with the verb before them ("add | it" reads broken). */
const BOUND_START = new Set(["it", "them"]);

/**
 * Break a cue into at most two lines: as balanced as possible, but at a phrase
 * boundary — after punctuation or before a phrase-opening word, never after an
 * article / preposition or between a verb and its object. ("Meet DWEEB: / the
 * visual Discord message builder", not "…the visual / Discord message builder".)
 */
function wrap(text) {
  if (text.length <= MAX_LINE) return text;
  const words = text.split(" ");
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i);
    const b = words.slice(i);
    const la = a.join(" ").length;
    const lb = b.join(" ").length;
    const last = a[a.length - 1].toLowerCase();
    const first = b[0].toLowerCase();
    let score = Math.max(la, lb) + (Math.max(la, lb) > MAX_LINE ? 1000 : 0);
    if (/[,:;—]$/.test(last)) score -= 12;
    if (WEAK_END.has(last)) score += 12;
    if (PHRASE_START.has(first)) score -= 6;
    if (BOUND_START.has(first)) score += 12;
    if (!best || score < best.score) best = { score, text: `${a.join(" ")}\n${b.join(" ")}` };
  }
  return best.text;
}

const stamp = (sec) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(r, 3)}`;
};

function writeVtt() {
  const cues = manifest.timeline.flatMap(cuesFor);
  // Hold each cue a beat past its last word, but never into the next cue.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.start ?? (TAIL - HEAD) / FPS;
    cues[i].end = Math.min(cues[i].end + 0.35, next - 0.04);
  }
  // Top of the picture: the burned-in editorial captions own the lower third
  // (landscape) and the band under the player's corner controls (vertical).
  const settings = "line:12% position:50% align:center size:92%";
  const body = cues
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)} ${settings}\n${c.text}`)
    .join("\n\n");
  const file = path.join(OUT, "intro.en.vtt");
  fs.writeFileSync(file, `WEBVTT\n\n${body}\n`);
  console.log(`  intro.en.vtt: ${cues.length} cues`);
}

console.log(`Web cut: film frames ${HEAD}–${TAIL - 1} (${((TAIL - HEAD) / FPS).toFixed(2)} s), keyframes on cuts at ${cutFrames.join(", ")}`);
try {
  if (!ONLY || ONLY === "vtt") writeVtt();
  if (!ONLY || ONLY === "landscape") {
    deliverCut(
      "dweeb-promo",
      "intro",
      [
        { codec: "av1", crf: Number(flag("av1-crf", 40)) },
        // High@4.0 (avc1.640028): 32,768 DPB macroblocks / 8,160 per 1080p frame = 4 refs.
        { codec: "h264", crf: Number(flag("h264-crf", 25)), level: "4.0", refs: 4 },
      ],
      {},
    );
  }
  if (!ONLY || ONLY === "vertical") {
    deliverCut(
      "dweeb-promo-vertical",
      "intro-vertical",
      [
        { codec: "av1", crf: Number(flag("av1-crf", 40)) },
        // High@3.1 (avc1.64001f): 18,000 DPB macroblocks / 3,600 per 720×1280 frame = 5 refs.
        { codec: "h264", crf: Number(flag("h264-crf-vertical", 25)), width: 720, height: 1280, level: "3.1", refs: 5 },
      ],
      {},
    );
  }
} finally {
  // Intermediate encodes are hundreds of MB; never leave them behind, even on failure.
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`Delivered to ${OUT}`);
