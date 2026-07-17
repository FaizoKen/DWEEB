import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Icon } from "../components/Icon";
import { Mascot } from "../components/Mascot";
import { Wordmark } from "../components/Wordmark";
import { useSpr } from "../components/Bits";
import { CHIME, IMPACT, POP, SCENES, voDelay } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

const HeadlineLine: React.FC<{
  children: React.ReactNode;
  progress: number;
  size: number;
  accent?: boolean;
  tracking?: string;
}> = ({ children, progress, size, accent = false, tracking = "-0.055em" }) => {
  const p = Math.max(0, Math.min(1, progress));

  return (
    <div style={{ overflow: "hidden", padding: "0 .08em .04em", margin: "0 -.08em" }}>
      <div
        style={{
          display: "block",
          fontFamily: INTER,
          fontSize: size,
          lineHeight: 0.89,
          letterSpacing: tracking,
          fontWeight: 950,
          color: accent ? COLORS.green : COLORS.text,
          textTransform: "uppercase",
          opacity: p,
          transform: `translateY(${(1 - p) * 0.92}em) skewY(${(1 - p) * 4}deg)`,
          transformOrigin: "left bottom",
          textShadow: accent ? `0 0 42px ${COLORS.green}2e` : "0 12px 50px rgba(0,0,0,.5)",
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </div>
    </div>
  );
};

/** Inline mark keeps the search action self-contained and crisp at any scale. */
const GoogleG: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#4285f4"
      d="M21.6 12.227c0-.709-.064-1.391-.182-2.045H12v3.868h5.382a4.6 4.6 0 0 1-1.995 3.018v2.509h3.231c1.891-1.741 2.982-4.305 2.982-7.35Z"
    />
    <path
      fill="#34a853"
      d="M12 22c2.7 0 4.964-.895 6.618-2.423l-3.231-2.509c-.895.6-2.041.955-3.387.955-2.605 0-4.809-1.759-5.6-4.123H3.059v2.591A9.996 9.996 0 0 0 12 22Z"
    />
    <path
      fill="#fbbc05"
      d="M6.4 13.9A6.01 6.01 0 0 1 6.086 12c0-.659.114-1.3.314-1.9V7.509H3.059A9.996 9.996 0 0 0 2 12c0 1.614.386 3.141 1.059 4.491L6.4 13.9Z"
    />
    <path
      fill="#ea4335"
      d="M12 5.977c1.468 0 2.786.505 3.823 1.496l2.868-2.868C16.959 2.991 14.695 2 12 2a9.996 9.996 0 0 0-8.941 5.509L6.4 10.1c.791-2.364 2.995-4.123 5.6-4.123Z"
    />
  </svg>
);

const SearchPanel: React.FC<{
  progress: number;
  vertical: boolean;
  frame: number;
  typeAt: number;
}> = ({ progress, vertical, frame, typeAt }) => {
  const p = Math.max(0, Math.min(1, progress));
  const query = "DWEEB Discord builder";
  const chars = Math.max(0, Math.min(query.length, Math.floor((frame - typeAt) / 1.25)));
  const typed = query.slice(0, chars);
  const typing = chars > 0 && chars < query.length;

  return (
    <div
      style={{
        width: vertical ? 620 : 550,
        opacity: p,
        transform: `translateY(${(1 - p) * 34}px) scale(${0.95 + p * 0.05})`,
        transformOrigin: "center",
        fontFamily: INTER,
      }}
    >
      <div
        style={{
          height: vertical ? 94 : 88,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          paddingLeft: vertical ? 26 : 24,
          overflow: "hidden",
          borderRadius: 999,
          background: "#fff",
          border: "1px solid rgba(255,255,255,.82)",
          boxShadow:
            "0 28px 85px rgba(0,0,0,.48), 0 8px 30px rgba(66,133,244,.13), inset 0 -1px rgba(0,0,0,.08)",
        }}
      >
        <Icon name="search" size={vertical ? 25 : 23} color="#5f6368" />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            marginLeft: 17,
            color: "#202124",
            fontSize: vertical ? 21 : 20,
            fontWeight: 560,
            letterSpacing: "-.01em",
            whiteSpace: "nowrap",
          }}
        >
          {typed}
          {typing && (
            <span
              style={{
                display: "inline-block",
                width: 2,
                height: "1em",
                marginLeft: 2,
                verticalAlign: "-.12em",
                background: frame % 12 < 8 ? "#4285f4" : "transparent",
              }}
            />
          )}
        </div>
        <div
          style={{
            width: vertical ? 84 : 78,
            alignSelf: "stretch",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderLeft: "1px solid #e2e5e9",
            background: "#f8f9fa",
            flexShrink: 0,
          }}
        >
          <GoogleG size={vertical ? 38 : 35} />
        </div>
      </div>
      <div
        style={{
          marginTop: 17,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          color: COLORS.textMuted,
          fontSize: vertical ? 17 : 16,
          fontWeight: 700,
          letterSpacing: ".01em",
        }}
      >
        <span style={{ color: COLORS.green, fontWeight: 850 }}>dweeb.faizo.net</span>
        <span style={{ color: COLORS.textSubtle }}>·</span>
        Start free in your browser
      </div>
    </div>
  );
};

