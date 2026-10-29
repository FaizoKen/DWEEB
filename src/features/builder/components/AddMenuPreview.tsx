/**
 * Miniature "what you'll get" sketches for the add-component library.
 *
 * Hand-drawn CSS mockups on a Discord-dark canvas, deliberately not the real
 * preview renderer: they need no message state, render at thumbnail size
 * without scaling artifacts, and stay stable as the renderer evolves. One
 * sketch per pickable entry — variants that add different things (Section
 * with a thumbnail vs. with a button) get their own sketch.
 *
 * Loaded on demand by the add menu (`addPreviewKind` holds the row → sketch
 * mapping the menu needs before then).
 */

import type { CSSProperties, ReactNode } from "react";
import type { AddPreviewKind } from "./addPreviewKind";
import { cn } from "@/lib/cn";
import styles from "./AddMenuPreview.module.css";

export function AddMenuPreview({ kind }: { kind: AddPreviewKind }) {
  return <div className={styles.canvas}>{SKETCHES[kind]}</div>;
}

/* ── Skeleton primitives ─────────────────────────────────────────────── */

const Line = ({ w, bright = false }: { w: string; bright?: boolean }) => (
  <span className={cn(styles.line, bright && styles.lineBright)} style={{ width: w }} />
);

const Btn = ({
  tone = "primary",
  w = 24,
  lg = false,
}: {
  tone?: "primary" | "secondary" | "success";
  w?: number;
  lg?: boolean;
}) => (
  <span className={cn(styles.btn, styles[tone], lg && styles.btnLg)}>
    <span className={styles.btnLabel} style={{ width: w }} />
  </span>
);

const SectionSketch = ({ accessory }: { accessory: ReactNode }) => (
  <div className={styles.sectionRow}>
    <div className={styles.sectionText}>
      <Line w="46%" bright />
      <Line w="92%" />
      <Line w="68%" />
    </div>
    {accessory}
  </div>
);

const SelectSketch = ({ children }: { children: ReactNode }) => (
  <div className={styles.selectMock}>
    <div className={styles.selectBox}>
      <Line w="46%" />
      <span className={styles.selectChevron} />
    </div>
    <div className={styles.optionList}>{children}</div>
  </div>
);

const Option = ({ marker, w }: { marker: ReactNode; w: string }) => (
  <div className={styles.option}>
    {marker}
    <Line w={w} />
  </div>
);

const dot = (cls: string | undefined, style?: CSSProperties) => (
  <span className={cls} style={style} />
);

/* ── One sketch per pickable entry ───────────────────────────────────── */

const SKETCHES: Record<AddPreviewKind, ReactNode> = {
  container: (
    <div className={styles.containerBox}>
      <Line w="42%" bright />
      <Line w="88%" />
      <Line w="60%" />
      <div className={styles.btnRow}>
        <Btn />
        <Btn tone="secondary" />
      </div>
    </div>
  ),
  section: <SectionSketch accessory={<span className={styles.slot}>+</span>} />,
  "section-thumbnail": (
    <SectionSketch accessory={<span className={cn(styles.img, styles.thumb)} />} />
  ),
  "section-button": <SectionSketch accessory={<Btn tone="secondary" />} />,
  text: (
    <div className={styles.stack}>
      <Line w="38%" bright />
      <Line w="94%" />
      <Line w="84%" />
      <Line w="56%" />
    </div>
  ),
  gallery: (
    <div className={styles.galleryGrid}>
      <span className={styles.img} />
      <span className={styles.img} />
      <span className={styles.img} />
      <span className={styles.img} />
    </div>
  ),
  separator: (
    <div className={styles.stack}>
      <Line w="78%" />
      <span className={styles.divider} />
      <Line w="64%" />
    </div>
  ),
  file: (
    <div className={styles.fileBox}>
      <span className={styles.fileGlyph} />
      <div className={styles.fileMeta}>
        <span className={styles.fileName} />
        <Line w="32%" />
      </div>
    </div>
  ),
  // The "Buttons & menus" group: a row takes buttons *or* one dropdown, never
  // both, so the sketch offers the two as alternatives rather than one row.
  row: (
    <div className={styles.rowChoice}>
      <div className={styles.btnRow}>
        <Btn />
        <Btn tone="secondary" />
        <Btn tone="success" />
      </div>
      <span className={styles.orRule}>or</span>
      <div className={styles.selectBox}>
        <Line w="46%" />
        <span className={styles.selectChevron} />
      </div>
    </div>
  ),
  button: <Btn lg w={40} />,
  "select-string": (
    <SelectSketch>
      <Option marker={dot(styles.emojiChip)} w="58%" />
      <Option marker={dot(styles.emojiChip, { filter: "hue-rotate(140deg)" })} w="42%" />
    </SelectSketch>
  ),
  "select-user": (
    <SelectSketch>
      <Option marker={dot(styles.avatar, { background: "#5865f2" })} w="52%" />
      <Option marker={dot(styles.avatar, { background: "#eb459e" })} w="40%" />
    </SelectSketch>
  ),
  "select-role": (
    <SelectSketch>
      <Option marker={dot(styles.roleDot, { background: "#3ba55c" })} w="48%" />
      <Option marker={dot(styles.roleDot, { background: "#faa61a" })} w="38%" />
    </SelectSketch>
  ),
  "select-mentionable": (
    <SelectSketch>
      <Option marker={dot(styles.avatar, { background: "#5865f2" })} w="52%" />
      <Option marker={dot(styles.roleDot, { background: "#faa61a" })} w="38%" />
    </SelectSketch>
  ),
  "select-channel": (
    <SelectSketch>
      <Option marker={<span className={styles.hash}>#</span>} w="54%" />
      <Option marker={<span className={styles.hash}>#</span>} w="42%" />
    </SelectSketch>
  ),
};
