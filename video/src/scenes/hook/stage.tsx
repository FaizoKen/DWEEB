import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { mixColor, withAlpha } from "../../lib/color";
import { Icon } from "../../components/Icon";
import { CampaignPreview, CampaignTree } from "../../components/CampaignUI";
import { DMsg, DTextDisplay } from "../../components/DiscordUI";
import { EditorWindow, PortraitEditor, PreviewFabs, PORTRAIT_STAGE, PORTRAIT_UI, WINDOW_CHROME_H, treeLayout, useDiscord } from "../../components/editor";
import { AUTHOR, PREVIEW_TIME, campaignAdders, campaignRows, campaignState, campaignStats } from "../../story/campaign";
import { CUT_A, EDITOR_L, EDITOR_V, PORTRAIT_CAM } from "../contracts";

/**
 * The makeover stage the hook and the reveal SHARE. The hook's AFTER card is
 * the editor's own preview — the same EditorWindow / PortraitEditor the whole
 * editor act uses, simply not assembled yet — so the hook→reveal match cut
 * registers by construction: both scenes render these components with the
 * same props at the boundary, and the card never moves (qa:cuts gates it).
 *
 *   landscape — a "Message makeover" panel sits exactly where the editor's
 *     browser chrome + preview pane will be; the EditorWindow (assembly 0)
 *     lays its preview pane over the panel's body, so the message is already
 *     in its editor position. The reveal then drops the real chrome over the
 *     panel's title bar and slides the builder pane in beside it.
 *   portrait  — the PortraitEditor's surface is the panel; a title bar sits in
 *     the band the action bar will drop into, and the builder sheet (hidden)
 *     later slides up over the card's lower half, as on a phone.
 */

/**
 * The framing both scenes hold across the match cut (the hook settles on it;
 * the reveal starts on it and stays static through its 16-frame overlap).
 * Landscape: the whole card, clear of the AFTER super bottom-left, right of
 * centre so the reveal's pull to the whole-window wide is short and slow.
 * Portrait: the stage's locked camera.
 */
export const MATCH_L = { x: 1100, y: 494, s: 1.17 } as const;
export const MATCH_V = PORTRAIT_CAM;

/** The finished Season 4 message: the hook's promise and cut A's state. */
export const FINAL = campaignState(CUT_A.stage);
export const FINAL_STATS = campaignStats(FINAL);

/** Cut A's action bar: nothing picked yet, nothing to undo (contracts.ts). */
export const CUT_A_BAR = { channel: CUT_A.channel, canUndo: CUT_A.canUndo, canRedo: CUT_A.canRedo } as const;

/** The boring "before": real Discord plain text, three lines, no formatting. */
const PLAIN_LINES = [
  "Season 4 is live.",
  "New maps, ranked rewards, and a fresh battle pass.",
  "Jump in and claim your founder badge before the weekend.",
] as const;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/* ── The message: plain → rich under a light sweep ─────────────────────── */

/** The sweep's direction (a CSS gradient angle: left→right, leaning slightly). */
const SWEEP_ANGLE = 104;
/**
 * Width of the soft edge, as a fraction of the gradient line. Inside it the
 * plain text and the rich card overlap (their masks are complementary), so the
 * makeover never shows an empty frame.
 */
const FEATHER = 0.13;

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/**
 * The makeover's light at edge position `e` (a fraction of the gradient line):
 * blurple ahead, white at the edge, green behind. `strength` and `width`
 * scale it — the reveal's "Components V2" sheen is the same light, narrower.
 */
const lightBand = (e: number, strength = 1, width = 1) =>
  `linear-gradient(${SWEEP_ANGLE}deg, transparent ${pct(e - 0.2 * width)}, ` +
  `rgba(88,101,242,${(0.2 * strength).toFixed(3)}) ${pct(e - 0.085 * width)}, rgba(255,255,255,${(0.4 * strength).toFixed(3)}) ${pct(e)}, ` +
  `rgba(87,242,135,${(0.2 * strength).toFixed(3)}) ${pct(e + 0.07 * width)}, transparent ${pct(e + 0.17 * width)})`;

/** Strictly inside a pass: 0 and 1 both mean "no overlay". */
const passing = (t: number | undefined): t is number => t !== undefined && t > 0 && t < 1;

const PlainMessage: React.FC<{ wrap?: number }> = ({ wrap }) => (
  <DMsg author={AUTHOR} avatar="nebula" time={PREVIEW_TIME}>
    <div style={{ maxWidth: wrap }}>
      <DTextDisplay content={PLAIN_LINES.join("\n")} />
    </div>
  </DMsg>
);

