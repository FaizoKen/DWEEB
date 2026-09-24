import React from "react";
import { Icon } from "../../components/Icon";
import { INTER } from "../../fonts";
import { mixColor, withAlpha } from "../../lib/color";
import { COLORS } from "../../theme";
import { GazeMascot } from "./GazeMascot";
import type { BarGeo, ResultGeo } from "./layout";

/**
 * The outro's action (story lock): a Google-style search bar — the Google G at
 * its start — that types "DWEEB Discord bot" and is sent with the search
 * button (a magnifier) at its far end, then the result it finds. Both are film
 * devices, drawn in world px from the layout table so the pointer's aim
 * (layout.searchButtonCenter) always matches the drawing.
 */

export const QUERY = "DWEEB Discord bot";

/** Inline Google G: self-contained and crisp at any zoom (no font or network). */
const GoogleG: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block" }}>
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

const BTN_REST = "#f8f9fa";
const BTN_HOVER = "#eef0f3";
const BTN_DOWN = "#e1e4e8";
/** Google blue, for the search button's magnifier (it matches the G's blue). */
const SEARCH_BLUE = "#4285f4";
/** Frames the button's ink ripple spreads and fades (it outlives the 4-frame press). */
export const BUTTON_RIPPLE_FRAMES = 12;

export const SearchBar: React.FC<{
  geo: BarGeo;
  /** The query typed so far. */
  typed: string;
  /** Caret drawn this frame (the scene decides solid / blink / gone). */
  caret: boolean;
  /** Pointer over the search button (0–1, eased by the scene). */
  btnHover: number;
  /** 0 → 1 while the search button is held down (the press window), else 0. */
  btnDown: number;
  /** Frames since the search button was pressed while its ripple runs, else null. */
  btnRipple?: number | null;
}> = ({ geo, typed, caret, btnHover, btnDown, btnRipple = null }) => {
  const btnBg = btnDown > 0 ? mixColor(BTN_HOVER, BTN_DOWN, btnDown) : mixColor(BTN_REST, BTN_HOVER, btnHover);
  // The button's own answer to the press (Material's ink ripple, as Google's
  // controls do): a grey disc that spreads across the button and fades. The
  // pointer's ripple alone is a thin ring that barely shows on a white button.
  const ink = btnRipple === null ? null : Math.min(1, btnRipple / BUTTON_RIPPLE_FRAMES);
  return (
    <div
      style={{
        width: geo.w,
        height: geo.h,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        paddingLeft: geo.padL,
        overflow: "hidden",
        borderRadius: 999,
        background: "#fff",
        border: "1px solid rgba(255,255,255,.85)",
        boxShadow: `0 ${geo.h * 0.27}px ${geo.h * 0.8}px rgba(0,0,0,.5), 0 ${geo.h * 0.08}px ${geo.h * 0.3}px ${withAlpha("#4285f4", 0.14)}, inset 0 -1px rgba(0,0,0,.08)`,
        fontFamily: INTER,
      }}
    >
      <GoogleG size={geo.logo} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          marginLeft: geo.padL * 0.62,
          color: "#202124",
          fontSize: geo.font,
          fontWeight: 500,
          letterSpacing: "-.005em",
          whiteSpace: "nowrap",
          display: "flex",
          alignItems: "center",
        }}
      >
        <span>{typed}</span>
        <span
          style={{
            display: "inline-block",
            width: Math.max(1.5, geo.font * 0.085),
            height: geo.font * 1.12,
            marginLeft: geo.font * 0.06,
            borderRadius: 1,
            background: caret ? "#202124" : "transparent",
          }}
        />
      </div>
      {/* The search button: the magnifier in its own segment at the far end. */}
      <div
        style={{
          position: "relative",
          width: geo.btnW,
          alignSelf: "stretch",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderLeft: "1px solid #e2e5e9",
          background: btnBg,
          overflow: "hidden",
        }}
      >
        {ink !== null && ink < 1 && (
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: geo.btnW * 1.5,
              height: geo.btnW * 1.5,
              marginLeft: -geo.btnW * 0.75,
              marginTop: -geo.btnW * 0.75,
              borderRadius: "50%",
              background: "rgba(60,64,67,.2)",
              transform: `scale(${(0.18 + 0.82 * (1 - (1 - ink) ** 3)).toFixed(4)})`,
              opacity: (1 - ink) ** 1.3,
            }}
          />
        )}
        <div
          style={{
            position: "relative",
            transform: btnDown > 0 ? `scale(${(1 - 0.1 * btnDown).toFixed(4)})` : undefined,
          }}
        >
          <Icon name="search" size={geo.btnIcon} color={SEARCH_BLUE} />
        </div>
      </div>
    </div>
  );
};

/**
 * The search's answer, under the bar: the DWEEB favicon and title, then the
 * address — the film's only direct call to action, so it is the card's
 * largest line (≥ 32 canvas px in both masters).
 */
export const ResultCard: React.FC<{ geo: ResultGeo }> = ({ geo }) => (
  <div
    style={{
      width: geo.w,
      boxSizing: "border-box",
      padding: `${geo.pad * 0.86}px ${geo.pad}px ${geo.pad}px`,
      borderRadius: geo.radius,
      background: "linear-gradient(180deg, #1e2129 0%, #16181f 100%)",
      border: "1px solid rgba(255,255,255,.1)",
      boxShadow: `0 ${geo.pad}px ${geo.pad * 2.4}px rgba(0,0,0,.5), inset 0 1px rgba(255,255,255,.06)`,
      fontFamily: INTER,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: geo.fav * 0.34 }}>
      <div
        style={{
          width: geo.fav,
          height: geo.fav,
          flexShrink: 0,
          borderRadius: geo.fav * 0.26,
          overflow: "hidden",
          boxShadow: `0 0 0 1px rgba(255,255,255,.08)`,
        }}
      >
        <GazeMascot size={geo.fav} glow={false} />
      </div>
      <div
        style={{
          fontSize: geo.title,
          lineHeight: 1.2,
          whiteSpace: "nowrap",
          letterSpacing: "-.01em",
          color: "#d7dbe4",
          fontWeight: 500,
        }}
      >
        <span style={{ color: COLORS.text, fontWeight: 800 }}>DWEEB</span> — Visual Discord message builder
      </div>
    </div>
    <div
      style={{
        marginTop: geo.gap,
        display: "flex",
        alignItems: "baseline",
        gap: geo.url * 0.36,
        whiteSpace: "nowrap",
        lineHeight: 1.15,
      }}
    >
      <span
        style={{
          fontSize: geo.url,
          fontWeight: 800,
          letterSpacing: "-.015em",
          color: COLORS.green,
          textShadow: `0 0 ${geo.url * 0.6}px ${withAlpha(COLORS.green, 0.22)}`,
        }}
      >
        dweeb.faizo.net
      </span>
      <span style={{ fontSize: geo.url * 0.8, fontWeight: 700, color: COLORS.textSubtle }}>·</span>
      <span style={{ fontSize: geo.url * 0.8, fontWeight: 700, color: COLORS.text, letterSpacing: "-.01em" }}>
        Start free
      </span>
    </div>
  </div>
);
