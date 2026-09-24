import React from "react";
import { AbsoluteFill, Easing, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, useFilmFrame, useVertical, type Shot } from "../components/Camera";
import type { CaptionCue } from "../components/Caption";
import { Cursor, PRESS_FRAMES, cursorAt, cursorOpacity, type Waypoint } from "../components/Cursor";
import { SendPanel, UiScale } from "../components/editor";
import { PING, SFX_FRAMES, VOL, WHOOSH_SOFT, sfxVariant } from "../audio";
import { CAST, ENTRY_COUNTS, PREVIEW_TIME, REACTIONS, SEND, campaignState } from "../story/campaign";
import { COLORS } from "../theme";
import { SCENES, TRANSITION_FRAMES, at, atAbs, seqFrom } from "../timeline";
import { EDITOR_GLOW, EDITOR_L, EDITOR_V, EDITOR_WIDE_L, PORTRAIT_CAM } from "./contracts";
import { pluginsHold } from "./S06Plugins";
import {
  FloatingCard,
  LandscapeAct,
  PORTRAIT_BOTTOM,
  PORTRAIT_ORIGIN,
  PORTRAIT_SIZE,
  PREVIEW_V,
  PortraitAct,
  Sfx,
  barL,
  barV,
  previewCardL,
  previewCardV,
  pulse,
  ramp,
  springAt,
  type ActFrameProps,
} from "./plugins/act";
import { DiscordLandingL, DiscordLandingV, SLOT_L, SLOT_V, type Delivered } from "./send/landing";

/**
 * WEBHOOK HANDLED / IN YOUR SERVER — "Pick a channel and send. DWEEB handles
 * the webhook. The moment it lands, your giveaway is live."
 *
 * Opens on the plugins scene's last frame (hold cut). Send in the action bar
 * opens "Send message" (a popover under the bar in landscape, a sheet on the
 * phone); # announcements is picked on "Pick a channel" and the toolbar chip
 * takes its name; "✓ Webhook ready · reusing it" lands on "DWEEB handles the
 * webhook"; "Send to webhook" is pressed. Then the message itself makes the
 * trip: the card lifts out of the preview, the editor dissolves around it, it
 * glides into its slot in #announcements as Discord fades in behind it, and
 * lands — with the one PING of the film — on "lands". Kai, a member (his own
 * pointer — a finger tip on the phone — and name flag), clicks 🎉 Enter
 * giveaway on "giveaway is live": the button restamps "(129)" in public and
 * keeps counting as 🎉/🔥 reactions roll in, while the camera eases in on the
 * message.
 */

const T = TRANSITION_FRAMES;

/* ── Beats ──────────────────────────────────────────────────────────────── */

const W = {
  pick: at("send", "Pick"),
  channel: at("send", "channel"),
  dweeb: at("send", "DWEEB"),
  webhookEnd: at("send", "webhook", { edge: "end" }),
  lands: at("send", "lands"),
  giveaway: at("send", "giveaway"),
};

export const SEND_BEATS = (() => {
  const post = W.webhookEnd - 3;
  const land = W.lands - 2;
  const kai = W.giveaway + 1;
  const beats = {
    /** Send in the action bar, just before "Pick". */
    open: W.pick - 3,
    /** # announcements, as "channel" ends. */
    channel: W.channel + 11,
    /** ✓ Webhook ready lands on "DWEEB handles the webhook". */
    status: W.dweeb - 2,
    /** "Send to webhook" as "webhook" ends. */
    post,
    /** The dialog closes. */
    close: post + 1,
    /** Landscape: the card lifts out as the popover closes; the editor is gone
     *  before Discord arrives — never two UIs at once. */
    lift: post + 2,
    editorOut: [post + 3, 8] as const,
    discordIn: [post + 11, 9] as const,
    fly: post + 6,
    /** Portrait: once the sheet is down the card is taken over in place, the
     *  builder sheet slides away uncovering the rest of it, and it glides down
     *  out from under the bar as Discord's own chrome comes in around it. */
    vTake: post + 7,
    vSheet: [post + 7, 9] as const,
    vFly: post + 9,
    vChromeOut: [post + 10, 7] as const,
    vDiscordIn: [post + 15, 8] as const,
    /** The landing (PING) just before "lands". */
    land,
    /** Kai's click on "giveaway is live"; the public count restamps two frames later. */
    kai,
    restamp: kai + 2,
  };
  if (!(beats.open >= T + 6 && beats.channel > beats.open + 14 && beats.status > beats.channel + 12 && beats.post > beats.status + 14 && beats.land >= beats.vFly + 12 && beats.kai > beats.land + 16)) {
    throw new Error(`S07Send: the VO no longer fits the send beats (${JSON.stringify(beats)}) — re-key them.`);
  }
  return beats;
})();
const B = SEND_BEATS;