/**
 * The preview slot through the hook and the reveal. `sweep` 0 = the plain
 * message, 1 = done: from then on — no lift, no sheen passing — it is exactly
 * the CampaignPreview every editor scene renders (no wrapper, no mask), which
 * is what the match cut and cut A need.
 */
export const MakeoverMessage: React.FC<{
  sweep: number;
  maxWidth?: number;
  /** Plain text column width (units) — the portrait opening frames it tighter. */
  plainWrap?: number;
  /**
   * Units the whole makeover box sits below its editor position (portrait:
   * the plain message opens centred in the panel and the makeover carries the
   * card up into place). Plain and rich layers move as one, so their masks
   * stay registered; at 0 nothing wraps the card, as the match cut needs.
   */
  lift?: number;
  /** The finished card's "Components V2" sheen, 0..1 (see StageSheen). */
  sheen?: number;
}> = ({ sweep, maxWidth, plainWrap, lift = 0, sheen }) => {
  const box =
    sweep >= 1 && passing(sheen) ? (
      <div style={{ position: "relative", width: "100%", maxWidth }}>
        <CampaignPreview state={FINAL} maxWidth={maxWidth} />
        <CardSheen t={sheen} />
      </div>
    ) : (
      <MakeoverBox sweep={sweep} maxWidth={maxWidth} plainWrap={plainWrap} />
    );
  return lift > 0.001 ? <div style={{ transform: `translateY(${lift.toFixed(2)}px)` }}>{box}</div> : box;
};

/**
 * The light crossing the card's Components V2 container — the container
 * only (DMsg sets it 40d avatar + 16d gap in, under the 22d author row + 3d
 * margin, and it runs to the message box's right and bottom edges), so the
 * preview's canvas around the card never lights up as a rectangle.
 */
const CardSheen: React.FC<{ t: number }> = ({ t }) => {
  const { d } = useDiscord();
  return (
    <div
      style={{
        position: "absolute",
        left: d(56),
        top: d(25),
        right: 0,
        bottom: 0,
        borderRadius: d(8),
        background: lightBand(-0.12 + 1.24 * t, 0.7, 0.55),
        mixBlendMode: "screen",
        opacity: Math.min(1, t / 0.15, (1 - t) / 0.15),
        pointerEvents: "none",
      }}
    />
  );
};

/**
 * The makeover itself: a light band crosses left→right, the rich card is
 * revealed behind it and the plain text dissolves ahead of it. Both layers
 * share one box (the plain message is laid over the rich card's box), so their
 * masks and the band use the same gradient geometry and stay registered. The
 * author row is identical in both layers, so it simply stays put while the
 * body transforms.
 */
const MakeoverBox: React.FC<{ sweep: number; maxWidth?: number; plainWrap?: number }> = ({ sweep, maxWidth, plainWrap }) => {
  const rich = <CampaignPreview state={FINAL} maxWidth={maxWidth} />;
  if (sweep >= 1) return rich;
  const started = sweep > 0;
  // The edge travels from just before the box to just past it.
  const e = -FEATHER / 2 + sweep * (1 + FEATHER);
  const lo = pct(e - FEATHER / 2);
  const hi = pct(e + FEATHER / 2);
  const richMask = `linear-gradient(${SWEEP_ANGLE}deg, #000 ${lo}, transparent ${hi})`;
  const plainMask = `linear-gradient(${SWEEP_ANGLE}deg, transparent ${lo}, #000 ${hi})`;
  // The light itself rides the edge, brightest at its centre; it fades in and
  // out at the ends of the pass so it never pops on or off.
  const band = lightBand(e);
  const bandOpacity = Math.min(1, sweep / 0.12, (1 - sweep) / 0.12);
  return (
    <div style={{ position: "relative", width: "100%", maxWidth }}>
      <div style={started ? { WebkitMaskImage: richMask, maskImage: richMask } : { visibility: "hidden" }}>{rich}</div>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          ...(started ? { WebkitMaskImage: plainMask, maskImage: plainMask } : {}),
        }}
      >
        <PlainMessage wrap={plainWrap} />
      </div>
      {started && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            background: band,
            mixBlendMode: "screen",
            opacity: bandOpacity,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
};

/* ── Title bar: "Message makeover" + the PLAIN → UPGRADED status ─────────── */

/**
 * The status chip beside the title. Fixed width (sized for UPGRADED) so the
 * title never shifts; the two words crossfade and the chip tints to green.
 */
