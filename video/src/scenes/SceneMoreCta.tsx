import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot } from "../components/Camera";
import { Mascot } from "../components/Mascot";
import { Wordmark } from "../components/Wordmark";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { TICK } from "../timeline";

const CTA_AT = 104;
const TYPE_FROM = 176;
const QUERY = "dweeb";

/** The multicolour Google "G" mark. */
const GoogleG: React.FC<{ size?: number }> = ({ size = 32 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48">
    <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
    <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
    <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
    <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
  </svg>
);

const FEATURES = [
  { label: "Schedule posts", icon: "clock", c: COLORS.blurple },
  { label: "A.I. assistant", icon: "ai", c: COLORS.green },
  { label: "Share links", icon: "share", c: COLORS.blurple },
  { label: "Restore & edit", icon: "history", c: COLORS.warning },
  { label: "Components V2", icon: "blocks", c: COLORS.green },
  { label: "Never-expire", icon: "infinity", c: COLORS.blurple },
  { label: "Webhook manager", icon: "webhook", c: COLORS.green },
  { label: "Import / Export", icon: "swap", c: COLORS.warning },
  { label: "Private by design", icon: "lock", c: COLORS.green },
  { label: "Templates", icon: "template", c: COLORS.blurple },
] as const;

const sx = { fill: "none", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const FIC: Record<string, (c: string) => React.ReactNode> = {
  clock: (c) => (<svg width="20" height="20" viewBox="0 0 24 24" stroke={c} {...sx}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3.2 2" /></svg>),
  ai: (c) => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9L5.3 10.2l4.9-1.8z" fill={c} /><path d="M18.6 4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" fill={c} opacity="0.7" /></svg>),
  share: (c) => (<svg width="20" height="20" viewBox="0 0 24 24" stroke={c} {...sx}><circle cx="6" cy="12" r="2.4" /><circle cx="17" cy="6" r="2.4" /><circle cx="17" cy="18" r="2.4" /><path d="M8.2 10.9l6.6-3.7M8.2 13.1l6.6 3.7" /></svg>),
  history: (c) => (<svg width="20" height="20" viewBox="0 0 24 24" stroke={c} {...sx}><path d="M4 9a8 8 0 1 1-1.2 4.4" /><path d="M3 5v4h4" /><path d="M12 8.5v4l2.8 1.7" /></svg>),
  blocks: (c) => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none">{[[4, 4], [13, 4], [4, 13], [13, 13]].map(([x, y], i) => (<rect key={i} x={x} y={y} width="7" height="7" rx="2.1" fill={i === 0 ? c : `${c}33`} stroke={c} strokeWidth="1.5" />))}</svg>),
  infinity: (c) => (<svg width="20" height="20" viewBox="0 0 24 24" stroke={c} {...sx}><path d="M7.2 12c0-1.7 1.3-3 2.9-3 2.4 0 3.4 6 5.8 6 1.6 0 2.9-1.3 2.9-3s-1.3-3-2.9-3c-2.4 0-3.4 6-5.8 6-1.6 0-2.9-1.3-2.9-3z" /></svg>),
  webhook: (c) => (<svg width="20" height="20" viewBox="0 0 24 24" stroke={c} {...sx}><circle cx="12" cy="6.5" r="2.6" /><path d="M12 9.1v4.4" /><circle cx="6.8" cy="17" r="2.4" /><circle cx="17.2" cy="17" r="2.4" /><path d="M12 13.5l-3.2 1.8M12 13.5l3.2 1.8" /></svg>),
  swap: (c) => (<svg width="20" height="20" viewBox="0 0 24 24" stroke={c} {...sx}><path d="M4.5 8.5h13l-3.4-3.4" /><path d="M19.5 15.5h-13l3.4 3.4" /></svg>),
  lock: (c) => (<svg width="20" height="20" viewBox="0 0 24 24" stroke={c} {...sx}><rect x="5" y="10.5" width="14" height="9" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></svg>),
  template: (c) => (<svg width="20" height="20" viewBox="0 0 24 24" stroke={c} {...sx}><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M4 9h16M9 9v11" /></svg>),
};

// CTA world anchors.
const MASCOT = { x: 960, y: 300 };
const WORD = { x: 960, y: 470 };
const HEAD = { x: 960, y: 596 };
const BAR = { x: 960, y: 716 };
const SUB = { x: 960, y: 818 };

export const SceneMoreCta: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const moreOut = interpolate(frame, [CTA_AT - 16, CTA_AT], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ctaIn = interpolate(frame, [CTA_AT - 4, CTA_AT + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Camera: drift+push through the feature chips, then settle on the lockup, then
  // push into the Google search bar as the query types, then ease back to rest.
  const shots: Shot[] = [
    { f: 0, x: 960, y: 500, s: 0.95 },
    { f: CTA_AT - 6, x: 960, y: 480, s: 1.0 },
    { f: CTA_AT + 14, x: 960, y: 470, s: 0.95, ease: Easing.bezier(0.4, 0, 0.1, 1) },
    { f: TYPE_FROM - 10, x: 960, y: 480, s: 0.95 },
    { f: TYPE_FROM + 18, x: 960, y: 706, s: 1.1 },
    { f: 250, x: 960, y: 590, s: 0.9, ease: Easing.bezier(0.4, 0, 0.1, 1) },
    { f: 294, x: 960, y: 590, s: 0.9 },
  ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />

      <Camera shots={shots} drift={2} blur={1}>
        {/* Beat A — "it's a whole toolkit" */}
        {frame < CTA_AT + 4 && (
          <div style={{ position: "absolute", inset: 0, opacity: moreOut, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 44 }}>
            {(() => {
              const head = spring({ frame: frame - 2, fps, config: { damping: 18, mass: 0.7 } });
              return (
                <div style={{ opacity: head, transform: `translateY(${interpolate(head, [0, 1], [24, 0])}px)`, textAlign: "center" }}>
                  <div style={{ fontFamily: INTER, fontWeight: 800, fontSize: 56, color: COLORS.text, lineHeight: 1.08 }}>
                    Way <span style={{ color: COLORS.green }}>more</span> than messages.
                  </div>
                  <div style={{ fontFamily: INTER, fontWeight: 600, fontSize: 27, color: COLORS.textMuted, marginTop: 14 }}>
                    A whole toolkit for your server — all in one place.
                  </div>
                </div>
              );
            })()}

            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 15, maxWidth: 1280 }}>
              {FEATURES.map((f, i) => {
                const p = spring({ frame: frame - 16 - i * 3.5, fps, config: { damping: 14, mass: 0.6, stiffness: 130 } });
                const float = Math.sin((frame + i * 30) / 26) * 4;
                return (
                  <div
                    key={f.label}
                    style={{
                      transform: `translateY(${interpolate(p, [0, 1], [40, 0]) + float}px) scale(${p})`,
                      opacity: p,
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      background: COLORS.bgElevated,
                      border: `1px solid ${f.c}3a`,
                      borderRadius: 999,
                      padding: "12px 24px 12px 14px",
                      fontFamily: INTER,
                      fontWeight: 700,
                      fontSize: 25,
                      color: COLORS.text,
                      boxShadow: "0 12px 30px rgba(0,0,0,0.4)",
                    }}
                  >
                    <span style={{ display: "flex", width: 34, height: 34, borderRadius: 10, background: `${f.c}22`, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {FIC[f.icon](f.c)}
                    </span>
                    {f.label}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Beat B — CTA */}
        {frame >= CTA_AT - 6 && <Cta opacity={ctaIn} />}
      </Camera>

      {/* type ticks */}
      {QUERY.split("").map((_, i) => (
        <Sequence key={i} from={Math.round(TYPE_FROM + 4 + i * 6)} durationInFrames={6}>
          <Audio src={staticFile(TICK)} volume={0.45} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

const Cta: React.FC<{ opacity: number }> = ({ opacity }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame - CTA_AT;

  const mascot = spring({ frame: t, fps, config: { damping: 13, mass: 0.8 } });
  const head = spring({ frame: t - 18, fps, config: { damping: 16 } });
  const barIn = spring({ frame: t - 34, fps, config: { damping: 15, mass: 0.7 } });
  const typed = interpolate(frame, [TYPE_FROM + 4, TYPE_FROM + 4 + QUERY.length * 6], [0, QUERY.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const caretOn = Math.floor(frame / 8) % 2 === 0;
  const glow = 0.5 + 0.5 * Math.sin(frame / 9);
  const subIn = spring({ frame: t - 60, fps, config: { damping: 200 } });

  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      {/* mascot */}
      <div style={{ position: "absolute", left: MASCOT.x, top: MASCOT.y, transform: `translate(-50%,-50%) scale(${interpolate(mascot, [0, 1], [0.4, 1])})`, opacity: mascot }}>
        <Mascot size={150} />
      </div>

      {/* wordmark */}
      <div style={{ position: "absolute", left: WORD.x, top: WORD.y, transform: "translate(-50%,-50%)" }}>
        <Wordmark size={104} delay={CTA_AT + 2} />
      </div>

      {/* headline */}
      <div
        style={{
          position: "absolute",
          left: HEAD.x,
          top: HEAD.y,
          transform: `translate(-50%,-50%) translateY(${interpolate(head, [0, 1], [18, 0])}px)`,
          opacity: head,
          fontFamily: INTER,
          fontWeight: 800,
          fontSize: 46,
          color: COLORS.text,
          whiteSpace: "nowrap",
        }}
      >
        Every feature, <span style={{ color: COLORS.green }}>completely free</span>.
      </div>

      {/* google search */}
      <div
        style={{
          position: "absolute",
          left: BAR.x,
          top: BAR.y,
          transform: `translate(-50%,-50%) scale(${interpolate(barIn, [0, 1], [0.8, 1])})`,
          opacity: barIn,
          width: 720,
          height: 74,
          background: "#fff",
          borderRadius: 999,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "0 26px",
          boxSizing: "border-box",
          boxShadow: `0 10px 40px rgba(0,0,0,0.45), 0 0 ${20 + glow * 36}px ${COLORS.blurple}${Math.round(glow * 70 + 40).toString(16)}`,
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke="#9aa0a6" strokeWidth="2.4" />
          <path d="M16.5 16.5L21 21" stroke="#9aa0a6" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
        <div style={{ flex: 1, fontFamily: INTER, fontWeight: 500, fontSize: 32, color: "#202124", display: "flex", alignItems: "center" }}>
          {QUERY.slice(0, Math.floor(typed))}
          <span style={{ display: "inline-block", width: 3, height: 34, marginLeft: 2, background: "#202124", opacity: caretOn && typed < QUERY.length ? 1 : 0 }} />
        </div>
        <GoogleG size={34} />
      </div>

      {/* subline */}
      <div
        style={{
          position: "absolute",
          left: SUB.x,
          top: SUB.y,
          transform: "translate(-50%,-50%)",
          opacity: subIn,
          fontFamily: INTER,
          fontWeight: 700,
          fontSize: 28,
          color: COLORS.text,
          whiteSpace: "nowrap",
        }}
      >
        Just search <span style={{ color: COLORS.green }}>“dweeb”</span> on Google →
      </div>
    </div>
  );
};
