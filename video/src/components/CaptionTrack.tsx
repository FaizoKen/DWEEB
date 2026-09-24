import React from "react";
import { AbsoluteFill, continueRender, delayRender, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONTS_READY } from "../fonts";
import { useVertical } from "./Camera";
import {
  CAPTION_EXIT_FRAMES,
  CaptionAspect,
  CaptionCue,
  CaptionPlate,
  JoinedPlate,
  PlateMeasurer,
  captionJoins,
  partAt,
  partText,
  showsOn,
  type PlateSize,
} from "./Caption";

/**
 * The film's one caption track. DweebPromo renders it once, above every scene
 * and outside every SceneTransition (below the black fades), so a caption can
 * hold across a cut without being faded, scaled or double-exposed with it.
 * Cues come from each scene's exported `captions` array (see src/captions.ts)
 * and use ABSOLUTE film frames.
 *
 * Touching cues share one plate (captionJoins): through the seam a JoinedPlate
 * morphs from one to the next, so the plate never blinks out and back. The
 * morph needs both plates' natural sizes, measured once per page from the real
 * layout; rendering is held (delayRender) until they are known.
 */
export const CaptionTrack: React.FC<{ cues: ReadonlyArray<CaptionCue> }> = ({ cues }) => {
  const frame = useCurrentFrame();
  const vertical = useVertical();
  const { fps } = useVideoConfig();
  const joins = React.useMemo(() => captionJoins(cues, vertical), [cues, vertical]);
  const joined = React.useMemo(() => [...new Set(joins.flatMap((j) => [j.a, j.b]))], [joins]);
  const [sizes, setSizes] = React.useState<Record<string, PlateSize> | null>(null);
  const [handle] = React.useState(() => (joined.length > 0 ? delayRender("Measuring the joined caption plates") : null));
  React.useEffect(() => {
    if (sizes && handle !== null) continueRender(handle);
  }, [sizes, handle]);

  // Joins in effect: both plates measured (until then — never on a rendered
  // frame — or if a size is missing, the cues fall back to lone plates).
  const live = sizes ? joins.filter((j) => sizes[j.a.id] && sizes[j.b.id]) : [];
  const seam = live.find((j) => frame >= j.start && frame < j.end);
  const inSeam = (cue: CaptionCue) => live.some((j) => (j.a === cue || j.b === cue) && frame >= j.start && frame < j.end);
  // A cue that took over a joined plate is already on screen: no spring in.
  const tookOver = (cue: CaptionCue) => live.some((j) => j.b === cue);
  const lone = cues.filter((c) => frame >= c.from && frame < c.to && showsOn(c, vertical) && !inSeam(c));

  const measuring = joined.length > 0 && !sizes;
  if (lone.length === 0 && !seam && !measuring) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", zIndex: 40 }}>
      {measuring && <PlateMeasurer cues={joined} vertical={vertical} fontsReady={FONTS_READY} onMeasured={setSizes} />}
      {lone.map((cue) => (
        <CaptionPlate key={cue.id} cue={cue} frame={frame} vertical={vertical} fps={fps} enter={!tookOver(cue)} />
      ))}
      {seam && sizes && <JoinedPlate join={seam} frame={frame} vertical={vertical} fps={fps} sizes={sizes} />}
    </AbsoluteFill>
  );
};

/* ── Legibility report ───────────────────────────────────────────────────── */

/** Reading time the spec asks for: 0.3 s per word + 0.5 s, fully legible. */
export const requiredLegibleFrames = (words: number, fps: number): number => Math.ceil((0.3 * words + 0.5) * fps);

/** Frames until a spring with `config` is (and stays) within 5% of rest. */
const settleFrames = (config: { damping: number; mass: number; stiffness: number }, fps: number) => {
  for (let f = 0; f < 120; f++) {
    let ok = true;
    for (let g = f; g < f + 20 && ok; g++) ok = Math.abs(1 - spring({ frame: g, fps, config })) <= 0.05;
    if (ok) return f;
  }
  return 120;
};

/** A seam where two touching cues share one plate (see captionJoins). */
export type CaptionReportJoin = { master: "landscape" | "vertical"; a: string; b: string; start: number; end: number };