const MakeoverPill: React.FC<{ upgraded: number; fs: number }> = ({ upgraded, fs }) => {
  const t = clamp01(upgraded);
  const word = (text: string, opacity: number, color: string) => (
    <span
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        textAlign: "center",
        opacity: opacity < 1 ? opacity : undefined,
        color,
      }}
    >
      {text}
    </span>
  );
  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        width: fs * 7.9,
        height: fs * 2.05,
        boxSizing: "border-box",
        borderRadius: 999,
        border: `${Math.max(1, fs / 13)}px solid ${mixColor("rgba(255,255,255,0.14)", "rgba(87,242,135,0.5)", t)}`,
        background: mixColor("rgba(255,255,255,0.045)", "rgba(87,242,135,0.12)", t),
        boxShadow: t > 0.01 ? `0 0 ${fs * 1.4}px ${withAlpha(COLORS.green, 0.22 * t)}` : undefined,
        fontFamily: INTER,
        fontSize: fs,
        fontWeight: 800,
        letterSpacing: "0.09em",
        lineHeight: 1,
      }}
    >
      {t < 1 && word("PLAIN", 1 - t, COLORS.textSubtle)}
      {t > 0 && word("UPGRADED", t, COLORS.green)}
    </span>
  );
};

/** Eye glyph + "Message makeover" + the status chip, centred on one line. */
const MakeoverTitle: React.FC<{ fs: number; upgraded: number; opacity: number }> = ({ fs, upgraded, opacity }) => {
  const t = clamp01(upgraded);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: fs * 0.62,
        opacity: opacity < 1 ? opacity : undefined,
        fontFamily: INTER,
      }}
    >
      <Icon name="eye" size={fs * 1.3} color={t >= 0.5 ? COLORS.green : COLORS.textSubtle} />
      <span style={{ fontSize: fs, fontWeight: 700, color: COLORS.text, letterSpacing: "-0.005em", whiteSpace: "nowrap" }}>
        Message makeover
      </span>
      <MakeoverPill upgraded={t} fs={fs * 0.74} />
    </div>
  );
};

/* ── Landscape ──────────────────────────────────────────────────────────── */

/**
 * The makeover panel occupies exactly the part of the editor window that is
 * already "the message": the browser-chrome band (its title bar) and the
 * preview pane (its Discord canvas). The AppWindow is a content-box with a
 * 1px border, so its outer box spans x 120…1802 and y 90…992 in the world;
 * the panel is that box from the builder pane's right edge (x 720) on.
 */
const PANEL_L = {
  x: EDITOR_L.x + EDITOR_L.leftWidth,
  y: EDITOR_L.y,
  w: EDITOR_L.width + 2 - EDITOR_L.leftWidth,
  h: EDITOR_L.height + 2,
} as const;

const MakeoverPanelL: React.FC<{ upgraded: number; title: number; opacity: number }> = ({ upgraded, title, opacity }) => {
  if (opacity <= 0.001) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: PANEL_L.x,
        top: PANEL_L.y,
        width: PANEL_L.w,
        height: PANEL_L.h,
        boxSizing: "border-box",
        // The window's corners — except bottom-left, where the preview pane
        // (square there: the builder pane will abut it) lies over the panel.
        borderRadius: "18px 18px 18px 0",
        border: `1px solid ${COLORS.borderStrong}`,
        boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
        background: COLORS.dBgPrimary,
        overflow: "hidden",
        opacity: opacity < 1 ? opacity : undefined,
      }}
    >
      {/* The same band, colours and hairline as the browser chrome that will
          drop over it, so the swap reads as the title becoming the chrome. */}
      <div
        style={{
          height: WINDOW_CHROME_H,
          borderBottom: `1px solid ${COLORS.border}`,
          background: COLORS.bgSubtle,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {title > 0.001 && <MakeoverTitle fs={19} upgraded={upgraded} opacity={title} />}
      </div>
    </div>
  );
};

/**
 * The tree while its rows populate. TreeView draws each parent's rail to its
 * last child's full height even while those children are still collapsed, so
 * a bare tree would show a rail stub under the first row; clipping to the
 * revealed extent keeps every line attached to a row that is on screen.
 * `rows` undefined = settled: the bare CampaignTree, exactly as cut A has it.
 */
