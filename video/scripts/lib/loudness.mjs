// ITU-R BS.1770-4 / EBU R128 loudness in plain JS, so levels can be measured
// on any machine without a full ffmpeg build. Checked against ffmpeg 8.1's
// ebur128 on the score, a v5 master and an SFX file: integrated and max
// momentary agree within 0.03 LU.
//
// K-weighting is the standard two-stage filter (high shelf + RLB high-pass),
// designed per sample rate exactly as libebur128 and ffmpeg's ebur128 filter do
// (tan-prewarped bilinear design, un-normalized RLB numerator), so this meter
// and the one `npm run master` reports agree to within a few hundredths of a LU.

function biquad(b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function kWeighting(sampleRate) {
  // Stage 1: high shelf (+4 dB above ~1.7 kHz) — the head's acoustic effect.
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const shelf = biquad(Vh + (Vb * K) / Q + K * K, 2 * (K * K - Vh), Vh - (Vb * K) / Q + K * K, 1 + K / Q + K * K, 2 * (K * K - 1), 1 - K / Q + K * K);
  // Stage 2: RLB high-pass (~38 Hz); numerator {1, -2, 1} deliberately NOT normalized.
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

function filterInPlace(x, { b0, b1, b2, a1, a2 }) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** Per-sample K-weighted power, summed over channels (L/R weight 1). */
export function kWeightedPower(channels, sampleRate) {
  const n = channels[0].length;
  const power = new Float64Array(n);
  for (const ch of channels) {
    const y = Float64Array.from(ch);
    for (const f of kWeighting(sampleRate)) filterInPlace(y, f);
    for (let i = 0; i < n; i++) power[i] += y[i] * y[i];
  }
  return power;
}

const toLufs = (meanPower) => (meanPower > 0 ? -0.691 + 10 * Math.log10(meanPower) : -Infinity);

/**
 * Momentary loudness (400 ms windows) every `hopSec`. Each entry's `t` is the
 * END of its window, matching ffmpeg ebur128's framelog. Returns [{t, M}].
 */
export function momentary(channels, sampleRate, { hopSec = 0.1, windowSec = 0.4, power = null } = {}) {
  const p = power ?? kWeightedPower(channels, sampleRate);
  const win = Math.round(windowSec * sampleRate);
  const hop = Math.round(hopSec * sampleRate);
  const prefix = new Float64Array(p.length + 1);
  for (let i = 0; i < p.length; i++) prefix[i + 1] = prefix[i] + p[i];
  const out = [];
  for (let end = hop; end <= p.length; end += hop) {
    const start = Math.max(0, end - win);
    // Leading partial windows are averaged over the full window length, as a meter does.
    out.push({ t: end / sampleRate, M: toLufs((prefix[end] - prefix[start]) / win) });
  }
  return out;
}

/** Integrated loudness (gated: -70 LUFS absolute, -10 LU relative) per BS.1770-4. */
export function integrated(channels, sampleRate, { power = null } = {}) {
  const p = power ?? kWeightedPower(channels, sampleRate);
  const win = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const blocks = [];
  for (let start = 0; start + win <= p.length; start += hop) {
    let s = 0;
    for (let i = start; i < start + win; i++) s += p[i];
    blocks.push(s / win);
  }
  const abs = blocks.filter((z) => toLufs(z) > -70);
  if (!abs.length) return -Infinity;
  const relGate = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((z) => toLufs(z) > relGate);
  return toLufs(rel.reduce((a, b) => a + b, 0) / rel.length);
}

/** Power mean of loudness values (the right way to average LUFS readings). */
export const powerMeanLufs = (values) => {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return -Infinity;
  return 10 * Math.log10(finite.reduce((s, v) => s + Math.pow(10, v / 10), 0) / finite.length);
};
