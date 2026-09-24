import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import { COMPONENT_META, type ComponentKind } from "../../story/rules";
import type { CastMember, TreeAdderModel, TreeRowModel } from "../../story/campaign";
import { ComponentGlyph, familyTint } from "./glyphs";
import { PIcon } from "./ProductIcon";
import { useUi } from "./scale";
import { UserAvatar } from "./people";

/**
 * The component tree, drawn the way src/features/builder/components/
 * ComponentTree.tsx + .module.css draw it: a chevron, a tinted 28px glyph tile,
 * the bold COMPONENT_META label and a muted summarize() line, per-type fill +
 * 3px left stripe, nested lists indented 22px with a hairline rail, dashed
 * "+ Add …" adders, an inline editor unfolding under the selected row, and
 * Activity presence (the editor's avatar at the right edge + a 1.5px outline in
 * their colour).
 *
 * Geometry comes from ONE function, `treeLayout()`, which the renderer uses
 * too — so the row positions a scene aims its cursor at are exactly where the
 * pixels are (k = the UiScale zoom).
 */

/* ── Metrics (the product's CSS at k = 1) ───────────────────────────────── */

export const TREE_METRICS = {
  rowH: 46, // 9px padding + 28px tile + 9px padding
  gap: 2, // li + li / nested ul margin-top
  indent: 22, // .list .list padding-left
  railX: 10, // ::before left
  adderH: 30,
  adderGapAfter: 2, // .adderItem margin-bottom (collapses into the next 2px gap)
  editorGapBefore: 8, // .editorPanel margin-top
  editorGapAfter: 14, // .editorPanel margin-bottom
} as const;

export type TreeEditorSlot = {
  /** Row the editor unfolds under (must be the selected row). */
  rowId: string;
  /** Full height of the editor content at k = 1. */
  height: number;
  /** 0..1 unfold progress (height and opacity). Default 1. */
  open?: number;
  node: React.ReactNode;
};

export type TreeLayoutItem =
  | { type: "row"; id: string; y: number; h: number; x: number; row: TreeRowModel; reveal: number }
  | { type: "adder"; id: string; y: number; h: number; x: number; adder: TreeAdderModel; reveal: number }
  | { type: "editor"; id: string; y: number; h: number; x: number; slot: TreeEditorSlot; open: number };

export type TreeLayout = {
  items: TreeLayoutItem[];
  rails: { x: number; y1: number; y2: number }[];
  height: number;
  /** Look up a row/adder/editor box: {x, y, w?, h} in tree-local px. */
  box: (id: string) => { x: number; y: number; h: number } | undefined;
};

/**
 * Lay out rows (depth-ordered, pre-order) + adders (+ one inline editor) the
 * way the browser lays out the product's nested lists, collapsed margins
 * included. `reveal` < 1 shrinks an item's slot so rows below glide instead of
 * jumping when a component is added.
 */