/**
 * Entry counts restamp after the click, and keep coming (frames after the
 * click). "(129)" — the payoff, Kai's own entry — holds 13 frames before the
 * crowd starts ticking it up, so it is read, not glimpsed.
 */
const COUNT_AT = [2, 15, 21, 27, 34, 42];
/** Reactions roll in behind the entries (pop frame + count steps after the click). */
const REACTION_AT: Record<string, number[]> = { "🎉": [7, 14, 22, 30, 39], "🔥": [13, 21, 29, 38] };

/* ── Layout ─────────────────────────────────────────────────────────────── */

/** The landscape popover: hangs under the bar, right-aligned to Send, clear of the preview card and
 *  above the caption zone (the lead and the picker note are left to the VO and the status line). */
const POP_K = 1.25;
const POP_W = 580;
const POP_RIGHT = barL("send").x + 46; // world x of its right edge
const POP_TOP = barL("send").y + 38; // world y
const TABS = SEND.tabs.filter((t) => t !== "About");

/** SendPanel metrics (k = 1): the card's header, body padding, tabs, timing, title, list padding, rows. */
const POP_ROWS_TOP = 2 + 64 + 20 + 36.5 + 12 + 52 + 12 + 16 + 8;
const ROW_PITCH = 54;
const popRowL = (i: number) => ({ x: POP_RIGHT - 118, y: POP_TOP + (POP_ROWS_TOP + 1 + 8 + 25 + i * ROW_PITCH) * POP_K });
const POP_H = (POP_ROWS_TOP + 176 + 20 + 61) * POP_K;
// Aimed into the primary's right padding (card border + 20 footer padding + ~6), so its label stays readable.
const primaryL = { x: POP_RIGHT - (1 + 20 + 6) * POP_K, y: POP_TOP + POP_H - (1 + 30.5) * POP_K };

/** The portrait sheet: bottom-anchored at the editor's k, the note kept (there is room). */
const SH_K = EDITOR_V.k;
const SH_H = (13 + 53 + 28 + 36.5 + 12 + 52 + 12 + 16 + 8 + 54 + 8 + 176 + 65) * SH_K;
const SH_TOP = PORTRAIT_BOTTOM - SH_H;
const sheetRowV = (i: number) => ({
  x: PORTRAIT_ORIGIN.x + PORTRAIT_SIZE.w - 90,
  y: SH_TOP + (13 + 53 + 14 + 36.5 + 12 + 52 + 12 + 16 + 8 + 54 + 8 + 1 + 8 + 25 + i * ROW_PITCH) * SH_K,
});
// Into the primary's right padding (footer padding 16 + ~11), clear of its label.
const primaryV = { x: PORTRAIT_ORIGIN.x + PORTRAIT_SIZE.w - (1 + 16 + 11) * SH_K, y: PORTRAIT_BOTTOM - (16 + 18) * SH_K };

/* ── The flight ─────────────────────────────────────────────────────────── */

const FLY_EASE = Easing.bezier(0.3, 0, 0.12, 1);
const flyT = (frame: number, vert: boolean) => {
  const start = vert ? B.vFly : B.fly;
  return ramp(frame, start, B.land - start, FLY_EASE);
};
/** Up quickly as it leaves the editor, down as it settles into the channel. */
const liftOf = (frame: number, vert: boolean) =>
  Math.min(ramp(frame, vert ? B.vTake : B.lift, 7), 1 - ramp(frame, B.land - 9, 9)) * (vert ? 0.6 : 1);