const PopulatingTree: React.FC<{ rows?: Record<string, number>; k: number; tile?: (row: number) => number }> = ({
  rows,
  k,
  tile,
}) => {
  const tree = <CampaignTree state={FINAL} adders reveal={rows} />;
  if (rows) {
    const height = treeLayout(campaignRows(FINAL), campaignAdders(FINAL), { k, reveal: rows }).height;
    // Clip below only: rows slide in from the left and must not be cut there.
    return <div style={{ height, clipPath: "inset(-40px -40px 0 -40px)" }}>{tree}</div>;
  }
  const rowBoxes = treeLayout(campaignRows(FINAL), campaignAdders(FINAL), { k }).items.filter((it) => it.type === "row");
  const glints = tile ? rowBoxes.map((it, i) => ({ it, t: tile(i) })).filter((g) => passing(g.t)) : [];
  if (glints.length === 0) return tree;
  return (
    <div style={{ position: "relative" }}>
      {tree}
      {glints.map(({ it, t }) => (
        <TileGlint key={it.id} x={it.x} y={it.y} k={k} t={t} />
      ))}
    </div>
  );
};

/** A row's glyph tile (TreeRowView: 10k padding + 18k chevron + 9k gap in; 28k tile centred in the 46k row). */
const TILE = { x: 37, y: 9, size: 28, radius: 7 } as const;

/** A 45° streak of light crossing one glyph tile, in tree coordinates. */
const TileGlint: React.FC<{ x: number; y: number; k: number; t: number }> = ({ x, y, k, t }) => {
  const at = -0.3 + 1.6 * t; // the streak's centre along the tile's diagonal
  const a = Math.sin(Math.PI * t);
  return (
    <div
      style={{
        position: "absolute",
        left: x + TILE.x * k,
        top: y + TILE.y * k,
        width: TILE.size * k,
        height: TILE.size * k,
        borderRadius: TILE.radius * k,
        background:
          `linear-gradient(135deg, transparent ${pct(at - 0.28)}, rgba(255,255,255,${(0.6 * a).toFixed(3)}) ${pct(at)}, ` +
          `transparent ${pct(at + 0.28)}), rgba(255,255,255,${(0.12 * a).toFixed(3)})`,
        mixBlendMode: "screen",
        pointerEvents: "none",
      }}
    />
  );
};

/**
 * "Components V2": a film light — like the makeover's, nothing in the UI
 * changes — that runs down the tree's glyph tiles and then crosses the card.
 * Each overlay exists only while its light is passing, so every frame around
 * it, cut A included, is the bare editor.
 */
export type StageSheen = {
  /** Glint progress 0..1 per tree row, in tree order (0 or 1 = none). */
  tile: (row: number) => number;
  /** The card's sheen progress 0..1 (0 or 1 = none). */
  card: number;
};

export type StageAssemblyL = {
  /** Browser chrome / builder pane entrance (EditorWindow assembly). */
  chrome: number;
  left: number;
  /** Preview FABs (Collab + AI sparkle). */
  fabs: number;
  /** Tree row / adder entrances by id. */
  rows: Record<string, number>;
};

/**
 * Everything the landscape camera films in the hook and the reveal: the
 * makeover panel and, over it, the EditorWindow at its contract position. With `assembly` undefined and the makeover done, this is
 * exactly cut A's editor.
 */
export const LandscapeStage: React.FC<{
  sweep: number;
  upgraded: number;
  /** Opacity of the title bar's contents / of the whole panel. */
  title: number;
  panel: number;
  assembly?: StageAssemblyL;
  sheen?: StageSheen;
}> = ({ sweep, upgraded, title, panel, assembly, sheen }) => {
  const fabs = assembly === undefined ? 1 : clamp01(assembly.fabs);
  return (
    <>
      <MakeoverPanelL upgraded={upgraded} title={title} opacity={panel} />
      <div style={{ position: "absolute", left: EDITOR_L.x, top: EDITOR_L.y }}>
        <EditorWindow
          width={EDITOR_L.width}
          height={EDITOR_L.height}
          leftWidth={EDITOR_L.leftWidth}
          k={EDITOR_L.k}
          dk={EDITOR_L.dk}
          assembly={assembly ? { chrome: assembly.chrome, left: assembly.left } : undefined}
          bar={CUT_A_BAR}
          meta={FINAL_STATS}
          tree={<PopulatingTree rows={assembly?.rows} k={EDITOR_L.k} tile={sheen?.tile} />}
          preview={<MakeoverMessage sweep={sweep} maxWidth={EDITOR_L.previewMaxW} sheen={sheen?.card} />}
          fabs={fabs >= 1 ? true : fabs <= 0.001 ? false : <div style={{ opacity: fabs }}><PreviewFabs /></div>}
        />
      </div>
    </>
  );
};

/* ── Portrait ───────────────────────────────────────────────────────────── */

