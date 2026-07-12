import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Mascot } from "./components/Mascot";
import { COLORS, FONT } from "./theme";

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 299], [1.035, 1.09], {
    ...clamp,
    easing: Easing.inOut(Easing.ease),
  });

  return (
    <AbsoluteFill style={{ overflow: "hidden", background: COLORS.bg }}>
      <Img
        src={staticFile("activity-background.png")}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }}
      />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(70% 80% at 50% 48%, rgba(14,15,19,0.08), rgba(14,15,19,0.58) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

const ComponentChip: React.FC<{
  icon: string;
  label: string;
  color: string;
  delay: number;
  top: number;
  left: number;
}> = ({ icon, label, color, delay, top, left }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 145 } });
  const drift = Math.sin((frame + delay) / 18) * 3;

  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px 8px 8px",
        borderRadius: 12,
        border: `1px solid ${color}88`,
        background: "rgba(23,25,31,0.94)",
        boxShadow: `0 10px 28px rgba(0,0,0,0.45), 0 0 20px ${color}28`,
        opacity: p,
        transform: `translateX(${interpolate(p, [0, 1], [-62, 0])}px) translateY(${drift}px) scale(${interpolate(p, [0, 1], [0.84, 1])})`,
      }}
    >
      <div
        style={{
          width: 29,
          height: 29,
          borderRadius: 8,
          display: "grid",
          placeItems: "center",
          background: `${color}22`,
          color,
          fontSize: 15,
          fontWeight: 900,
        }}
      >
        {icon}
      </div>
      <span style={{ color: COLORS.text, fontSize: 13, fontWeight: 750, letterSpacing: "0.02em" }}>
        {label}
      </span>
    </div>
  );
};

