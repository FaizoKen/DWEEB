import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { Icon } from "../components/Icon";
import { Mascot } from "../components/Mascot";
import { TreeRow } from "../components/AppUI";
import { DBody, DBtn, DContainer, DHeading, DMsg } from "../components/DiscordUI";
import { AvatarDot, TypeText, Waypoint, cursorAt, useSpr } from "../components/Bits";
import { CAST } from "../data";
import { CLICK, POP, SCENES, voDelay } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

const LiveDot: React.FC<{ active: boolean }> = ({ active }) => {
  const frame = useCurrentFrame();
  const pulse = active ? 1 + Math.sin(frame / 4) * 0.14 : 1;

  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: active ? COLORS.green : COLORS.dTextMuted,
        boxShadow: active ? `0 0 12px ${COLORS.green}` : "none",
        transform: `scale(${pulse})`,
        flexShrink: 0,
      }}
    />
  );
};

/** A film-scale facsimile of the Activity's real bottom-right PresenceDock. */
const InviteDock: React.FC<{
  join: number;
  hovered: boolean;
  clicked: boolean;
}> = ({ join, hovered, clicked }) => {
  const p = Math.max(0, Math.min(1, join));

  return (
    <div style={{ position: "relative" }}>
      {(hovered || (clicked && p < 0.92)) && (
        <div
          style={{
            position: "absolute",
            right: 0,
            bottom: 62,
            width: clicked ? 238 : 226,
            padding: "10px 13px",
            boxSizing: "border-box",
            borderRadius: 10,
            background: "rgba(17,19,24,.97)",
            border: `1px solid ${clicked ? `${COLORS.green}66` : COLORS.borderStrong}`,
            boxShadow: "0 18px 46px rgba(0,0,0,.52)",
            color: clicked ? COLORS.green : COLORS.text,
            fontSize: 12.5,
            lineHeight: 1.25,
            fontWeight: 760,
            textAlign: "center",
          }}
        >
          {clicked ? "Invite opened — your team can join" : "Invite people to edit together"}
        </div>
      )}

      <div
        style={{
          height: 52,
          minWidth: 134,
          padding: "0 13px 0 9px",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderRadius: 14,
          background: "linear-gradient(145deg, #20232b, #17191f)",
          border: `1px solid ${clicked ? `${COLORS.blurple}99` : COLORS.borderStrong}`,
          boxShadow: clicked
            ? `0 16px 50px rgba(0,0,0,.48), 0 0 28px ${COLORS.blurple}44`
            : "0 16px 50px rgba(0,0,0,.48)",
        }}
      >
        <span
          style={{
            width: 34,
            height: 34,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            background: COLORS.blurple,
            flexShrink: 0,
          }}
        >
          <Icon name="plus" size={17} color="#fff" />
        </span>

        <div style={{ display: "flex", alignItems: "center", paddingRight: p > 0.02 ? 8 : 0 }}>
          <div style={{ position: "relative", zIndex: 3 }}>
            <AvatarDot name={CAST.aria.name} color={CAST.aria.color} size={28} ring={COLORS.green} />
          </div>
          {[CAST.kai, CAST.mo].map((person, index) => (
            <div
              key={person.name}
              style={{
                position: "relative",
                zIndex: 2 - index,
                width: 28 * p,
                marginLeft: -7 * p,
                opacity: p,
                transform: `translateX(${(1 - p) * -12}px) scale(${0.78 + p * 0.22})`,
                transformOrigin: "left center",
              }}
            >
              <AvatarDot name={person.name} color={person.color} size={28} />
            </div>
          ))}
        </div>

        <span
          style={{
            color: p > 0.8 ? COLORS.green : COLORS.textMuted,
            fontSize: 11.5,
            fontWeight: 850,
            whiteSpace: "nowrap",
          }}
        >
          {p > 0.8 ? "3 live" : "Just you"}
        </span>
      </div>
    </div>
  );
};

/**
 * BUILD TOGETHER — begin directly in the Activity editor, click the real
 * bottom-right invite/presence control, then keep every collaboration beat in
 * that same editor. The old voice-call shelf and launch cut are intentionally
 * gone: the feature reads as one action attached to the work, not a new story.
 */