/** The PortraitEditor's top-left in the world (the stage's standard spot). */
const PORTRAIT_ORIGIN = { x: PORTRAIT_STAGE.x + PORTRAIT_UI.side, y: PORTRAIT_STAGE.y + PORTRAIT_UI.top } as const;
/** Its content box (inside the 1px border), in stage units. */
const PORTRAIT_BOX = { w: PORTRAIT_STAGE.w - 2 * PORTRAIT_UI.side, h: PORTRAIT_UI.bottom - PORTRAIT_UI.top } as const;
/** Height of the action bar band (52 × barK) — the makeover title bar fills it. */
const BAR_BAND = 52 * EDITOR_V.barK;
/**
 * Where the builder sheet's top edge sits, surface units. Past the surface's
 * bottom (plus the sheet's own 40-unit parking margin) it is not rendered.
 */
export const SHEET_HIDDEN = PORTRAIT_BOX.h + 40;
/** The plain opening wraps a little narrower so the 40 px push-in holds it whole. */
const PORTRAIT_PLAIN_WRAP = 345;

/** The portrait title bar, drawn in the band the action bar will drop into. */
const MakeoverBarV: React.FC<{ upgraded: number; title: number; band: number }> = ({ upgraded, title, band }) => {
  if (band <= 0.001) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: PORTRAIT_BOX.w - 2,
        height: BAR_BAND,
        boxSizing: "border-box",
        // The action bar's own fill and hairline, so the title bar hands over
        // to it without a change of tone.
        background: COLORS.bgElevated,
        borderBottom: `${EDITOR_V.barK}px solid ${COLORS.border}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: band < 1 ? band : undefined,
      }}
    >
      {title > 0.001 && <MakeoverTitle fs={15} upgraded={upgraded} opacity={title} />}
    </div>
  );
};

export type StageAssemblyV = {
  /** Action bar entrance (0..1). */
  bar: number;
  /** Builder sheet top edge, surface units (SHEET_HIDDEN … CUT_A.sheetTop). */
  sheetY: number;
  rows: Record<string, number>;
};

/**
 * Everything the portrait camera films in the hook and the reveal: the
 * PortraitEditor at its stage position, its surface already up (it IS the
 * makeover panel), the title bar over the bar band, the builder sheet parked
 * below the surface. With `assembly` undefined and the makeover done, this is
 * exactly cut A's portrait editor.
 */
export const PortraitStage: React.FC<{
  sweep: number;
  upgraded: number;
  title: number;
  /** Opacity of the title bar's band (it gives way to the action bar). */
  band: number;
  /** Surface units the message sits below its editor position (see MakeoverMessage). */
  lift?: number;
  assembly?: StageAssemblyV;
  sheen?: StageSheen;
}> = ({ sweep, upgraded, title, band, lift, assembly, sheen }) => {
  const settled = assembly === undefined;
  // The sheet rides one variable, its visible top edge. Above the surface's
  // bottom it is laid out there (sheetTop), and the preview region — whose
  // bottom follows sheetTop — shrinks with it, so the card is covered by the
  // sheet rather than clipped ahead of it. Below the bottom it is parked with
  // the editor's own offset (assembly.sheet), fully hidden past SHEET_HIDDEN.
  // It comes to rest on cut A's detent: between the card's two button rows.
  const y = settled ? CUT_A.sheetTop : Math.max(CUT_A.sheetTop, Math.min(SHEET_HIDDEN, assembly.sheetY));
  const sheetTop = Math.min(PORTRAIT_BOX.h, y);
  const park = y - sheetTop; // 0 once the edge is inside the surface
  const sheetP = 1 - park / (PORTRAIT_BOX.h - sheetTop + 40);
  const overlay = <MakeoverBarV upgraded={upgraded} title={title} band={band} />;
  return (
    <div style={{ position: "absolute", left: PORTRAIT_ORIGIN.x, top: PORTRAIT_ORIGIN.y }}>
      <PortraitEditor
        k={EDITOR_V.k}
        barK={EDITOR_V.barK}
        dk={EDITOR_V.dk}
        sheetTop={sheetTop}
        bar={CUT_A_BAR}
        preview={<MakeoverMessage sweep={sweep} plainWrap={PORTRAIT_PLAIN_WRAP} lift={lift} sheen={sheen?.card} />}
        pills={FINAL_STATS}
        tree={<PopulatingTree rows={assembly?.rows} k={EDITOR_V.k} tile={sheen?.tile} />}
        assembly={settled ? undefined : { surface: 1, bar: assembly.bar, sheet: sheetP }}
        overlay={band > 0.001 ? overlay : undefined}
      />
    </div>
  );
};