/** Portrait: the builder sheet's slide (1 = in place) and the world-y of its top edge. */
const builderIn = (frame: number) => 1 - ramp(frame, B.vSheet[0], B.vSheet[1]);
const BAR_BOTTOM_V = PORTRAIT_ORIGIN.y + 1 + 52 * EDITOR_V.barK;
const builderTopV = (frame: number) =>
  PORTRAIT_ORIGIN.y + 1 + EDITOR_V.sheetTop + (1 - builderIn(frame)) * (PORTRAIT_SIZE.h - EDITOR_V.sheetTop + 40);

/**
 * Portrait: while the Send sheet rises (the dim covers all but the preview's
 * top band) the preview settles back toward the top from the plugins scene's
 * button view — so when the card lifts off, its slot in the channel is half
 * as far away and the flight stays a glide (≈20 canvas px/frame at its peak).
 *
 * It stops just short of the top: the sheet's top edge sits at surface y 190
 * (measured on a full-scale still; the panel is content-sized), and at scroll
 * 0 the finished card's body ends at 194.5 with the gallery from 204
 * (contracts.ts) — so the edge would shave the body's descenders. Resting
 * REST_SCROLL_V down centres that gap on the edge instead.
 */
const SEND_SHEET_TOP_V = 190;
const BODY_GAP_V = { top: 194.5, bottom: 204 };
const REST_SCROLL_V = Math.round((BODY_GAP_V.top + BODY_GAP_V.bottom) / 2 - SEND_SHEET_TOP_V);
const previewScrollV = (frame: number) => REST_SCROLL_V + (PREVIEW_V - REST_SCROLL_V) * (1 - ramp(frame, B.open + 1, 22));

/* ── State ──────────────────────────────────────────────────────────────── */

function sendFrame(frame: number, vert: boolean, film: number): ActFrameProps & { editorOn: boolean } {
  const base = pluginsHold(vert, film);
  const picked = frame >= B.channel;
  const panel = frame < B.close ? ramp(frame, B.open + 1, 9) : 1 - ramp(frame, B.close, 6);
  const statusIn = ramp(frame, B.status, 8);
  const sendPanel =
    panel > 0.001 ? (
      <SendPanel
        layout={vert ? "sheet" : "popover"}
        tabs={TABS}
        lead={false}
        note={vert}
        selected={picked ? "announcements" : null}
        hover={!picked && frame >= B.channel - 7 ? "announcements" : null}
        pressed={frame >= B.channel && frame < B.channel + PRESS_FRAMES ? "announcements" : null}
        statusReveal={{ announcements: statusIn, general: statusIn, events: statusIn }}
        primaryHover={frame >= B.post - 30 && frame < B.post + PRESS_FRAMES}
        primaryPressed={frame >= B.post && frame < B.post + PRESS_FRAMES}
        primaryGlow={pulse(frame, B.status + 8, B.post + 2, 8, 6) * 0.8}
        reveal={panel}
      />
    ) : undefined;
  const editorOut = vert ? ramp(frame, B.vChromeOut[0], B.vChromeOut[1], (t) => t) : ramp(frame, B.editorOut[0], B.editorOut[1], (t) => t);
  const bar = {
    ...base.bar,
    channel: picked ? "announcements" : null,
    pressed: frame >= B.open && frame < B.open + PRESS_FRAMES ? ("send" as const) : null,
    // Lit only once the pointer is on it (it arrives a frame before the press).
    hover: frame >= B.open - 2 && frame < B.open + PRESS_FRAMES ? ("send" as const) : null,
    glow: { channel: pulse(frame, B.channel, B.channel + 40, 6, 18) },
  };
  return {
    ...base,
    bar,
    // The card flies as its own copy: the editor stops drawing it at the take-over.
    previewHidden: frame >= (vert ? B.vTake : B.lift),
    preview: vert ? { ...base.preview, scroll: previewScrollV(frame) } : base.preview,
    opacity: 1 - editorOut,
    ...(vert
      ? { sheet: sendPanel, scrim: panel, assembly: frame >= B.vSheet[0] ? { sheet: builderIn(frame) } : undefined }
      : {
          overlay: sendPanel ? (
            <div
              style={{
                position: "absolute",
                left: POP_RIGHT - POP_W - EDITOR_L.x - 1,
                top: POP_TOP - EDITOR_L.y - 1,
                width: POP_W,
              }}
            >
              <UiScale k={POP_K}>{sendPanel}</UiScale>
            </div>
          ) : undefined,
        }),
    editorOn: editorOut < 1,
  };
}