const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, stiffness: 170 } });
  const exit = interpolate(frame, [56, 72], [1, 0], clamp);

  return (
    <AbsoluteFill style={{ fontFamily: FONT, opacity: exit }}>
      <ComponentChip icon="T" label="TEXT" color="#60a5fa" delay={2} top={54} left={34} />
      <ComponentChip icon="▦" label="GALLERY" color="#d946ef" delay={7} top={246} left={56} />
      <ComponentChip icon="↗" label="BUTTON" color={COLORS.green} delay={12} top={68} left={455} />
      <ComponentChip icon="◇" label="SECTION" color="#a78bfa" delay={17} top={248} left={454} />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${interpolate(pop, [0, 1], [0.72, 1])})`,
          opacity: pop,
        }}
      >
        <Mascot size={82} />
        <div
          style={{
            marginTop: 8,
            color: COLORS.text,
            fontSize: 35,
            fontWeight: 900,
            letterSpacing: "-0.035em",
            lineHeight: 1,
            textShadow: "0 8px 30px rgba(0,0,0,0.72)",
          }}
        >
          BUILD IT TOGETHER
        </div>
        <div style={{ marginTop: 9, color: COLORS.textMuted, fontSize: 14, fontWeight: 600 }}>
          Components V2, without the JSON.
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Cursor: React.FC<{
  color: string;
  start: number;
  x: [number, number];
  y: [number, number];
}> = ({ color, start, x, y }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [start, start + 65], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });
  const opacity = interpolate(
    frame,
    [start - 5, start + 5, start + 70, start + 82],
    [0, 1, 1, 0],
    clamp,
  );
  return (
    <div
      style={{
        position: "absolute",
        left: interpolate(p, [0, 1], x),
        top: interpolate(p, [0, 1], y),
        opacity,
        filter: `drop-shadow(0 0 8px ${color})`,
        transform: "rotate(-12deg)",
      }}
    >
      <div
        style={{
          width: 0,
          height: 0,
          borderTop: "13px solid transparent",
          borderBottom: "5px solid transparent",
          borderLeft: `19px solid ${color}`,
        }}
      />
      <div
        style={{
          marginLeft: 12,
          marginTop: -3,
          padding: "2px 6px",
          borderRadius: 5,
          background: color,
          color: COLORS.bg,
          fontSize: 8,
          fontWeight: 900,
        }}
      >
        LIVE
      </div>
    </div>
  );
};

const Builder: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 120 } });
  const exit = interpolate(frame, [80, 100], [1, 0], clamp);
  const sent = interpolate(frame, [55, 63, 82, 96], [0, 1, 1, 0], clamp);
  const build = interpolate(frame, [10, 60], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ fontFamily: FONT, opacity: exit }}>
      <div
        style={{
          position: "absolute",
          inset: "23px 34px",
          overflow: "hidden",
          borderRadius: 18,
          border: `1px solid ${COLORS.borderStrong}`,
          background: COLORS.bgElevated,
          boxShadow: "0 24px 80px rgba(0,0,0,0.72)",
          opacity: enter,
          transform: `translateY(${interpolate(enter, [0, 1], [45, 0])}px) scale(${interpolate(enter, [0, 1], [0.92, 1])})`,
        }}
      >
        <div
          style={{
            height: 34,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 12px",
            borderBottom: `1px solid ${COLORS.border}`,
            background: "rgba(14,15,19,0.96)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Mascot size={20} glow={false} look={false} />
            <span style={{ color: COLORS.text, fontSize: 11, fontWeight: 900 }}>DWEEB</span>
          </div>
          <div style={{ display: "flex", gap: 5 }}>
            <div style={{ width: 42, height: 15, borderRadius: 5, background: COLORS.bgHover }} />
            <div
              style={{
                width: 42,
                height: 15,
                borderRadius: 5,
                background: COLORS.blurple,
                boxShadow: `0 0 12px ${COLORS.blurple}66`,
              }}
            />
          </div>
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "45% 55%", height: "calc(100% - 34px)" }}
        >
          <div
            style={{
              padding: "14px 12px",
              borderRight: `1px solid ${COLORS.border}`,
              background: "rgba(14,15,19,0.72)",
            }}
          >
            <div
              style={{
                color: COLORS.textMuted,
                fontSize: 8,
                fontWeight: 850,
                letterSpacing: "0.12em",
              }}
            >
              COMPONENT TREE
            </div>
            {[
              ["▤", "Container", COLORS.blurple],
              ["T", "Text", "#60a5fa"],
              ["▦", "Media gallery", "#d946ef"],
              ["↗", "Button", COLORS.green],
            ].map(([icon, label, color], i) => {
              const row = interpolate(build, [i * 0.2, i * 0.2 + 0.35], [0, 1], clamp);
              return (
                <div
                  key={label}
                  style={{
                    height: 43,
                    marginTop: 8,
                    padding: "0 10px",
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    borderRadius: 9,
                    border: `1px solid ${color}66`,
                    borderLeft: `3px solid ${color}`,
                    background: `${color}16`,
                    opacity: row,
                    transform: `translateX(${interpolate(row, [0, 1], [-28, 0])}px)`,
                  }}
                >
                  <div
                    style={{
                      width: 25,
                      height: 25,
                      borderRadius: 7,
                      display: "grid",
                      placeItems: "center",
                      color,
                      background: `${color}24`,
                      fontSize: 12,
                      fontWeight: 900,
                    }}
                  >
                    {icon}
                  </div>
                  <span style={{ color: COLORS.text, fontSize: 10, fontWeight: 750 }}>{label}</span>
                </div>
              );
            })}
          </div>

          <div style={{ padding: 15, background: "#292b31" }}>
            <div
              style={{
                height: "100%",
                padding: 12,
                borderRadius: 12,
                borderLeft: `3px solid ${COLORS.blurple}`,
                background: "#202228",
                boxShadow: "0 10px 26px rgba(0,0,0,0.34)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Mascot size={26} glow={false} look={false} />
                <div>
                  <div style={{ color: COLORS.text, fontSize: 9, fontWeight: 900 }}>DWEEB</div>
                  <div
                    style={{
                      width: 72,
                      height: 4,
                      marginTop: 3,
                      borderRadius: 9,
                      background: COLORS.bgHover,
                    }}
                  />
                </div>
              </div>
              <div
                style={{
                  width: "78%",
                  height: 7,
                  marginTop: 11,
                  borderRadius: 9,
                  background: COLORS.textMuted,
                }}
              />
              <div
                style={{
                  width: "58%",
                  height: 5,
                  marginTop: 5,
                  borderRadius: 9,
                  background: COLORS.bgHover,
                }}
              />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.35fr 0.85fr",
                  gap: 7,
                  height: 112,
                  marginTop: 12,
                  opacity: interpolate(build, [0.35, 0.8], [0, 1], clamp),
                  transform: `translateY(${interpolate(build, [0.35, 0.8], [18, 0], clamp)}px)`,
                }}
              >
                <div
                  style={{
                    borderRadius: 9,
                    border: "1px solid #5865f266",
                    background:
                      "radial-gradient(circle at 66% 32%, #57f28766, transparent 28%), linear-gradient(145deg, #242a4c, #17191f 72%)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <div
                    style={{
                      width: 54,
                      height: 38,
                      borderRadius: 8,
                      transform: "rotate(-8deg)",
                      background: "linear-gradient(135deg, #5865f2, #7c8bff)",
                      boxShadow: `8px 9px 0 ${COLORS.green}aa, 0 12px 25px rgba(0,0,0,0.4)`,
                    }}
                  />
                </div>
                <div style={{ display: "grid", gap: 7 }}>
                  <div
                    style={{
                      borderRadius: 9,
                      border: "1px solid #57f28755",
                      background: "linear-gradient(135deg, #15362e, #1a1d23)",
                      display: "grid",
                      placeItems: "center",
                      color: COLORS.green,
                      fontSize: 21,
                    }}
                  >
                    ▦
                  </div>
                  <div
                    style={{
                      borderRadius: 9,
                      border: "1px solid #60a5fa55",
                      background: "linear-gradient(135deg, #17263b, #1a1d23)",
                      display: "grid",
                      placeItems: "center",
                      color: "#60a5fa",
                      fontSize: 18,
                    }}
                  >
                    ✦
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                {[COLORS.blurple, COLORS.green, "#f0b232"].map((color) => (
                  <div
                    key={color}
                    style={{
                      width: 38,
                      height: 18,
                      borderRadius: 6,
                      background: `${color}30`,
                      color,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 48,
          top: 34,
          padding: "5px 9px",
          borderRadius: 999,
          background: "rgba(14,15,19,0.86)",
          border: `1px solid ${COLORS.blurple}`,
          color: "#c9cdfb",
          fontSize: 9,
          fontWeight: 900,
          letterSpacing: "0.12em",
        }}
      >
        LIVE COLLAB
      </div>
      <Cursor color="#a78bfa" start={25} x={[540, 180]} y={[265, 150]} />
      <Cursor color={COLORS.green} start={44} x={[104, 462]} y={[278, 210]} />

      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 34,
          transform: `translateX(-50%) scale(${0.86 + sent * 0.14})`,
          opacity: sent,
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "8px 15px",
          borderRadius: 999,
          color: COLORS.bg,
          background: COLORS.green,
          boxShadow: `0 0 34px ${COLORS.green}88`,
          fontSize: 12,
          fontWeight: 900,
          letterSpacing: "0.06em",
        }}
      >
        <span>✓</span> READY TO SHIP
      </div>
    </AbsoluteFill>
  );
};

const DiscordPost: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 125 } });
  const message = spring({ frame: frame - 10, fps, config: { damping: 15, stiffness: 145 } });
  const pointer = interpolate(frame, [34, 66], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });
  const click = interpolate(frame, [65, 69, 73], [0, 1, 0], clamp);
  const pointerOpacity = interpolate(frame, [28, 34, 82, 94], [0, 1, 1, 0], clamp);
  const response = spring({ frame: frame - 72, fps, config: { damping: 15, stiffness: 160 } });
  const exit = interpolate(frame, [96, 112], [1, 0], clamp);

  return (
    <AbsoluteFill style={{ fontFamily: FONT, opacity: enter * exit }}>
      <div
        style={{
          position: "absolute",
          inset: "18px 24px",
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "138px 1fr",
          borderRadius: 17,
          border: "1px solid #3f4147",
          background: "#313338",
          boxShadow: "0 24px 80px rgba(0,0,0,0.72)",
          transform: `translateY(${interpolate(enter, [0, 1], [34, 0])}px) scale(${interpolate(enter, [0, 1], [0.94, 1])})`,
        }}
      >
        <div style={{ padding: "14px 10px", background: "#2b2d31" }}>
          <div style={{ color: "#f2f3f5", fontSize: 11, fontWeight: 850 }}>DWEEB SPACE</div>
          <div style={{ height: 1, margin: "12px 0", background: "#3f4147" }} />
          <div style={{ color: "#949ba4", fontSize: 8, fontWeight: 850, letterSpacing: "0.08em" }}>
            TEXT CHANNELS
          </div>
          {["general", "community-updates", "ideas"].map((channel, index) => (
            <div
              key={channel}
              style={{
                marginTop: 7,
                padding: "6px 7px",
                borderRadius: 5,
                color: index === 1 ? "#f2f3f5" : "#949ba4",
                background: index === 1 ? "#404249" : "transparent",
                fontSize: 9,
                fontWeight: index === 1 ? 780 : 650,
              }}
            >
              <span style={{ marginRight: 5, color: "#80848e" }}>#</span>
              {channel}
            </div>
          ))}
        </div>

        <div style={{ position: "relative", background: "#313338" }}>
          <div
            style={{
              height: 38,
              display: "flex",
              alignItems: "center",
              padding: "0 13px",
              borderBottom: "1px solid #26272d",
              boxShadow: "0 1px 3px rgba(0,0,0,0.28)",
              color: "#f2f3f5",
              fontSize: 11,
              fontWeight: 800,
            }}
          >
            <span style={{ marginRight: 7, color: "#80848e", fontSize: 16 }}>#</span>
            community-updates
          </div>

          <div
            style={{
              position: "absolute",
              left: 15,
              right: 15,
              top: 52,
              display: "grid",
              gridTemplateColumns: "34px 1fr",
              gap: 9,
              opacity: message,
              transform: `translateY(${interpolate(message, [0, 1], [28, 0])}px)`,
            }}
          >
            <Mascot size={34} glow={false} look={false} />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "#f2f3f5", fontSize: 11, fontWeight: 900 }}>DWEEB</span>
                <span
                  style={{
                    padding: "1px 4px",
                    borderRadius: 3,
                    color: "white",
                    background: COLORS.blurple,
                    fontSize: 7,
                    fontWeight: 900,
                  }}
                >
                  APP
                </span>
                <span style={{ color: "#949ba4", fontSize: 8 }}>Today at 12:04</span>
              </div>

              <div
                style={{
                  marginTop: 7,
                  padding: 11,
                  borderRadius: 8,
                  borderLeft: `3px solid ${COLORS.blurple}`,
                  background: "#2b2d31",
                }}
              >
                <div style={{ color: "#f2f3f5", fontSize: 13, fontWeight: 900 }}>
                  Your Components V2 message is live
                </div>
                <div style={{ marginTop: 5, color: "#b5bac1", fontSize: 9, lineHeight: 1.35 }}>
                  Built together in DWEEB and posted straight to this channel.
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.2fr 0.8fr",
                    gap: 7,
                    marginTop: 10,
                  }}
                >
                  <div
                    style={{
                      height: 54,
                      borderRadius: 7,
                      border: "1px solid #5865f255",
                      background:
                        "radial-gradient(circle at 72% 30%, #57f28755, transparent 30%), linear-gradient(145deg, #242a4c, #1e1f22 75%)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 5,
                    }}
                  >
                    {[COLORS.blurple, COLORS.green, "#60a5fa"].map((color, index) => (
                      <div
                        key={color}
                        style={{
                          width: 31,
                          height: 22,
                          borderRadius: 5,
                          background: color,
                          opacity: 0.78,
                          transform: `translateY(${index * 3 - 3}px)`,
                          boxShadow: `0 5px 12px ${color}35`,
                        }}
                      />
                    ))}
                  </div>
                  <div
                    style={{
                      borderRadius: 7,
                      border: "1px solid #57f28744",
                      background: "linear-gradient(145deg, #15372f, #1e1f22)",
                      display: "grid",
                      placeItems: "center",
                      color: COLORS.green,
                      fontSize: 22,
                    }}
                  >
                    ✦
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <div
                    style={{
                      padding: "6px 12px",
                      borderRadius: 5,
                      color: "white",
                      background: click > 0 ? COLORS.blurpleHover : COLORS.blurple,
                      boxShadow: `0 0 ${12 + click * 14}px ${COLORS.blurple}77`,
                      transform: `scale(${1 - click * 0.08})`,
                      fontSize: 9,
                      fontWeight: 850,
                    }}
                  >
                    Open builder
                  </div>
                  <div
                    style={{
                      padding: "6px 12px",
                      borderRadius: 5,
                      color: "#f2f3f5",
                      background: "#4e5058",
                      fontSize: 9,
                      fontWeight: 780,
                    }}
                  >
                    View details
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              position: "absolute",
              left: interpolate(pointer, [0, 1], [510, 90]),
              top: interpolate(pointer, [0, 1], [286, 205]),
              zIndex: 5,
              opacity: pointerOpacity,
              filter: "drop-shadow(0 0 8px #ffffff88)",
              transform: `scale(${1 - click * 0.12})`,
            }}
          >
            <div
              style={{
                width: 0,
                height: 0,
                borderTop: "13px solid transparent",
                borderBottom: "5px solid transparent",
                borderLeft: "19px solid white",
                transform: "rotate(-12deg)",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: -6,
                top: -7,
                width: 28 + click * 16,
                height: 28 + click * 16,
                borderRadius: "50%",
                border: `2px solid rgba(87,242,135,${click})`,
                transform: "translate(-50%, -50%)",
              }}
            />
          </div>

          <div
            style={{
              position: "absolute",
              left: 195,
              bottom: 15,
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "7px 11px",
              borderRadius: 7,
              color: COLORS.green,
              background: "rgba(35,165,89,0.15)",
              border: "1px solid rgba(87,242,135,0.42)",
              boxShadow: `0 0 22px ${COLORS.green}22`,
              opacity: response,
              transform: `translateY(${interpolate(response, [0, 1], [13, 0])}px)`,
              fontSize: 9,
              fontWeight: 850,
            }}
          >
            <span>✓</span> Interaction received — opening DWEEB
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const FinalCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 110 } });
  const scale = interpolate(frame, [0, 110], [1.07, 1.015], {
    ...clamp,
    easing: Easing.out(Easing.ease),
  });
  const fade = interpolate(frame, [96, 110], [1, 0], clamp);

  return (
    <AbsoluteFill style={{ opacity: enter * fade, overflow: "hidden", background: COLORS.bg }}>
      <Img
        src={staticFile("activity-cover.png")}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }}
      />
      <AbsoluteFill
        style={{
          background: "linear-gradient(180deg, transparent 65%, rgba(14,15,19,0.66) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 14,
          transform: `translateX(-50%) translateY(${interpolate(enter, [0, 1], [18, 0])}px)`,
          padding: "6px 13px",
          borderRadius: 999,
          color: COLORS.text,
          background: "rgba(23,25,31,0.88)",
          border: "1px solid rgba(174,182,255,0.35)",
          boxShadow: "0 8px 26px rgba(0,0,0,0.5)",
          fontFamily: FONT,
          fontSize: 10,
          fontWeight: 850,
          letterSpacing: "0.13em",
        }}
      >
        OPEN · BUILD · SEND
      </div>
    </AbsoluteFill>
  );
};

const Fades: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8, 288, 299], [1, 0, 0, 1], clamp);
  return <AbsoluteFill style={{ background: "#000", opacity, zIndex: 100 }} />;
};

export const ActivityPreview: React.FC = () => (
  <AbsoluteFill style={{ background: COLORS.bg }}>
    <Background />
    <Sequence from={0} durationInFrames={74}>
      <Hook />
    </Sequence>
    <Sequence from={54} durationInFrames={105}>
      <Builder />
    </Sequence>
    <Sequence from={137} durationInFrames={113}>
      <DiscordPost />
    </Sequence>
    <Sequence from={232} durationInFrames={68}>
      <FinalCard />
    </Sequence>
    <Fades />
  </AbsoluteFill>
);