export type CaptionReportRow = {
  id: string;
  label: string;
  text: string;
  aspect: CaptionAspect;
  from: number;
  to: number;
  words: number;
  /** First frame the whole caption (plate and every part) reads. */
  legibleFrom: number;
  /** Frame its exit fade begins. */
  legibleTo: number;
  legibleFrames: number;
  requiredFrames: number;
  ok: boolean;
};

/**
 * Timing audit for a caption list: per cue, how long it is FULLY legible
 * (plate settled, last part risen, before the exit fade) against the required
 * reading time, plus structural issues — overlaps within one master (joined
 * cues excepted), a part rising outside its cue, empty or reversed cues — and
 * the seams where touching cues share one plate.
 */
export function captionReport(
  cues: ReadonlyArray<CaptionCue>,
  fps: number,
): { rows: CaptionReportRow[]; issues: string[]; joins: CaptionReportJoin[] } {
  const plateSettle = settleFrames({ damping: 24, mass: 0.72, stiffness: 145 }, fps);
  const partSettle = settleFrames({ damping: 22, mass: 0.55, stiffness: 160 }, fps);
  const masters = ["landscape", "vertical"] as const;
  const joins = { landscape: captionJoins(cues, false), vertical: captionJoins(cues, true) };
  const issues: string[] = [];
  const rows = cues.map((cue) => {
    const text = cue.parts.map(partText).join(" ");
    const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    const lastPart = Math.max(...cue.parts.map((_, i) => partAt(cue, i)));
    // On a joined plate a cue reads once its text has crossfaded in, and until
    // its text starts crossfading out; on a lone plate from its spring-in to
    // its exit fade. The stricter of its masters counts.
    const on = masters.filter((m) => showsOn(cue, m === "vertical"));
    const arrives = on.map((m) => {
      const j = joins[m].find((x) => x.b === cue);
      return j ? Math.ceil(j.bIn[1]) : cue.from + plateSettle;
    });
    const leaves = on.map((m) => {
      const j = joins[m].find((x) => x.a === cue);
      return j ? Math.floor(j.aOut[0]) : cue.to - CAPTION_EXIT_FRAMES;
    });
    const legibleFrom = Math.max(...arrives, lastPart + partSettle);
    const legibleTo = Math.min(...leaves);
    const legibleFrames = Math.max(0, legibleTo - legibleFrom);
    const requiredFrames = requiredLegibleFrames(words, fps);
    if (cue.parts.length === 0) issues.push(`${cue.id}: no parts`);
    if (!(cue.to > cue.from)) issues.push(`${cue.id}: to (${cue.to}) must be after from (${cue.from})`);
    cue.parts.forEach((_, i) => {
      const at = partAt(cue, i);
      if (at < cue.from || at >= cue.to) issues.push(`${cue.id}: part ${i} rises at ${at}, outside [${cue.from}, ${cue.to})`);
    });
    if (legibleFrames < requiredFrames) {
      issues.push(`${cue.id}: fully legible ${legibleFrames} f, needs ${requiredFrames} f (${words} words)`);
    }
    return {
      id: cue.id,
      label: cue.label,
      text,
      aspect: cue.aspect ?? "both",
      from: cue.from,
      to: cue.to,
      words,
      legibleFrom,
      legibleTo,
      legibleFrames,
      requiredFrames,
      ok: legibleFrames >= requiredFrames,
    };
  });
  for (const master of masters) {
    const list = cues.filter((c) => showsOn(c, master === "vertical")).sort((a, b) => a.from - b.from);
    for (let i = 1; i < list.length; i++) {
      // Joined cues share one plate: their overlap is the crossfade, not a clash.
      const joined = joins[master].some((j) => j.a === list[i - 1] && j.b === list[i]);
      if (list[i].from < list[i - 1].to && !joined) {
        issues.push(`${master}: ${list[i - 1].id} (until ${list[i - 1].to}) overlaps ${list[i].id} (from ${list[i].from})`);
      }
    }
  }
  const seams = masters.flatMap((master) =>
    joins[master].map((j) => ({ master, a: j.a.id, b: j.b.id, start: j.start, end: j.end })),
  );
  return { rows, issues, joins: seams };
}
