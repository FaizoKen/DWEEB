import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot } from "../components/Camera";
import { Mascot } from "../components/Mascot";
import { Wordmark } from "../components/Wordmark";
import { Chip, Rise, TypeText, useSpr } from "../components/Bits";
import { voDelay, SCENES, IMPACT, CHIME } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

/** The official Google "G", for the search-bar payoff. */
const GoogleG: React.FC<{ size?: number }> = ({ size = 36 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
);

/** CTA — the end card: lockup, feature tags, and a Google search for "dweeb bot". */
export const SceneCta: React.FC = () => {
  const frame = useCurrentFrame();
  const d = voDelay("cta");

  const drop = useSpr(4, { damping: 11, stiffness: 130, mass: 0.9 });
  const searchIn = useSpr(d + 96, { damping: 13 });

  const shots: Shot[] = [
    { f: 0, x: 960, y: 560, s: 1.22 },
    { f: 34, x: 960, y: 540, s: 1.0 },
    { f: SCENES.cta.durationInFrames - 40, x: 960, y: 540, s: 1.04 },
  ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots} drift={2.5}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 32 }}>
            <div
              style={{
                opacity: drop,
                transform: `translateY(${interpolate(drop, [0, 1], [-200, 0])}px)`,
              }}
            >
              <Mascot size={230} />
            </div>
            <Wordmark size={140} delay={10} />
            <Rise delay={26}>
              <div style={{ display: "flex", gap: 12 }}>
                {[
                  { t: "Visual builder", c: COLORS.blurple },
                  { t: "AI assistant", c: "#9b84ee" },
                  { t: "Plugins", c: COLORS.green },
                  { t: "Build together", c: "#eb459e" },
                ].map((x) => (
                  <Chip key={x.t} color={x.c} big>
                    {x.t}
                  </Chip>
                ))}
              </div>
            </Rise>

            {/* the Google search bar — "dweeb bot" types itself in, centered */}
            <div
              style={{
                opacity: searchIn,
                transform: `translateY(${(1 - searchIn) * 22}px) scale(${0.94 + searchIn * 0.06})`,
                position: "relative",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 720,
                height: 96,
                background: "#fff",
                borderRadius: 999,
                boxShadow: "0 20px 70px rgba(0,0,0,0.5)",
              }}
            >
              <div style={{ position: "absolute", left: 34, display: "flex", alignItems: "center" }}>
                <GoogleG size={38} />
              </div>
              <span style={{ fontFamily: INTER, fontSize: 44, fontWeight: 500, color: "#202124" }}>
                <TypeText text="dweeb bot" start={d + 108} cps={14} caretColor="#4285f4" />
              </span>
              <svg
                width={32}
                height={32}
                viewBox="0 0 24 24"
                fill="none"
                stroke="#9aa0a6"
                strokeWidth={2.4}
                strokeLinecap="round"
                style={{ position: "absolute", right: 36 }}
              >
                <circle cx={10.5} cy={10.5} r={6.5} />
                <path d="M15.5 15.5L21 21" />
              </svg>
            </div>
          </div>
        </AbsoluteFill>
      </Camera>

      <Sequence from={2} durationInFrames={30}>
        <Audio src={staticFile(IMPACT)} volume={0.85} />
      </Sequence>
      <Sequence from={d + 100} durationInFrames={24}>
        <Audio src={staticFile(CHIME)} volume={0.5} />
      </Sequence>
    </AbsoluteFill>
  );
};