export function treeLayout(
  rows: TreeRowModel[],
  adders: TreeAdderModel[],
  opts: { k?: number; editor?: TreeEditorSlot | null; reveal?: Record<string, number> } = {},
): TreeLayout {
  const k = opts.k ?? 1;
  const M = TREE_METRICS;
  const rev = (id: string) => Math.max(0, Math.min(1, opts.reveal?.[id] ?? 1));

  // Interleave adders after the item they follow (adders sit at the end of
  // their parent's list, after the last child's own subtree).
  type Seq = { kind: "row"; row: TreeRowModel } | { kind: "adder"; adder: TreeAdderModel };
  const seq: Seq[] = [];
  const pending = [...adders];
  const flushAfter = (id: string, depth: number) => {
    for (let i = 0; i < pending.length; i++) {
      const a = pending[i];
      if (a.after === id && a.depth >= depth) {
        seq.push({ kind: "adder", adder: a });
        pending.splice(i, 1);
        i--;
      }
    }
  };
  rows.forEach((row, i) => {
    seq.push({ kind: "row", row });
    const next = rows[i + 1];
    // Close every list this row ends: emit adders registered after it, deepest first.
    const nextDepth = next ? next.depth : 0;
    for (let d = row.depth + 1; d > nextDepth; d--) {
      const sorted = pending.filter((a) => a.after === row.id && a.depth === d);
      for (const a of sorted) {
        seq.push({ kind: "adder", adder: a });
        pending.splice(pending.indexOf(a), 1);
      }
    }
    if (!next) flushAfter(row.id, 0);
  });

  const items: TreeLayoutItem[] = [];
  let y = 0;
  let first = true;
  for (const s of seq) {
    const id = s.kind === "row" ? s.row.id : s.adder.id;
    const depth = s.kind === "row" ? s.row.depth : s.adder.depth;
    const r = rev(id);
    const h = (s.kind === "row" ? M.rowH : M.adderH) * k;
    const gapBefore = first ? 0 : M.gap * k;
    y += gapBefore * r;
    if (s.kind === "row") items.push({ type: "row", id, y, h, x: depth * M.indent * k, row: s.row, reveal: r });
    else items.push({ type: "adder", id, y, h, x: depth * M.indent * k, adder: s.adder, reveal: r });
    y += h * r;
    // An adder's 2px margin-bottom collapses with the next item's 2px margin-top
    // (both are adjacent block margins), so it adds nothing of its own here.
    first = false;
    const ed = opts.editor;
    if (s.kind === "row" && ed && ed.rowId === id) {
      const open = Math.max(0, Math.min(1, ed.open ?? 1));
      // margin 8 above; 14 below, which collapses with the next li's 2px.
      const top = y + M.editorGapBefore * k * open;
      const eh = ed.height * k * open;
      items.push({ type: "editor", id: `editor:${id}`, y: top, h: eh, x: depth * M.indent * k, slot: ed, open });
      y = top + eh + (M.editorGapAfter - M.gap) * k * open;
    }
  }

  // Rails: one per parent whose children follow it, from the first child's top
  // (+2) to the last descendant/adder bottom (−6), at parentX + indent/2-ish.
  const rails: TreeLayout["rails"] = [];
  items.forEach((it, i) => {
    if (it.type !== "row") return;
    const depth = it.row.depth;
    let last: TreeLayoutItem | undefined;
    let firstChild: TreeLayoutItem | undefined;
    for (let j = i + 1; j < items.length; j++) {
      const o = items[j];
      const od = o.type === "row" ? o.row.depth : o.type === "adder" ? o.adder.depth : depth + 1;
      if (o.type === "editor") continue;
      if (od <= depth) break;
      if (!firstChild) firstChild = o;
      last = o;
    }
    if (firstChild && last) {
      rails.push({ x: it.x + M.railX * k, y1: firstChild.y + 2 * k, y2: last.y + last.h - 6 * k });
    }
  });

  return {
    items,
    rails,
    height: y,
    box: (id) => {
      const it = items.find((x) => x.id === id);
      return it ? { x: it.x, y: it.y, h: it.h } : undefined;
    },
  };
}

/* ── Row ────────────────────────────────────────────────────────────────── */

export type TreeRowViewProps = {
  kind: ComponentKind;
  label?: string;
  summary?: string;
  selected?: boolean;
  /** Collaborators editing this row: avatars at the right edge + outline. */
  presence?: CastMember[];
  /** 0..1 attention flash (just added / just changed). */
  highlight?: number;
  /** Hover state (a pointer resting on the row). */
  hover?: boolean;
  /** Validation dot on the glyph tile. */
  issue?: "warning" | "error";
  style?: React.CSSProperties;
};