/** The delivered message in the channel at a frame: the public count, the hover/press, the reactions. */
function delivered(frame: number, hidden: boolean): Delivered {
  const k = frame - B.kai;
  const countIdx = COUNT_AT.filter((d) => k >= d).length - 1;
  const reactions = REACTIONS.map((r) => {
    const steps = REACTION_AT[r.emoji];
    const n = steps.filter((d) => k >= d).length;
    return { emoji: r.emoji, count: r.counts[Math.max(0, n - 1)], pop: n > 0 ? springAt(frame, B.kai + steps[0], { damping: 12, mass: 0.5, stiffness: 190 }) : 0 };
  });
  return {
    hidden,
    card: {
      state: campaignState("attached"),
      count: countIdx >= 0 ? ENTRY_COUNTS[countIdx] : undefined,
      hover: frame >= B.kai - 6 && frame < B.kai + PRESS_FRAMES + 2 ? "giveaway" : null,
      pressed: frame >= B.kai && frame < B.kai + PRESS_FRAMES ? "giveaway" : null,
      glow: { giveaway: pulse(frame, B.restamp, B.restamp + 30, 4, 18) * 0.85 },
    },
    reactions: reactions.filter((r) => r.pop > 0),
  };
}

/* ── Pointers ───────────────────────────────────────────────────────────── */

const sendBtnL = barL("send");
const annL = popRowL(0);
/** Landscape: in from below the bar onto Send's icon, down to # announcements, then to "Send to webhook". */
const POINTER_L: Waypoint[] = [
  { f: T + 2, x: sendBtnL.x + 30, y: sendBtnL.y + 52 },
  { f: B.open - 1, x: sendBtnL.x - 16, y: sendBtnL.y + 2 },
  { f: B.open, x: sendBtnL.x - 16, y: sendBtnL.y + 2, press: true },
  { f: B.channel - 1, x: annL.x, y: annL.y },
  { f: B.channel, x: annL.x, y: annL.y, press: true },
  // Off the row before its status lands, so the ✓ never appears under the pointer.
  { f: B.channel + 20, x: primaryL.x + 30, y: primaryL.y + 34 },
  { f: B.post - 8, x: primaryL.x + 24, y: primaryL.y + 22 },
  { f: B.post - 1, x: primaryL.x, y: primaryL.y },
  { f: B.post, x: primaryL.x, y: primaryL.y, press: true },
];
const POINTER_L_ON: [number, number][] = [[T + 2, B.post + 9]];

const sendBtnV = barV("send");
const annV = sheetRowV(0);
/** Portrait: a finger comes down on each target (it fades in on the spot, taps, lifts). */
const TOUCH_V: Waypoint[] = [
  { f: B.open - 6, x: sendBtnV.x - 14, y: sendBtnV.y },
  { f: B.open, x: sendBtnV.x - 14, y: sendBtnV.y, press: true },
  { f: B.channel - 6, x: annV.x, y: annV.y },
  { f: B.channel, x: annV.x, y: annV.y, press: true },
  { f: B.post - 6, x: primaryV.x, y: primaryV.y },
  { f: B.post, x: primaryV.x, y: primaryV.y, press: true },
];
const TOUCH_V_ON: [number, number][] = [
  // Never on screen at the cut frame itself: the hold cut shows no pointer.
  [Math.max(T + 1, B.open - 6), B.open + 8],
  [B.channel - 6, B.channel + 8],
  // Lifts as the sheet goes down, never lingering over the editor it uncovers.
  [B.post - 6, B.post + 6],
];

