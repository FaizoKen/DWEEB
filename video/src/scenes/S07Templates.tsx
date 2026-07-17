import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { DBody, DBtn, DContainer, DGallery, DHeading, DMsg, DSep } from "../components/DiscordUI";
import { cursorAt, useSpr, Waypoint } from "../components/Bits";
import { Icon, IconName } from "../components/Icon";
import { CLICK, CHIME, POP, SCENES, TICK, voDelay } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

type TemplateChoiceProps = {
  name: string;
  category: string;
  icon: IconName;
  accent: string;
  reveal: number;
  focus: number;
  selected?: number;
  compact?: boolean;
};

const TemplateChoice: React.FC<TemplateChoiceProps> = ({
  name,
  category,
  icon,
  accent,
  reveal,
  focus,
  selected = 0,
  compact = false,
}) => {
  const shown = clamp01(reveal);
  const lit = clamp01(Math.max(focus, selected));

  return (
    <div
      style={{
        position: "relative",
        minWidth: 0,
        height: compact ? 108 : 108,
        padding: compact ? "13px 13px 12px" : "0 18px",
        borderRadius: 15,
        background: `linear-gradient(128deg, ${accent}${lit > 0.03 ? "20" : "0b"}, ${COLORS.bgSubtle} 62%)`,
        border: `1.5px solid ${lit > 0.03 ? accent : COLORS.border}`,
        boxShadow:
          lit > 0.03
            ? `0 15px 38px rgba(0,0,0,.28), 0 0 ${30 * lit}px ${accent}3d, inset 0 1px rgba(255,255,255,.045)`
            : "inset 0 1px rgba(255,255,255,.025)",
        display: "flex",
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "flex-start" : "center",
        gap: compact ? 9 : 15,
        boxSizing: "border-box",
        opacity: shown,
        transform: `translateY(${(1 - shown) * 18}px) scale(${0.975 + shown * 0.025})`,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: lit,
          background: `linear-gradient(100deg, transparent 15%, ${accent}15 50%, transparent 82%)`,
          transform: `translateX(${interpolate(lit, [0, 1], [-28, 0])}px)`,
        }}
      />
      <div
        style={{
          width: compact ? 34 : 46,
          height: compact ? 34 : 46,
          borderRadius: compact ? 10 : 13,
          background: `${accent}20`,
          border: `1px solid ${accent}55`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          boxShadow: lit > 0.1 ? `0 0 22px ${accent}44` : "none",
          zIndex: 1,
        }}
      >
        <Icon name={icon} size={compact ? 19 : 25} color={accent} />
      </div>
      <div style={{ minWidth: 0, flex: 1, zIndex: 1 }}>
        <div
          style={{
            color: COLORS.text,
            fontSize: compact ? 17 : 20,
            fontWeight: 820,
            lineHeight: 1.08,
            letterSpacing: "-0.02em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {name}
        </div>
        <div
          style={{
            color: lit > 0.12 ? accent : COLORS.textSubtle,
            fontSize: compact ? 11.5 : 13,
            fontWeight: 760,
            letterSpacing: "0.065em",
            textTransform: "uppercase",
            marginTop: compact ? 4 : 7,
            whiteSpace: "nowrap",
          }}
        >
          {category}
        </div>
      </div>
      {!compact && (
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: selected > 0.02 ? COLORS.greenDeep : `${accent}12`,
            border: `1px solid ${selected > 0.02 ? COLORS.green : `${accent}55`}`,
            transform: `scale(${0.88 + Math.max(lit, selected) * 0.12})`,
            zIndex: 1,
          }}
        >
          <Icon
            name={selected > 0.02 ? "check" : "eye"}
            size={16}
            color={selected > 0.02 ? "#fff" : accent}
          />
        </div>
      )}
      {compact && selected > 0.02 && (
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            width: 24,
            height: 24,
            borderRadius: 8,
            background: COLORS.greenDeep,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: `scale(${0.72 + clamp01(selected) * 0.28})`,
            zIndex: 2,
          }}
        >
          <Icon name="check" size={14} color="#fff" />
        </div>
      )}
    </div>
  );
};

