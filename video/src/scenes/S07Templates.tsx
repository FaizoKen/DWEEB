import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { Icon } from "../components/Icon";
import { DMsg, DContainer, DHeading, DBody, DGallery, DBtn, DSelect } from "../components/DiscordUI";
import { AppBtn, useSpr, cursorAt, Waypoint } from "../components/Bits";
import { voDelay, SCENES, CLICK, TICK, POP, CHIME } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

/** The gallery rows shown (real template names from src/data/presets.ts). */
const ROWS: { name: string; emoji: string; cat: string; accent: string }[] = [
  { name: "Welcome", emoji: "👋", cat: "Welcome", accent: "#23a559" },
  { name: "Server rules", emoji: "📜", cat: "Welcome", accent: "#f0b232" },
  { name: "Role menu", emoji: "🎭", cat: "Community", accent: "#9b84ee" },
  { name: "Giveaway", emoji: "🎉", cat: "Events", accent: "#f0b232" },
  { name: "Poll", emoji: "📊", cat: "Events", accent: "#00a8fc" },
  { name: "Announcement", emoji: "📢", cat: "Community", accent: COLORS.blurple },
  { name: "Patch notes", emoji: "🛠️", cat: "Community", accent: "#00a8fc" },
  { name: "FAQ", emoji: "❓", cat: "Support", accent: "#00a8fc" },
];

/** Which rows the cursor browses, in order (indices into ROWS). */
const HOVER_ROWS = [0, 2, 3, 5];

/**
 * TEMPLATES — you never start from zero. The cursor flips down the gallery and
 * the big stage previews each template's actual message live — Welcome, Role
 * menu, Giveaway — before opening Announcement to make it yours.
 */
