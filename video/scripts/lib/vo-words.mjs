// Word timings for the voice-over, from msedge-tts's WordBoundary metadata.
//
// The service reports each word's Offset/Duration in 100-ns ticks on the
// synthesizer's own PCM timeline. The mp3 we keep has no gapless (Xing/LAME)
// header, so every decoder — Remotion's ffmpeg at render time, the browser in
// the Studio — plays the MP3 codec delay first: 576 samples of encoder delay +
// 529 of decoder delay = 1105 samples at 24 kHz ≈ 46 ms. Adding it here makes a
// word's `start` the moment it is HEARD in the file (generate-audio.mjs measures
// the offset on every take and fails if the audio disagrees).

/** Samples of MP3 encoder + decoder delay at the start of every decoded take. */
export const CODEC_DELAY_SAMPLES = 576 + 529;
export const TTS_SAMPLE_RATE = 24000;
export const CODEC_DELAY_SEC = CODEC_DELAY_SAMPLES / TTS_SAMPLE_RATE;

const TICKS_PER_SEC = 1e7;

/**
 * The matching key for a word or phrase: lower-case letters and digits only,
 * so "DWEEB:", "Here's" and "ready-made" match "dweeb", "heres", "readymade".
 * timeline.ts implements the same rule for at() — keep them identical.
 */
export const normWord = (text) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** WordBoundary entries (in speaking order) from the raw metadata JSON. */
export function boundaryEntries(metadata) {
  const list = Array.isArray(metadata?.Metadata) ? metadata.Metadata : [];
  return list
    .filter((m) => m?.Type === "WordBoundary" && m.Data?.text?.Text != null)
    .filter((m) => (m.Data.text.BoundaryType ?? "WordBoundary") === "WordBoundary")
    .sort((a, b) => a.Data.Offset - b.Data.Offset);
}

/** `[{ text, norm, start, end }]` in seconds from the start of the decoded mp3. */
export function wordsFromMetadata(metadata, delaySec = CODEC_DELAY_SEC) {
  const round = (s) => Number(s.toFixed(3));
  return boundaryEntries(metadata).map((m) => ({
    text: m.Data.text.Text,
    norm: normWord(m.Data.text.Text),
    start: round(m.Data.Offset / TICKS_PER_SEC + delaySec),
    end: round((m.Data.Offset + m.Data.Duration) / TICKS_PER_SEC + delaySec),
  }));
}

/**
 * Every letter and digit of the script must be covered by a word boundary, in
 * order — a take whose metadata dropped or merged a word would otherwise leave
 * an at() anchor pointing at the wrong moment.
 */
export function coverage(text, words) {
  const expected = normWord(text);
  const got = words.map((w) => w.norm).join("");
  if (expected === got) return { ok: true };
  let i = 0;
  while (i < expected.length && expected[i] === got[i]) i++;
  return {
    ok: false,
    detail: `words diverge from the script at "…${expected.slice(Math.max(0, i - 12), i + 12)}…" (got "…${got.slice(Math.max(0, i - 12), i + 12)}…")`,
  };
}

/**
 * Inter-word gaps, each tagged with the punctuation (if any) that follows the
 * word in the script. Mid-clause gaps are where a TTS glitch shows up as an odd
 * pause; after a comma or full stop a pause is prosody, not a fault.
 */
export function gapReport(text, words) {
  const rows = [];
  let cursor = 0;
  const lower = text.normalize("NFKD").toLowerCase();
  for (let k = 0; k < words.length; k++) {
    // Walk the script to the end of this word, then read the punctuation after it.
    let need = words[k].norm;
    while (need.length && cursor < lower.length) {
      const ch = lower[cursor].replace(/[^\p{L}\p{N}]/gu, "");
      if (ch && ch === need[0]) need = need.slice(1);
      cursor++;
    }
    let after = "";
    for (let c = cursor; c < lower.length && !/[\p{L}\p{N}]/u.test(lower[c]); c++) after += lower[c];
    const punct = after.replace(/\s+/g, "");
    const next = words[k + 1];
    rows.push({
      word: words[k].text,
      start: words[k].start,
      end: words[k].end,
      gapAfter: next ? Number((next.start - words[k].end).toFixed(3)) : null,
      punct,
    });
  }
  return rows;
}

/** Suspicious things in a take: long mid-clause pauses, implausibly long words. */
export function takeIssues(text, words) {
  const issues = [];
  for (const r of gapReport(text, words)) {
    const clauseEnd = /[.,:;?!—–]/.test(r.punct);
    if (r.gapAfter != null && !clauseEnd && r.gapAfter > 0.25) {
      issues.push(`${r.gapAfter.toFixed(2)} s pause mid-clause after "${r.word}"`);
    }
    if (r.gapAfter != null && clauseEnd && r.gapAfter > 1.0) {
      issues.push(`${r.gapAfter.toFixed(2)} s pause after "${r.word}${r.punct}"`);
    }
    if (r.end - r.start > 1.1) issues.push(`"${r.word}" lasts ${(r.end - r.start).toFixed(2)} s`);
  }
  return issues;
}