const ReadyPanel: React.FC<{ reveal: number; compact?: boolean }> = ({
  reveal,
  compact = false,
}) => {
  const p = clamp01(reveal);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 16,
        background: `linear-gradient(135deg, ${COLORS.blurple}1f, ${COLORS.bgSubtle} 52%, ${COLORS.green}12)`,
        border: `1.5px solid ${COLORS.blurple}88`,
        boxShadow: `0 22px 60px rgba(0,0,0,.34), 0 0 42px ${COLORS.blurple}25`,
        padding: compact ? "15px 18px" : "28px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: compact ? "row" : "column",
        alignItems: compact ? "center" : "flex-start",
        gap: compact ? 16 : 17,
        opacity: p,
        transform: `translateY(${(1 - p) * 18}px) scale(${0.97 + p * 0.03})`,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: compact ? 200 : 330,
          height: compact ? 200 : 330,
          borderRadius: "50%",
          right: compact ? -80 : -110,
          top: compact ? -100 : -125,
          background: `radial-gradient(circle, ${COLORS.green}24, transparent 68%)`,
        }}
      />
      <div
        style={{
          width: compact ? 48 : 62,
          height: compact ? 48 : 62,
          borderRadius: compact ? 14 : 18,
          background: `linear-gradient(135deg, ${COLORS.blurple}, #7658ef)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: `0 12px 30px ${COLORS.blurple}66`,
          flexShrink: 0,
          zIndex: 1,
        }}
      >
        <Icon name="pencil" size={compact ? 24 : 30} color="#fff" />
      </div>
      <div style={{ zIndex: 1, minWidth: 0 }}>
        <div
          style={{
            color: COLORS.green,
            fontSize: compact ? 11.5 : 13,
            fontWeight: 850,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Announcement loaded
        </div>
        <div
          style={{
            color: COLORS.text,
            fontSize: compact ? 21 : 29,
            fontWeight: 850,
            letterSpacing: "-0.035em",
            marginTop: 5,
            lineHeight: 1.08,
          }}
        >
          Ready to make it yours
        </div>
        {!compact && (
          <div style={{ color: COLORS.textMuted, fontSize: 16, lineHeight: 1.42, marginTop: 10 }}>
            The full message is waiting in the visual editor.
          </div>
        )}
      </div>
      {!compact && (
        <div style={{ display: "flex", gap: 8, marginTop: 4, zIndex: 1 }}>
          {[
            ["notes", "Text"],
            ["upload", "Media"],
            ["blocks", "Components"],
          ].map(([icon, label]) => (
            <div
              key={label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                color: COLORS.text,
                fontSize: 13.5,
                fontWeight: 720,
                background: COLORS.bgInput,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 9,
                padding: "8px 10px",
              }}
            >
              <Icon name={icon as IconName} size={15} color={COLORS.blurple} />
              {label}
            </div>
          ))}
        </div>
      )}
      <div
        style={{
          position: compact ? "absolute" : "relative",
          left: compact ? 82 : 0,
          right: compact ? 18 : undefined,
          bottom: compact ? 10 : undefined,
          width: compact ? undefined : "100%",
          height: 3,
          borderRadius: 999,
          background: COLORS.bgInput,
          overflow: "hidden",
          marginTop: compact ? 0 : "auto",
          zIndex: 1,
        }}
      >
        <div
          style={{
            width: `${20 + p * 80}%`,
            height: "100%",
            borderRadius: 999,
            background: `linear-gradient(90deg, ${COLORS.blurple}, ${COLORS.green})`,
            boxShadow: `0 0 12px ${COLORS.green}88`,
          }}
        />
      </div>
    </div>
  );
};

type PreviewSurfaceProps = {
  vertical: boolean;
  patchIn: number;
  announcementIn: number;
  selected: number;
  activeName: string;
};

const PreviewSurface: React.FC<PreviewSurfaceProps> = ({
  vertical,
  patchIn,
  announcementIn,
  selected,
  activeName,
}) => {
  const patch = clamp01(patchIn);
  const announcement = clamp01(announcementIn);
  const picked = clamp01(selected);
  const welcomeOpacity = 1 - patch;
  const patchOpacity = patch * (1 - announcement);

  const messageStyle = (
    opacity: number,
    direction: number,
    verticalTop: number,
  ): React.CSSProperties => ({
    position: "absolute",
    left: vertical ? 18 : 38,
    right: vertical ? 18 : 38,
    top: vertical ? verticalTop : 74,
    opacity,
    transform: `translateY(${(1 - opacity) * direction}px) scale(${0.975 + opacity * 0.025})`,
  });

  return (
    <div
      style={{
        height: "100%",
        minWidth: 0,
        position: "relative",
        overflow: "hidden",
        borderRadius: 17,
        background: COLORS.dBgPrimary,
        border: `1px solid ${COLORS.dBgTertiary}`,
        boxShadow: "0 24px 58px rgba(0,0,0,.35), inset 0 1px rgba(255,255,255,.025)",
      }}
    >
      <div
        style={{
          height: 48,
          padding: "0 16px",
          display: "flex",
          alignItems: "center",
          gap: 9,
          background: "rgba(24,25,29,.48)",
          borderBottom: `1px solid ${COLORS.dDivider}`,
          boxSizing: "border-box",
        }}
      >
        <Icon name="hash" size={17} color={COLORS.dTextMuted} />
        <span style={{ color: COLORS.dText, fontSize: 14.5, fontWeight: 760 }}>announcements</span>
        <div style={{ flex: 1 }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "5px 9px",
            borderRadius: 999,
            background: picked > 0.05 ? `${COLORS.green}18` : "rgba(0,0,0,.28)",
            border: `1px solid ${picked > 0.05 ? `${COLORS.green}66` : COLORS.dDivider}`,
            color: picked > 0.05 ? COLORS.green : COLORS.dTextMuted,
            fontSize: vertical ? 10.5 : 11.5,
            fontWeight: 820,
            letterSpacing: "0.055em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          {picked > 0.05 && <Icon name="check" size={13} color={COLORS.green} />}
          {picked > 0.05 ? "Loaded in editor" : `${activeName} preview`}
        </div>
      </div>

      <div style={messageStyle(welcomeOpacity, 14, 168)}>
        <DMsg author="Nebula Gaming" mascot>
          <DContainer accent={COLORS.green}>
            <DHeading icon="users" size={vertical ? 20 : 23}>
              Welcome to Nebula
            </DHeading>
            <DBody size={vertical ? 15 : 17}>
              Your launchpad for events, squads, and everything Season 4.
            </DBody>
            <DSep />
            <div style={{ display: "flex", gap: 9 }}>
              <DBtn label="Start here" kind="success" />
              <DBtn label="Pick your roles" />
            </div>
          </DContainer>
        </DMsg>
      </div>

      <div style={messageStyle(patchOpacity, 18, 164)}>
        <DMsg author="Nebula Gaming" mascot>
          <DContainer accent="#00a8fc">
            <DHeading icon="notes" iconColor="#00a8fc" size={vertical ? 20 : 23}>
              Season 4 patch notes
            </DHeading>
            <DBody size={vertical ? 15 : 17}>
              Ranked reset, movement tuning, and three new maps are now live.
            </DBody>
            <DSep />
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <DBtn label="Read the changelog" kind="primary" />
              <DBody muted size={13.5}>
                v4.0.0
              </DBody>
            </div>
          </DContainer>
        </DMsg>
      </div>

      {/* The template's stock state — exactly what the build scene opens on
          and then personalizes (retitled heading, added reward button). */}
      <div style={messageStyle(announcement, 20, 86)}>
        <DMsg author="Nebula Gaming" mascot>
          <DContainer accent={COLORS.green}>
            <DHeading icon="rocket" size={vertical ? 20 : 23}>
              Season 4 launch
            </DHeading>
            <DBody size={vertical ? 15 : 17}>
              New maps, ranked rewards, and a fresh battle pass. Jump in and claim your founder
              badge before the weekend.
            </DBody>
            <DGallery h={vertical ? 104 : 136} />
            <div style={{ display: "flex", gap: 9 }}>
              <DBtn label="Patch notes" kind="primary" glow={picked > 0.05} />
            </div>
          </DContainer>
        </DMsg>
      </div>
    </div>
  );
};

type TemplateBrowserProps = {
  vertical: boolean;
  shellIn: number;
  welcomeIn: number;
  patchChoiceIn: number;
  announcementChoiceIn: number;
  welcomeFocus: number;
  patchFocus: number;
  announcementFocus: number;
  patchPreviewIn: number;
  announcementPreviewIn: number;
  selected: number;
  editorReady: number;
  activeName: string;
};

const TemplateBrowser: React.FC<TemplateBrowserProps> = ({
  vertical,
  shellIn,
  welcomeIn,
  patchChoiceIn,
  announcementChoiceIn,
  welcomeFocus,
  patchFocus,
  announcementFocus,
  patchPreviewIn,
  announcementPreviewIn,
  selected,
  editorReady,
  activeName,
}) => {
  const shell = clamp01(shellIn);
  const ready = clamp01(editorReady);
  const width = vertical ? 760 : 1650;
  const height = vertical ? 900 : 700;

  const choices = (
    <>
      <TemplateChoice
        name="Welcome"
        category="Welcome"
        icon="users"
        accent={COLORS.green}
        reveal={welcomeIn}
        focus={welcomeFocus}
        compact={vertical}
      />
      <TemplateChoice
        name="Patch notes"
        category="Community"
        icon="notes"
        accent="#00a8fc"
        reveal={patchChoiceIn}
        focus={patchFocus}
        compact={vertical}
      />
      <TemplateChoice
        name="Announcement"
        category="Community"
        icon="megaphone"
        accent={COLORS.blurple}
        reveal={announcementChoiceIn}
        focus={announcementFocus}
        selected={selected}
        compact={vertical}
      />
    </>
  );

  return (
    <div
      style={{
        width,
        height,
        position: "relative",
        fontFamily: INTER,
        transform: `translateY(${vertical ? -60 : -50}px) scale(${0.975 + shell * 0.025})`,
        opacity: shell,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -36,
          borderRadius: 60,
          background: `radial-gradient(circle at 32% 48%, ${COLORS.blurple}1f, transparent 42%), radial-gradient(circle at 78% 44%, ${COLORS.green}13, transparent 40%)`,
          filter: "blur(24px)",
          opacity: 0.9,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 21,
          overflow: "hidden",
          background: COLORS.bgElevated,
          border: `1px solid ${COLORS.borderStrong}`,
          boxShadow: "0 46px 130px rgba(0,0,0,.62), inset 0 1px rgba(255,255,255,.04)",
        }}
      >
        <div
          style={{
            height: vertical ? 46 : 48,
            background: COLORS.bgSubtle,
            borderBottom: `1px solid ${COLORS.border}`,
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "0 16px",
            boxSizing: "border-box",
          }}
        >
          <div style={{ display: "flex", gap: 7 }}>
            <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#ff5f57" }} />
            <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#febc2e" }} />
            <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#28c840" }} />
          </div>
          <div
            style={{
              height: 28,
              width: vertical ? 330 : 440,
              borderRadius: 8,
              background: COLORS.bgInput,
              color: COLORS.textMuted,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 11px",
              fontSize: 13,
              boxSizing: "border-box",
            }}
          >
            <Icon name="lock" size={13} color={COLORS.green} />
            dweeb.faizo.net/templates
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: COLORS.textSubtle }}>
            <Icon name="blocks" size={16} color={COLORS.blurple} />
            <span style={{ fontSize: 12.5, fontWeight: 780 }}>DWEEB</span>
          </div>
        </div>

        <div
          style={{
            height: `calc(100% - ${vertical ? 46 : 48}px)`,
            padding: vertical ? 18 : 26,
            boxSizing: "border-box",
            background:
              "radial-gradient(circle at 72% 42%, rgba(88,101,242,.08), transparent 40%), #0e0f13",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              height: vertical ? 58 : 64,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div
              style={{
                width: vertical ? 42 : 46,
                height: vertical ? 42 : 46,
                borderRadius: 13,
                background: `${COLORS.blurple}1d`,
                border: `1px solid ${COLORS.blurple}55`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Icon name="blocks" size={vertical ? 22 : 24} color={COLORS.blurple} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  color: COLORS.text,
                  fontSize: vertical ? 24 : 28,
                  lineHeight: 1,
                  fontWeight: 860,
                  letterSpacing: "-0.035em",
                }}
              >
                Pick a starting point
              </div>
              <div
                style={{ color: COLORS.textMuted, fontSize: vertical ? 13 : 14.5, marginTop: 7 }}
              >
                Three proven formats. One click to start shaping yours.
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                borderRadius: 999,
                padding: vertical ? "6px 9px" : "7px 12px",
                color: ready > 0.05 ? COLORS.green : COLORS.textSubtle,
                background: ready > 0.05 ? `${COLORS.green}13` : COLORS.bgInput,
                border: `1px solid ${ready > 0.05 ? `${COLORS.green}55` : COLORS.border}`,
                fontSize: vertical ? 11 : 12.5,
                fontWeight: 800,
                whiteSpace: "nowrap",
              }}
            >
              <Icon name={ready > 0.05 ? "check" : "sparkle"} size={14} color="currentColor" />
              {ready > 0.05 ? "Editor ready" : "Live preview"}
            </div>
          </div>

          <div
            style={{
              flex: 1,
              minHeight: 0,
              marginTop: vertical ? 12 : 18,
              display: "flex",
              flexDirection: vertical ? "column" : "row",
              gap: vertical ? 14 : 22,
            }}
          >
            <div
              style={{
                width: vertical ? "100%" : 440,
                height: vertical ? 108 : "100%",
                position: "relative",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  gridTemplateColumns: vertical ? "repeat(3, minmax(0, 1fr))" : "1fr",
                  gridTemplateRows: vertical ? "1fr" : "repeat(3, 108px)",
                  gap: vertical ? 10 : 14,
                  alignContent: vertical ? undefined : "center",
                  opacity: 1 - ready,
                  transform: `translateX(${-ready * 16}px)`,
                }}
              >
                {choices}
              </div>
              <ReadyPanel reveal={editorReady} compact={vertical} />
            </div>

            <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
              <PreviewSurface
                vertical={vertical}
                patchIn={patchPreviewIn}
                announcementIn={announcementPreviewIn}
                selected={selected}
                activeName={activeName}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * TEMPLATES — a fast starting-point beat. Three real templates are previewed,
 * Announcement is chosen, and the shot resolves into an editor-ready state so
 * the next scene can continue directly into building the Season 4 message.
 */
export const SceneTemplates: React.FC = () => {
  const frame = useCurrentFrame();
  const vertical = useVertical();
  const d = voDelay("templates");

  const tPatch = d + 28;
  const tAnnouncement = d + 49;
  const tSelect = d + 68;
  const tReady = tSelect + 8;

  // Keep every hook explicit: render order must not depend on a template list.
  const shellIn = useSpr(4, { damping: 19, stiffness: 135 });
  const welcomeIn = useSpr(10, { damping: 17, stiffness: 145 });
  const patchChoiceIn = useSpr(14, { damping: 17, stiffness: 145 });
  const announcementChoiceIn = useSpr(18, { damping: 17, stiffness: 145 });
  const patchPreviewIn = useSpr(tPatch, { damping: 19, stiffness: 150 });
  const announcementPreviewIn = useSpr(tAnnouncement, { damping: 19, stiffness: 150 });
  const selected = useSpr(tSelect, { damping: 13, stiffness: 175, mass: 0.48 });
  const editorReady = useSpr(tReady, { damping: 20, stiffness: 135, mass: 0.65 });

  const patchP = clamp01(patchPreviewIn);
  const announcementP = clamp01(announcementPreviewIn);
  const welcomeFocus = 1 - patchP;
  const patchFocus = patchP * (1 - announcementP);
  const announcementFocus = announcementP;
  const activeName =
    frame >= tAnnouncement ? "Announcement" : frame >= tPatch ? "Patch notes" : "Welcome";

  const panelLeft = vertical ? 580 : 135;
  const panelTop = vertical ? 30 : 140;
  // Dwell on each card, then hop to the next just before its preview beat.
  const waypoints: Waypoint[] = vertical
    ? [
        { f: d - 5, x: panelLeft + 170, y: panelTop + 188 },
        { f: tPatch - 14, x: panelLeft + 170, y: panelTop + 188 },
        { f: tPatch - 2, x: panelLeft + 410, y: panelTop + 188 },
        { f: tAnnouncement - 14, x: panelLeft + 410, y: panelTop + 188 },
        { f: tAnnouncement - 2, x: panelLeft + 650, y: panelTop + 188 },
        { f: tSelect, x: panelLeft + 650, y: panelTop + 188, press: true },
        { f: tSelect + 8, x: panelLeft + 650, y: panelTop + 188 },
      ]
    : [
        { f: d - 5, x: panelLeft + 390, y: panelTop + 293 },
        { f: tPatch - 14, x: panelLeft + 390, y: panelTop + 293 },
        { f: tPatch - 2, x: panelLeft + 390, y: panelTop + 415 },
        { f: tAnnouncement - 14, x: panelLeft + 390, y: panelTop + 415 },
        { f: tAnnouncement - 2, x: panelLeft + 390, y: panelTop + 537 },
        { f: tSelect, x: panelLeft + 390, y: panelTop + 537, press: true },
        { f: tSelect + 8, x: panelLeft + 390, y: panelTop + 537 },
      ];
  const cursor = cursorAt(frame, waypoints);

  const shots: Shot[] = vertical
    ? [
        { f: 0, x: 960, y: 490, s: 1.28 },
        { f: d + 18, x: 960, y: 500, s: 1.34 },
        { f: tSelect + 8, x: 960, y: 506, s: 1.36 },
        { f: SCENES.templates.durationInFrames, x: 960, y: 506, s: 1.37 },
      ]
    : [
        { f: 0, x: 960, y: 510, s: 1 },
        { f: d + 18, x: 960, y: 500, s: 1.04 },
        { f: tSelect + 8, x: 976, y: 500, s: 1.07 },
        { f: SCENES.templates.durationInFrames, x: 980, y: 500, s: 1.08 },
      ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots} blur={0.2}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <TemplateBrowser
            vertical={vertical}
            shellIn={shellIn}
            welcomeIn={welcomeIn}
            patchChoiceIn={patchChoiceIn}
            announcementChoiceIn={announcementChoiceIn}
            welcomeFocus={welcomeFocus}
            patchFocus={patchFocus}
            announcementFocus={announcementFocus}
            patchPreviewIn={patchPreviewIn}
            announcementPreviewIn={announcementPreviewIn}
            selected={selected}
            editorReady={editorReady}
            activeName={activeName}
          />
          {frame >= d - 6 && (
            <div style={{ opacity: 1 - clamp01(editorReady * 1.45) }}>
              <Cursor x={cursor.x} y={cursor.y} pressed={cursor.pressed} size={34} />
            </div>
          )}
        </AbsoluteFill>
      </Camera>

      <Sequence from={10} durationInFrames={10}>
        <Audio src={staticFile(POP)} volume={0.24} />
      </Sequence>
      <Sequence from={14} durationInFrames={10}>
        <Audio src={staticFile(POP)} volume={0.22} />
      </Sequence>
      <Sequence from={18} durationInFrames={10}>
        <Audio src={staticFile(POP)} volume={0.2} />
      </Sequence>
      <Sequence from={tPatch} durationInFrames={8}>
        <Audio src={staticFile(TICK)} volume={0.42} />
      </Sequence>
      <Sequence from={tAnnouncement} durationInFrames={8}>
        <Audio src={staticFile(TICK)} volume={0.46} />
      </Sequence>
      <Sequence from={tSelect} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.72} />
      </Sequence>
      <Sequence from={tSelect + 5} durationInFrames={22}>
        <Audio src={staticFile(CHIME)} volume={0.5} />
      </Sequence>

      <Caption
        label="Start faster"
        parts={["A polished first draft.", { hl: "Then make it yours." }]}
        delay={d + 7}
        out={SCENES.templates.durationInFrames - 18}
        accent={COLORS.green}
      />
    </AbsoluteFill>
  );
};