/**
 * Kai presses the button's LEFT third — over 🎉 / "Enter", a little above
 * centre — because "(129)" is stamped on its RIGHT end two frames after the
 * click: nothing of his (pointer, ripple, name flag) may sit there then.
 * Measured on the delivered card (full-scale stills, world px):
 *   landscape — button SLOT_L.x + 401…576 (…620 once counted), y SLOT_L.y + 511…545;
 *               🎉 ends at +442, "Enter" from +448, "(129)" at +568…604;
 *   portrait  — button SLOT_V.x + 73…230 (…269 counted), y SLOT_V.y + 420…452;
 *               🎉 ends at +111, "Enter" from +116, "(129)" at +223…255.
 * Landscape: the member arrow comes in from the empty channel space on the
 * right, presses (its flag hangs below-right, under "Enter" — the label's
 * glyphs stay clear) and leaves down-left once the button is released.
 * Portrait: phones have no pointer, so Kai is a member-coloured finger tip
 * that comes down on the spot and lifts, like every touch in the vertical cut;
 * its flag hangs ABOVE the button (a finger covers what is below a tap).
 */
const buttonAim = (vert: boolean) => (vert ? { x: SLOT_V.x + 113, y: SLOT_V.y + 431 } : { x: SLOT_L.x + 442, y: SLOT_L.y + 519 });
const kaiPath = (vert: boolean): Waypoint[] => {
  const b = buttonAim(vert);
  return vert
    ? [
        { f: B.kai - 6, x: b.x, y: b.y },
        { f: B.kai, x: b.x, y: b.y, press: true },
      ]
    : [
        { f: B.kai - 20, x: b.x + 240, y: b.y + 60 },
        { f: B.kai - 1, x: b.x, y: b.y },
        { f: B.kai, x: b.x, y: b.y, press: true },
        { f: B.kai + 5, x: b.x, y: b.y },
        { f: B.kai + 16, x: b.x - 70, y: b.y + 64 },
      ];
};
const KAI_ON = (vert: boolean): [number, number][] => [vert ? [B.kai - 6, B.kai + 8] : [B.kai - 20, B.kai + 14]];

/* ── Camera ─────────────────────────────────────────────────────────────── */

/**
 * After Kai's click the camera eases in on the message. Landscape: 1.28× with
 * the channel header (and the rail's top icon) cleanly above the frame, the
 * composer whole at the bottom, the whole window width still in, and the
 * message right of the caption. Portrait: a 3% push
 * that keeps the view's top edge under the caption band.
 */
const SHOTS_L: Shot[] = [
  { f: T, ...EDITOR_WIDE_L },
  { f: B.kai + 6, ...EDITOR_WIDE_L },
  { f: B.kai + 40, x: 980, y: 575, s: 1.28 },
];
const PUSH_V = 2.06;
const SHOTS_V: Shot[] = [
  { f: T, ...PORTRAIT_CAM },
  { f: B.kai + 6, ...PORTRAIT_CAM },
  { f: B.kai + 40, x: PORTRAIT_CAM.x, y: PORTRAIT_ORIGIN.y + (PORTRAIT_CAM.y - PORTRAIT_ORIGIN.y) * (PORTRAIT_CAM.s / PUSH_V), s: PUSH_V },
];

/* ── Sound ──────────────────────────────────────────────────────────────── */

/* ── Captions ───────────────────────────────────────────────────────────── */

const SEQ = seqFrom("send");
const LAND_ABS = SEQ + B.land;
export const captions: CaptionCue[] = [
  {
    id: "send-webhook",
    label: "Webhook handled",
    parts: ["Pick a channel.", { text: "Hit send.", hl: true, at: atAbs("send", "send") }],
    from: atAbs("send", "Pick", { offset: -2 }),
    // Out before the landing: its fade ends on the landing frame.
    to: LAND_ABS,
    accent: COLORS.blurple,
  },
  {
    id: "send-server",
    label: "In your server",
    parts: ["Posted —", { text: "and the giveaway is live.", hl: true }],
    from: LAND_ABS + 4,
    // Holds into the dip; out before the activity scene's super comes in.
    to: SCENES.activity.from + 4,
    accent: COLORS.green,
  },
];

/* ── Scene ──────────────────────────────────────────────────────────────── */