/**
 * An action-first end card. The promise names the product plainly, and the
 * search bar turns discovery into the final visual action without another
 * generic promo card.
 */
export const SceneCta: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("cta");

  const brandP = useSpr(5, { damping: 20, stiffness: 150 });
  const line1P = useSpr(d - 8, { damping: 17, stiffness: 155, mass: 0.65 });
  const line2P = useSpr(d + 2, { damping: 17, stiffness: 155, mass: 0.65 });
  const line3P = useSpr(d + 12, { damping: 17, stiffness: 155, mass: 0.65 });
  const line4P = useSpr(d + 20, { damping: 17, stiffness: 155, mass: 0.65 });
  const mascotP = useSpr(d + 34, { damping: 14, stiffness: 145, mass: 0.7 });
  const actionAt = d + 62;
  const actionP = useSpr(actionAt, { damping: 18, stiffness: 145, mass: 0.7 });
  const underline = interpolate(frame, [d + 16, d + 48], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // The first two keyframes are the impact punch: the riser lands on frame 2
  // and the camera recoils with it before settling into the slow drift.
  const shots: Shot[] = vert
    ? [
        { f: 0, x: 960, y: 532, s: 1.64 },
        { f: 14, x: 960, y: 536, s: 1.52 },
        { f: 38, x: 960, y: 540, s: 1.5 },
        { f: actionAt + 18, x: 960, y: 550, s: 1.54 },
        { f: SCENES.cta.durationInFrames - 12, x: 960, y: 545, s: 1.58 },
      ]
    : [
        { f: 0, x: 960, y: 530, s: 1.14 },
        { f: 14, x: 960, y: 536, s: 1.02 },
        { f: 42, x: 960, y: 540, s: 1.0 },
        { f: actionAt + 18, x: 972, y: 540, s: 1.035 },
        { f: SCENES.cta.durationInFrames - 12, x: 972, y: 540, s: 1.06 },
      ];

  const mascotSettled = Math.max(0, Math.min(1, mascotP));

  return (
    <AbsoluteFill>
      <Background glow="dual" />

      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(104deg, rgba(88,101,242,.09), transparent 34%, transparent 67%, rgba(87,242,135,.06))",
          opacity: interpolate(frame, [0, 32], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      />

      <Camera shots={shots} drift={1.5}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              width: vert ? 660 : 1660,
              height: vert ? 980 : 860,
              position: "relative",
              fontFamily: INTER,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: vert ? 38 : 54,
                top: vert ? 18 : 40,
                display: "flex",
                alignItems: "center",
                gap: 21,
                opacity: Math.min(1, brandP),
                transform: `translateY(${(1 - Math.min(1, brandP)) * -18}px)`,
              }}
            >
              <Wordmark size={vert ? 46 : 52} delay={3} underline={false} />
              <div style={{ width: 1, height: 38, background: COLORS.borderStrong }} />
              <div
                style={{
                  color: COLORS.textMuted,
                  fontSize: vert ? 11 : 12,
                  lineHeight: 1.35,
                  fontWeight: 850,
                  letterSpacing: ".14em",
                }}
              >
                VISUAL DISCORD
                <br />
                MESSAGE BUILDER
              </div>
            </div>

            <div
              style={{
                position: "absolute",
                left: vert ? 38 : 54,
                top: vert ? 154 : 180,
                width: vert ? 590 : 1000,
              }}
            >
              {vert ? (
                <>
                  <HeadlineLine progress={line1P} size={79}>
                    Build
                  </HeadlineLine>
                  <HeadlineLine progress={line2P} size={79}>
                    better
                  </HeadlineLine>
                  <HeadlineLine progress={line3P} size={79}>
                    Discord
                  </HeadlineLine>
                  <HeadlineLine progress={line4P} size={91} accent tracking="-0.065em">
                    messages.
                  </HeadlineLine>
                </>
              ) : (
                <>
                  <HeadlineLine progress={line1P} size={100}>
                    Build better
                  </HeadlineLine>
                  <HeadlineLine progress={line2P} size={126}>
                    Discord
                  </HeadlineLine>
                  <HeadlineLine progress={line3P} size={142} accent tracking="-0.07em">
                    messages.
                  </HeadlineLine>
                </>
              )}

              <div
                style={{
                  width: vert ? 270 * underline : 390 * underline,
                  height: vert ? 8 : 9,
                  marginTop: vert ? 19 : 25,
                  borderRadius: 999,
                  background: `linear-gradient(90deg, ${COLORS.green}, ${COLORS.blurple})`,
                  boxShadow: `0 0 26px ${COLORS.green}66`,
                }}
              />
            </div>

            <div
              style={{
                position: "absolute",
                left: vert ? 468 : 1290,
                top: vert ? 565 : 92,
                zIndex: 4,
                opacity: mascotSettled,
                transform: `translate(${(1 - mascotSettled) * 90}px, ${(1 - mascotSettled) * 34}px) rotate(${interpolate(mascotSettled, [0, 1], [12, vert ? -5 : -7])}deg) scale(${0.72 + mascotSettled * 0.28})`,
              }}
            >
              <Mascot size={vert ? 148 : 220} />
            </div>

            <div
              style={{
                position: "absolute",
                left: vert ? 20 : 1065,
                top: vert ? 730 : 430,
                zIndex: 3,
              }}
            >
              <SearchPanel
                progress={actionP}
                vertical={vert}
                frame={frame}
                typeAt={actionAt + 12}
              />
            </div>

            {!vert && (
              <div
                style={{
                  position: "absolute",
                  left: 54,
                  bottom: 46,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  color: COLORS.textSubtle,
                  fontSize: 13,
                  fontWeight: 750,
                  letterSpacing: ".08em",
                  opacity: Math.min(1, actionP),
                }}
              >
                <span style={{ width: 34, height: 1, background: COLORS.borderStrong }} />
                WEBHOOKS · EMBEDS · COMPONENTS V2
              </div>
            )}
          </div>
        </AbsoluteFill>
      </Camera>

      <AbsoluteFill
        style={{
          background: "#dfe6ff",
          opacity: interpolate(frame, [2, 5, 11], [0, 0.2, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          pointerEvents: "none",
        }}
      />

      <Sequence from={2} durationInFrames={30}>
        <Audio src={staticFile(IMPACT)} volume={0.88} />
      </Sequence>
      <Sequence from={d + 34} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.42} />
      </Sequence>
      <Sequence from={actionAt + 2} durationInFrames={24}>
        <Audio src={staticFile(CHIME)} volume={0.58} />
      </Sequence>
    </AbsoluteFill>
  );
};