export const SceneTemplates: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("templates");

  // One preview swap roughly every 1.3s while the VO lists them.
  const hoverAt = [d + 36, d + 76, d + 116, d + 152];
  const tOpen = d + 184; // click "Announcement" → open in the editor

  const opened = frame > tOpen;
  const openIn = useSpr(tOpen, { damping: 13 });

  // Preview stack: each hovered template springs in over the previous one.
  const springs = hoverAt.map((t) => useSpr(t, { damping: 15, stiffness: 120 }));
  const active = hoverAt.reduce((acc, t, i) => (frame >= t ? i : acc), -1);

  // World-space row centers. Landscape: gallery card at left 250, rows from
  // y≈332 every 64px. Portrait restacks gallery-over-stage in a centered
  // column (~1217 world px tall), so the rows start near y≈21 instead.
  const rowY = (i: number) => (vert ? 21 : 332) + i * 64;
  const hoverX = vert ? 900 : 530;
  const waypoints: Waypoint[] = [
    { f: d + 2, x: vert ? 960 : 640, y: vert ? 380 : 620 },
    { f: hoverAt[0] - 6, x: hoverX, y: rowY(HOVER_ROWS[0]) },
    { f: hoverAt[1], x: hoverX, y: rowY(HOVER_ROWS[1]) },
    { f: hoverAt[2], x: hoverX, y: rowY(HOVER_ROWS[2]) },
    { f: hoverAt[3], x: hoverX, y: rowY(HOVER_ROWS[3]) },
    { f: tOpen, x: hoverX, y: rowY(HOVER_ROWS[3]), press: true },
    { f: tOpen + 12, x: hoverX, y: rowY(HOVER_ROWS[3]) },
  ];
  const cur = cursorAt(frame, waypoints);

  // Push in while the previews flip (gallery + stage both in frame), then
  // zoom out once one opens. The portrait column holds both cards in one tall
  // frame, so its camera only breathes.
  const shots: Shot[] = vert
    ? [
        { f: 0, x: 960, y: 540, s: 1.08 },
        { f: d + 32, x: 960, y: 545, s: 1.2 },
        { f: tOpen + 4, x: 960, y: 560, s: 1.2 },
        { f: tOpen + 32, x: 960, y: 545, s: 1.1 },
      ]
    : [
        { f: 0, x: 960, y: 540, s: 1.06 },
        { f: d + 32, x: 960, y: 532, s: 1.2 },
        { f: tOpen + 4, x: 945, y: 540, s: 1.2 },
        { f: tOpen + 32, x: 960, y: 540, s: 1.06 },
      ];

  const previews: React.ReactNode[] = [
    /* Welcome */
    <DMsg key="w" author="Nebula Gaming" mascot>
      <DContainer accent="#23a559">
        <DHeading>👋 Welcome to Nebula</DHeading>
        <DBody>Say hi in #general and grab your roles below — glad you're here.</DBody>
        <div style={{ display: "flex", gap: 9 }}>
          <DBtn label="Get started" kind="success" />
          <DBtn label="Server guide" />
        </div>
      </DContainer>
    </DMsg>,
    /* Role menu */
    <DMsg key="r" author="Nebula Gaming" mascot>
      <DContainer accent="#9b84ee">
        <DHeading>🎭 Pick your roles</DHeading>
        <DBody>Choose your platforms and pings — change them any time.</DBody>
        <DSelect placeholder="Choose your roles…" />
      </DContainer>
    </DMsg>,
    /* Giveaway */
    <DMsg key="g" author="Nebula Gaming" mascot>
      <DContainer accent="#f0b232">
        <DHeading>🎉 Nitro giveaway</DHeading>
        <DBody>One month of Nitro · ends Friday · winners drawn fairly.</DBody>
        <div style={{ display: "flex", gap: 9 }}>
          <DBtn label="Enter giveaway" kind="primary" emoji="🎉" />
          <DBtn label="128 entered" disabled />
        </div>
      </DContainer>
    </DMsg>,
    /* Announcement */
    <DMsg key="a" author="Nebula Gaming" mascot>
      <DContainer accent={COLORS.green}>
        <DHeading icon="rocket">Season 4 is live</DHeading>
        <DBody>New maps, ranked rewards, and a fresh battle pass.</DBody>
        <DGallery h={124} />
        <div style={{ display: "flex", gap: 9 }}>
          <DBtn label="Claim reward" kind="success" emoji="🎁" />
          <DBtn label="Patch notes" kind="primary" />
        </div>
      </DContainer>
    </DMsg>,
  ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {/* portrait: gallery over stage in one tall column */}
          <div style={{ display: "flex", flexDirection: vert ? "column" : "row", gap: vert ? 28 : 40, alignItems: "center" }}>
            {/* ── the gallery ──────────────────────────────────────────── */}
            <div
              style={{
                width: 560,
                background: COLORS.bgElevated,
                border: `1px solid ${COLORS.borderStrong}`,
                borderRadius: 20,
                padding: 24,
                boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
                fontFamily: INTER,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 8 }}>
                <Icon name="blocks" size={24} color={COLORS.blurple} />
                <span style={{ fontSize: 21, fontWeight: 800, color: COLORS.text }}>Templates</span>
                <span style={{ fontSize: 13.5, color: COLORS.textSubtle }}>hover to preview</span>
              </div>
              {ROWS.map((t, i) => {
                const p = useSpr(d + 4 + i * 2.4, { damping: 15, stiffness: 150 });
                const hovIdx = HOVER_ROWS.indexOf(i);
                const lit = hovIdx !== -1 && hovIdx === active;
                const picked = i === HOVER_ROWS[3] && opened;
                return (
                  <div
                    key={t.name}
                    style={{
                      opacity: p,
                      transform: `translateY(${(1 - p) * 16}px)`,
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      height: 56,
                      padding: "0 14px",
                      borderRadius: 12,
                      background: lit || picked ? `${t.accent}18` : COLORS.bgSubtle,
                      border: `1.5px solid ${lit || picked ? t.accent : COLORS.border}`,
                      boxShadow: lit || picked ? `0 0 24px ${t.accent}44` : "none",
                      boxSizing: "border-box",
                    }}
                  >
                    <span style={{ fontSize: 22 }}>{t.emoji}</span>
                    <span style={{ fontSize: 15.5, fontWeight: 750, color: COLORS.text }}>{t.name}</span>
                    <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: t.accent }}>{t.cat}</span>
                  </div>
                );
              })}
            </div>

            {/* ── the live preview stage ───────────────────────────────── */}
            <div
              style={{
                width: 820,
                height: 600,
                background: COLORS.dBgPrimary,
                border: `1px solid ${COLORS.dBgTertiary}`,
                borderRadius: 20,
                boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
                position: "relative",
                overflow: "hidden",
                padding: "26px 30px",
                boxSizing: "border-box",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 16,
                  right: 18,
                  fontFamily: INTER,
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: "0.05em",
                  color: COLORS.textSubtle,
                  background: "rgba(0,0,0,0.35)",
                  border: `1px solid ${COLORS.dBgTertiary}`,
                  borderRadius: 999,
                  padding: "4px 12px",
                }}
              >
                LIVE PREVIEW
              </div>
              {active === -1 && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: INTER,
                    fontSize: 15,
                    color: COLORS.dTextMuted,
                  }}
                >
                  Pick a template to preview it
                </div>
              )}
              {previews.map((node, i) => {
                const inP = springs[i];
                const outP = i < springs.length - 1 ? springs[i + 1] : 0;
                // The outgoing preview clears in the first half of the incoming
                // spring so the two never read as a muddled double-exposure.
                const fadeOut = Math.min(1, outP * 2.2);
                if (inP <= 0.01 || fadeOut >= 0.99) return null;
                return (
                  <div
                    key={i}
                    style={{
                      position: "absolute",
                      left: 30,
                      right: 30,
                      top: 44,
                      opacity: inP * (1 - fadeOut),
                      transform: `translateY(${(1 - inP) * 34 + outP * -22}px) scale(${0.97 + inP * 0.03 - outP * 0.02})`,
                      zIndex: i + 1,
                    }}
                  >
                    {node}
                  </div>
                );
              })}
              {/* the "open it" affordance on the click */}
              {opened && (
                <div
                  style={{
                    position: "absolute",
                    bottom: 22,
                    right: 24,
                    opacity: openIn,
                    transform: `translateY(${(1 - openIn) * 14}px)`,
                    zIndex: 10,
                  }}
                >
                  <AppBtn kind="primary" icon="pencil" size="sm" glow>
                    Open in the editor
                  </AppBtn>
                </div>
              )}
            </div>
          </div>
          {/* inside the camera → the tip stays locked to the UI through pans/zooms */}
          {frame > d && <Cursor x={cur.x} y={cur.y} pressed={cur.pressed} />}
        </AbsoluteFill>
      </Camera>

      {ROWS.map((_, i) => (
        <Sequence key={i} from={d + 4 + i * 2.4} durationInFrames={8}>
          <Audio src={staticFile(POP)} volume={0.22} />
        </Sequence>
      ))}
      {hoverAt.map((t, i) => (
        <Sequence key={`h${i}`} from={t} durationInFrames={8}>
          <Audio src={staticFile(TICK)} volume={0.45} />
        </Sequence>
      ))}
      <Sequence from={tOpen} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.7} />
      </Sequence>
      <Sequence from={tOpen + 4} durationInFrames={22}>
        <Audio src={staticFile(CHIME)} volume={0.5} />
      </Sequence>

      <Caption
        parts={[{ hl: "Templates" }, "— preview first, then make it yours."]}
        delay={d + 18}
        out={SCENES.templates.durationInFrames - 26}
        accent="#f0b232"
      />
    </AbsoluteFill>
  );
};