export const SceneSend: React.FC = () => {
  const frame = useCurrentFrame();
  const film = useFilmFrame();
  const vert = useVertical();
  const { editorOn, ...act } = sendFrame(frame, vert, film);

  // The flight: from the preview's rect to the channel slot.
  const from = vert ? previewCardV(previewScrollV(frame)) : previewCardL();
  const to = vert ? SLOT_V : SLOT_L;
  const inAir = frame >= (vert ? B.vTake : B.lift) && frame < B.land;
  const t = flyT(frame, vert);
  const discordIn = vert
    ? ramp(frame, B.vDiscordIn[0], B.vDiscordIn[1], (x) => x)
    : ramp(frame, B.discordIn[0], B.discordIn[1], (x) => x);
  // The card as it leaves the editor: the preview's own time label until it lands in Discord.
  const flying = { state: campaignState("attached"), time: PREVIEW_TIME };
  const Landing = vert ? DiscordLandingV : DiscordLandingL;

  return (
    <AbsoluteFill>
      <Background glow={EDITOR_GLOW} />
      <Camera shots={vert ? SHOTS_V : SHOTS_L}>
        {discordIn > 0.001 && <Landing delivered={delivered(frame, inAir)} opacity={discordIn} />}
        {editorOn && (vert ? <PortraitAct {...act} /> : <LandscapeAct {...act} />)}
        {inAir && (
          <FloatingCard
            x={from.x + (to.x - from.x) * t}
            y={from.y + (to.y - from.y) * t}
            width={from.w}
            dk={vert ? EDITOR_V.dk : EDITOR_L.dk}
            lift={liftOf(frame, vert)}
            // Portrait: shown only where the editor showed it — under the bar, above the
            // builder sheet — so the take-over is invisible and the sheet uncovers the rest.
            clip={vert ? { top: BAR_BOTTOM_V, bottom: builderTopV(frame) } : undefined}
            preview={flying}
          />
        )}
        {vert ? (
          <Cursor variant="touch" {...cursorAt(frame, TOUCH_V)} opacity={cursorOpacity(frame, TOUCH_V_ON)} />
        ) : (
          <Cursor {...cursorAt(frame, POINTER_L)} opacity={cursorOpacity(frame, POINTER_L_ON)} />
        )}
        <Cursor
          {...(vert ? ({ variant: "member-touch", flag: "above-right" } as const) : ({ variant: "member" } as const))}
          name={CAST.kai.name}
          color={CAST.kai.color}
          {...cursorAt(frame, kaiPath(vert))}
          opacity={cursorOpacity(frame, KAI_ON(vert))}
        />
      </Camera>

      <Sfx from={B.open} src={sfxVariant("click", 0)} frames={SFX_FRAMES.click} volume={VOL.click} />
      <Sfx from={B.open + 1} src={sfxVariant("pop", 2)} frames={SFX_FRAMES.pop} volume={VOL.pop} />
      <Sfx from={B.channel} src={sfxVariant("click", 1)} frames={SFX_FRAMES.click} volume={VOL.click} />
      <Sfx from={B.status} src={sfxVariant("pop", 0)} frames={SFX_FRAMES.pop} volume={VOL.pop * 0.75} />
      <Sfx from={B.post} src={sfxVariant("click", 2)} frames={SFX_FRAMES.click} volume={VOL.click * 1.15} />
      <Sfx from={vert ? B.vTake : B.lift} src={WHOOSH_SOFT} frames={SFX_FRAMES["whoosh-soft"]} volume={VOL.whooshSoft * 0.7} />
      <Sfx from={B.land} src={PING} frames={SFX_FRAMES.ping} volume={VOL.ping} />
      <Sfx from={B.kai} src={sfxVariant("click", 0)} frames={SFX_FRAMES.click} volume={VOL.click} />
      <Sfx from={B.kai + REACTION_AT["🎉"][0]} src={sfxVariant("pop", 1)} frames={SFX_FRAMES.pop} volume={VOL.pop * 0.8} />
      <Sfx from={B.kai + REACTION_AT["🔥"][0]} src={sfxVariant("pop", 2)} frames={SFX_FRAMES.pop} volume={VOL.pop * 0.7} />
    </AbsoluteFill>
  );
};