export const SceneActivity: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("activity");

  // Pace the actions across the longer collaboration line: invite on the spoken
  // invitation, teammates arrive on "build together", then both live edits land
  // before "in real time" resolves.
  const tInvite = d + 40;
  const tJoin = d + 82;
  const tKaiEdit = d + 110;
  const tAriaEdit = d + 146;

  const joinP = useSpr(tJoin, { damping: 15, stiffness: 175, mass: 0.58 });
  const presenceP = useSpr(tJoin + 3, { damping: 18, stiffness: 165 });
  const ariaP = useSpr(tAriaEdit, { damping: 14, stiffness: 180, mass: 0.55 });

  const waypoints: Waypoint[] = [
    { f: d - 3, x: 1260, y: 660 },
    { f: tInvite - 18, x: 1260, y: 660 },
    { f: tInvite - 5, x: 1708, y: 956 },
    { f: tInvite, x: 1708, y: 956, press: true },
    { f: tInvite + 8, x: 1708, y: 956 },
  ];
  const cursor = cursorAt(frame, waypoints);

  const shots: Shot[] = vert
    ? [
        { f: 0, x: 1160, y: 505, s: 1.42 },
        { f: tInvite - 6, x: 1510, y: 730, s: 1.72 },
        { f: tInvite + 5, x: 1510, y: 730, s: 1.72 },
        { f: tJoin + 12, x: 1160, y: 510, s: 1.42 },
        { f: SCENES.activity.durationInFrames - 8, x: 1160, y: 520, s: 1.46 },
      ]
    : [
        { f: 0, x: 960, y: 540, s: 1.03 },
        { f: tInvite - 6, x: 1370, y: 690, s: 1.2 },
        { f: tInvite + 5, x: 1370, y: 690, s: 1.2 },
        { f: tJoin + 12, x: 1100, y: 540, s: 1.12 },
        { f: SCENES.activity.durationInFrames - 8, x: 1100, y: 550, s: 1.15 },
      ];

  const joined = frame >= tJoin;

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots} blur={0.22}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              width: 1700,
              height: 920,
              display: "flex",
              flexDirection: "column",
              background: COLORS.dBgPrimary,
              borderRadius: 18,
              overflow: "hidden",
              border: `1px solid ${COLORS.dBgTertiary}`,
              boxShadow: "0 42px 130px rgba(0,0,0,.62), inset 0 1px rgba(255,255,255,.025)",
              fontFamily: INTER,
            }}
          >
            <div
              style={{
                height: 66,
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "0 18px",
                borderBottom: `1px solid ${COLORS.dBgTertiary}`,
                background: "rgba(43,45,49,.94)",
                flexShrink: 0,
              }}
            >
              <Mascot size={28} glow={false} look={false} />
              <span style={{ color: "#fff", fontSize: 16, fontWeight: 850 }}>DWEEB</span>
              <span style={{ color: COLORS.dTextMuted, fontSize: 13 }}>
                Activity · Nebula Gaming
              </span>
              <div style={{ flex: 1 }} />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "7px 11px",
                  borderRadius: 9,
                  background: `${COLORS.blurple}1c`,
                  border: `1px solid ${COLORS.blurple}55`,
                  color: COLORS.text,
                  fontSize: 12.5,
                  fontWeight: 750,
                }}
              >
                <Icon name="hash" size={15} color={COLORS.blurple} />
                events
              </div>
              <div
                style={{
                  padding: "9px 17px",
                  borderRadius: 9,
                  background: COLORS.blurple,
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 850,
                }}
              >
                Post
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <div
                style={{
                  width: 430,
                  flexShrink: 0,
                  padding: 16,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  background: COLORS.bg,
                  borderRight: `1px solid ${COLORS.dBgTertiary}`,
                }}
              >
                <div
                  style={{
                    padding: "2px 4px 8px",
                    color: COLORS.textSubtle,
                    fontSize: 11.5,
                    fontWeight: 850,
                    letterSpacing: ".1em",
                  }}
                >
                  COMPONENTS
                </div>
                <TreeRow icon="▰" label="Container" depth={0} />
                <TreeRow
                  icon="◇"
                  label="Community night"
                  depth={1}
                  sel={frame >= tKaiEdit - 5}
                  presence={joined ? [CAST.kai] : undefined}
                />
                <TreeRow
                  icon="¶"
                  label="Details"
                  depth={2}
                  presence={joined ? [CAST.mo] : undefined}
                />
                <TreeRow
                  icon="▣"
                  label="Buttons"
                  depth={1}
                  presence={frame >= tAriaEdit - 6 ? [CAST.aria] : undefined}
                />
              </div>

              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "26px 30px",
                  background: COLORS.dBgPrimary,
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <div style={{ width: 710, margin: "34px auto 0" }}>
                  <div
                    style={{
                      height: 40,
                      marginBottom: 18,
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      opacity: presenceP,
                      transform: `translateY(${(1 - presenceP) * -9}px)`,
                    }}
                  >
                    <LiveDot active={joined} />
                    <span
                      style={{
                        color: COLORS.green,
                        fontSize: 12,
                        fontWeight: 900,
                        letterSpacing: ".1em",
                      }}
                    >
                      LIVE
                    </span>
                    <span style={{ color: COLORS.dText, fontSize: 14.5, fontWeight: 700 }}>
                      Aria, Kai and Mo are editing together
                    </span>
                  </div>

                  <DMsg author="Nebula Events" mascot time="live preview">
                    <DContainer accent="#eb459e">
                      <DHeading icon="sparkle" iconColor="#eb459e" size={22}>
                        <span>
                          Community night
                          <TypeText
                            text=" — Friday!"
                            start={tKaiEdit}
                            cps={21}
                            caretColor={CAST.kai.color}
                          />
                        </span>
                        {frame >= tKaiEdit - 3 && frame < tAriaEdit + 10 && (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              marginLeft: "auto",
                              padding: "3px 8px",
                              borderRadius: 999,
                              background: `${CAST.kai.color}20`,
                              border: `1px solid ${CAST.kai.color}66`,
                              color: CAST.kai.color,
                              fontSize: 11.5,
                              fontWeight: 850,
                            }}
                          >
                            <AvatarDot name={CAST.kai.name} color={CAST.kai.color} size={18} />
                            Kai editing
                          </span>
                        )}
                      </DHeading>
                      <DBody>
                        Customs at 7, movie after. Bring a friend — winners get the sparkle role.
                      </DBody>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <DBtn label="RSVP" kind="primary" emoji="✓" />
                        {ariaP > 0.02 && (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              opacity: ariaP,
                              transform: `translateX(${(1 - ariaP) * 18}px) scale(${0.9 + ariaP * 0.1})`,
                            }}
                          >
                            <DBtn
                              label="Suggest a game"
                              emoji="+"
                              glow={frame < tAriaEdit + 24}
                            />
                            <AvatarDot
                              name={CAST.aria.name}
                              color={CAST.aria.color}
                              size={23}
                              ring={CAST.aria.color}
                            />
                          </div>
                        )}
                      </div>
                    </DContainer>
                  </DMsg>
                </div>

                <div style={{ position: "absolute", right: 18, bottom: 18 }}>
                  <InviteDock
                    join={joinP}
                    hovered={frame >= tInvite - 13 && frame < tInvite}
                    clicked={frame >= tInvite}
                  />
                </div>
              </div>
            </div>
          </div>

          {frame < tInvite + 10 && (
            <Cursor x={cursor.x} y={cursor.y} pressed={cursor.pressed} size={29} />
          )}
        </AbsoluteFill>
      </Camera>

      <Sequence from={tInvite} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.72} />
      </Sequence>
      <Sequence from={tJoin} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.48} />
      </Sequence>
      <Sequence from={tAriaEdit} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.42} />
      </Sequence>

      <Caption
        label="DISCORD ACTIVITY"
        parts={["Invite your team.", { hl: "Edit live." }]}
        delay={tInvite + 8}
        out={SCENES.activity.durationInFrames - 22}
        accent={COLORS.green}
      />
    </AbsoluteFill>
  );
};