/** One tree row, filling its container's width. */
export const TreeRowView: React.FC<TreeRowViewProps> = ({
  kind,
  label = COMPONENT_META[kind].label,
  summary = "",
  selected = false,
  presence,
  highlight = 0,
  hover = false,
  issue,
  style,
}) => {
  const { u } = useUi();
  const t = familyTint(kind);
  const outline = presence && presence.length > 0 ? presence[0].color : undefined;
  const flash = Math.max(0, Math.min(1, highlight));
  return (
    <div
      style={{
        position: "relative",
        height: u(TREE_METRICS.rowH),
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: u(9),
        padding: `0 ${u(10)}px`,
        borderRadius: u(6),
        background: selected ? t.rowFill(true) : hover ? t.rowHover : t.rowFill(false),
        boxShadow: [
          `inset ${u(3)}px 0 0 ${t.stripe(selected)}`,
          outline ? `inset 0 0 0 ${u(1.5)}px ${outline}` : "",
          flash > 0.01 ? `0 0 0 ${u(1.5)}px ${withAlpha(t.accent, 0.7 * flash)}, 0 0 ${u(18)}px ${withAlpha(t.accent, 0.45 * flash)}` : "",
        ]
          .filter(Boolean)
          .join(", "),
        fontFamily: INTER,
        color: COLORS.text,
        ...style,
      }}
    >
      <span style={{ width: u(18), display: "flex", justifyContent: "center", color: selected ? COLORS.text : COLORS.textSubtle }}>
        <PIcon name={selected ? "chevronDown" : "chevronRight"} size={u(14)} />
      </span>
      <span
        style={{
          position: "relative",
          width: u(28),
          height: u(28),
          flexShrink: 0,
          borderRadius: u(7),
          boxSizing: "border-box",
          background: issue === "error" ? "rgba(240,71,71,0.14)" : t.tileFill(selected),
          border: `${u(1)}px solid ${issue === "error" ? COLORS.danger : t.tileBorder(selected)}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ComponentGlyph kind={kind} size={u(15)} color={issue === "error" ? "#ff8a8c" : t.ink(selected)} />
        {issue && (
          <span
            style={{
              position: "absolute",
              top: -u(3),
              right: -u(3),
              width: u(8),
              height: u(8),
              borderRadius: "50%",
              background: issue === "error" ? COLORS.danger : COLORS.warning,
              boxShadow: `0 0 0 ${u(2)}px ${COLORS.bg}`,
            }}
          />
        )}
      </span>
      <span style={{ fontSize: u(14), fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>{label}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: u(13),
          color: selected ? withAlpha(COLORS.text, 0.85) : COLORS.textMuted,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {summary}
      </span>
      {presence && presence.length > 0 && !selected && (
        <span style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
          {presence.map((p, i) => (
            <span
              key={p.name}
              style={{
                marginLeft: i === 0 ? 0 : -u(6),
                borderRadius: "50%",
                boxShadow: `0 0 0 ${u(1.5)}px ${p.color}, 0 0 0 ${u(3)}px ${COLORS.bgElevated}`,
                display: "flex",
              }}
            >
              <UserAvatar person={p} size={u(18)} />
            </span>
          ))}
        </span>
      )}
    </div>
  );
};

/* ── Adder ──────────────────────────────────────────────────────────────── */

/** The dashed "+ Add …" pill (ComponentTree.module.css .addChild). */
export const TreeAdder: React.FC<{ label: string; hover?: boolean; pressed?: boolean; style?: React.CSSProperties }> = ({
  label,
  hover = false,
  pressed = false,
  style,
}) => {
  const { u } = useUi();
  const active = hover || pressed;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: u(7),
        height: u(TREE_METRICS.adderH),
        boxSizing: "border-box",
        padding: `0 ${u(13)}px 0 ${u(5)}px`,
        borderRadius: 999,
        border: `${u(1)}px dashed ${active ? COLORS.blurple : "rgba(88,101,242,0.45)"}`,
        background: active ? "rgba(88,101,242,0.18)" : "transparent",
        color: active ? COLORS.text : COLORS.textMuted,
        fontFamily: INTER,
        fontSize: u(13),
        fontWeight: 600,
        whiteSpace: "nowrap",
        transform: pressed ? "scale(0.97)" : undefined,
        ...style,
      }}
    >
      <span
        style={{
          width: u(16),
          height: u(16),
          boxSizing: "border-box",
          borderRadius: 999,
          background: active ? COLORS.bgInput : "rgba(88,101,242,0.1)",
          border: `${u(1)}px solid ${active ? COLORS.blurple : "rgba(88,101,242,0.45)"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width={u(8)} height={u(8)} viewBox="0 0 8 8" style={{ display: "block" }}>
          <rect x="0.5" y="3" width="7" height="2" rx="1" fill={COLORS.blurple} />
          <rect x="3" y="0.5" width="2" height="7" rx="1" fill={COLORS.blurple} />
        </svg>
      </span>
      {label}
    </div>
  );
};

/* ── Inline editor frame ────────────────────────────────────────────────── */

/**
 * The card an opened row unfolds (.editorPanel): bordered, elevated, with a
 * 3px left bar in the component's own tint so it reads as that row's editor.
 */
export const InlineEditorFrame: React.FC<{
  kind: ComponentKind;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ kind, children, style }) => {
  const { u } = useUi();
  return (
    <div
      style={{
        boxSizing: "border-box",
        height: "100%",
        border: `${u(1)}px solid ${COLORS.border}`,
        borderLeft: `${u(3)}px solid ${familyTint(kind).accent}`,
        borderRadius: u(10),
        background: COLORS.bgElevated,
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
        overflow: "hidden",
        padding: u(14),
        fontFamily: INTER,
        color: COLORS.text,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/* ── The list ───────────────────────────────────────────────────────────── */

export type TreeViewProps = {
  rows: TreeRowModel[];
  adders?: TreeAdderModel[];
  selected?: string | null;
  editor?: TreeEditorSlot | null;
  presence?: Record<string, CastMember[]>;
  /** 0..1 per row/adder id — entrance (slot grows, row fades/slides in). */
  reveal?: Record<string, number>;
  /** 0..1 per row id — attention flash. */
  highlight?: Record<string, number>;
  hover?: string | null;
  pressed?: string | null;
};

/** A width-flexible tree (height = its layout's height). */
export const TreeView: React.FC<TreeViewProps> = ({
  rows,
  adders = [],
  selected = null,
  editor = null,
  presence,
  reveal,
  highlight,
  hover = null,
  pressed = null,
}) => {
  const { k } = useUi();
  const layout = treeLayout(rows, adders, { k, editor, reveal });
  return (
    <div style={{ position: "relative", width: "100%", height: layout.height }}>
      {layout.rails.map((r, i) => (
        <div
          key={`rail-${i}`}
          style={{
            position: "absolute",
            left: r.x,
            top: r.y1,
            width: Math.max(1, k),
            height: Math.max(0, r.y2 - r.y1),
            background: COLORS.border,
            borderRadius: 1,
          }}
        />
      ))}
      {layout.items.map((it) => {
        if (it.type === "editor") {
          return (
            <div
              key={it.id}
              style={{
                position: "absolute",
                left: it.x,
                right: 0,
                top: it.y,
                height: it.h,
                overflow: "hidden",
                opacity: Math.min(1, it.open * 1.4),
              }}
            >
              <div style={{ height: it.slot.height * k }}>{it.slot.node}</div>
            </div>
          );
        }
        const r = it.reveal;
        if (r <= 0.001) return null;
        // A revealing item's slot is only h·r tall (rows below glide down), so
        // it is clipped to that slot — it unfolds instead of overlapping the
        // next row.
        const common: React.CSSProperties = {
          position: "absolute",
          left: it.x,
          top: it.y,
          height: r < 1 ? it.h * r : undefined,
          overflow: r < 1 ? "hidden" : undefined,
          opacity: Math.min(1, r * 1.25),
          transform: r < 1 ? `translateX(${(1 - r) * -14 * k}px)` : undefined,
        };
        if (it.type === "adder") {
          return (
            <div key={it.id} style={common}>
              <TreeAdder label={it.adder.label} hover={hover === it.id} pressed={pressed === it.id} />
            </div>
          );
        }
        return (
          <div key={it.id} style={{ ...common, right: 0 }}>
            <TreeRowView
              kind={it.row.kind}
              label={it.row.label}
              summary={it.row.summary}
              selected={selected === it.id}
              presence={presence?.[it.id]}
              highlight={highlight?.[it.id] ?? 0}
              hover={hover === it.id}
            />
          </div>
        );
      })}
    </div>
  );
};
