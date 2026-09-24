import React from "react";
import { AbsoluteFill, Audio, Easing, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../components/Background";
import { Camera, type Shot, useVertical } from "../components/Camera";
import type { CaptionCue } from "../components/Caption";
import { Cursor, PRESS_FRAMES, cursorAt, cursorOpacity, type Waypoint } from "../components/Cursor";
import { settle } from "../components/Bits";
import { ActivityBar, MetaHeader, StatPills, TreeView } from "../components/editor";
import { CAST, LAUNCH_NIGHT, launchRows, launchState } from "../story/campaign";
import { seqFrom } from "../timeline";
import { SFX_FRAMES, VOL, WHOOSH_SOFT, sfxVariant } from "../audio";
import { COLORS } from "../theme";
import { PORTRAIT_CAM } from "./contracts";
import * as B from "./activity/beats";
import {
  ActivityPortrait,
  ActivityWindowL,
  GEO_L,
  JoinDock,
  LaunchPreview,
  MOBILE_DOCK_W,
  adderIcon,
  launchAdders,
  launchStats,
  launchTreeBox,
} from "./activity/layout";
import {
  ACT_RECT_L,
  ActivityShelfL,
  BOX_V,
  LaunchSplash,
  STAGE_L,
  STRIP_L,
  VOICE_AIMS_L,
  VOICE_AIMS_V,
  VOICE_L,
  VoiceCallV,
  VoiceWindowL,
} from "./activity/voice";

/**
 * BUILD TOGETHER — the coda on the NEXT message ("Launch night"), started the
 * way a team really starts an Activity: from the voice call it is already in.
 * The staff are hanging out in Nebula Gaming's "Staff Lounge" (Aria, Kai,
 * Mira, Theo); Aria clicks the call's rocket ("Start an Activity"), picks
 * DWEEB from the Activities shelf (its own cover art), and after Discord's
 * launch splash the Activity opens right in the call — which is what invites
 * everyone in it. ONE teammate, Kai, joins the editing (Free rooms hold two
 * co-editors; Mira and Theo stay in the call), and the two of them edit at the
 * same time: Kai's outline and avatar land on the Text row while
 * " — Friday!" types itself into the heading, and Aria adds
 * "💡 Suggest a game" from the tree. Presence lives in the dock and on the tree
 * row, never in the preview (the real preview shows none).
 *
 * Landscape: the whole Discord client in the call (channel list with the
 * call's members, Voice Connected, the tiles and the call's control bar);
 * after the launch the camera pushes into the call's focused tile until the
 * Activity fills the frame under the channel's header — the sidebar and the
 * participant strip fall away cleanly — with a small breath in over the last
 * words. Vertical: Discord mobile's call, its Activities sheet, then the
 * Activity full-screen in the same box, on the locked portrait camera.
 */

/* ── Caption ────────────────────────────────────────────────────────────── */

export const captions: CaptionCue[] = [
  {
    id: "activity",
    label: "Discord Activity",
    parts: ["Edit together,", { text: "inside Discord.", hl: true }],
    // In right after the dip, out just after "…in real time" (see beats.ts):
    // the last frames stay clean for the hard cut into the end card.
    from: seqFrom("activity") + B.CAPTION_IN,
    to: seqFrom("activity") + B.CAPTION_OUT,
    accent: COLORS.blurple,
  },
];

/* ── Motion helpers ─────────────────────────────────────────────────────── */

const EASE_UI = Easing.bezier(0.4, 0, 0.2, 1);

/** 0 → 1 over [start, start + dur), eased; exactly 0 before and 1 after. */
const ramp = (frame: number, start: number, dur: number) =>
  frame <= start ? 0 : frame >= start + dur ? 1 : EASE_UI((frame - start) / dur);

/** 0 → 1 → 0 over [start, end): rises over `rise`, falls over `fall`. */
const envelope = (frame: number, start: number, end: number, rise: number, fall: number) =>
  frame <= start || frame >= end ? 0 : Math.min(ramp(frame, start, rise), 1 - ramp(frame, end - fall, fall));

/** A one-shot bump 0 → 1 over `dur` from `start` (the stat pills' tick). */
const bump = (frame: number, start: number, dur = 8) =>
  frame < start || frame >= start + dur ? 0 : (frame - start + 1) / dur;

/* ── Camera ─────────────────────────────────────────────────────────────── */

/** The whole Discord client in the call, afloat on the stage (the editor act's s 1.1 wide). */
const CALL = { x: 960, y: 540, s: 1.1 };
/** A slow drift in while the call plays, still the whole window. */
const CALL_DRIFT = { x: 960, y: 540, s: 1.115 };
/**
 * Pushed into the call's focused tile: the Activity fills the frame, the
 * channel's header ("🔊 Staff Lounge") stays whole along the top, and the
 * sidebar (left) and participant strip (below) fall out of frame entirely.
 */
const ACTIVITY = { x: STAGE_L.x + STAGE_L.w / 2, y: 479, s: 1.42 };
/** "…in real time": a slow breath in, the same four edges still honoured. */
const SETTLED = { ...ACTIVITY, s: 1.435 };
{
  const frameBox = (c: { x: number; y: number; s: number }) => ({
    left: c.x - 960 / c.s,
    right: c.x + 960 / c.s,
    top: c.y - 540 / c.s,
    bottom: c.y + 540 / c.s,
  });
  // The call shots hold the whole client.
  for (const c of [CALL, CALL_DRIFT]) {
    const f = frameBox(c);
    if (f.left > VOICE_L.x - 8 / c.s || f.right < VOICE_L.x + VOICE_L.w + 8 / c.s || f.top > VOICE_L.y - 8 / c.s || f.bottom < VOICE_L.y + VOICE_L.h + 8 / c.s) {
      throw new Error(`S08Activity: call shot s=${c.s} crops the Discord window — keep the whole client in frame.`);
    }
  }
  // The pushed-in shots: the whole Activity, the header's title whole, the
  // sidebar and the participant strip wholly out.
  const HEADER_TEXT_TOP = STAGE_L.y - 36;
  for (const c of [ACTIVITY, SETTLED]) {
    const f = frameBox(c);
    const a = ACT_RECT_L;
    if (f.left > a.x || f.right < a.x + a.w || f.top > a.y || f.bottom < a.y + a.h - 1) {
      throw new Error(`S08Activity: activity shot s=${c.s} crops the Activity.`);
    }
    if (f.left < STAGE_L.x - 0.5 || f.bottom > STRIP_L.y - 2 || f.top > HEADER_TEXT_TOP - 2) {
      throw new Error(`S08Activity: activity shot s=${c.s} slices the sidebar, the strip or the header's title.`);
    }
  }
}

const SHOTS_L: Shot[] = [
  { f: 0, ...CALL },
  { f: B.POINTER_IN, ...CALL },
  { f: B.DWEEB_PRESS, ...CALL_DRIFT },
  { f: B.PUSH_START, ...CALL_DRIFT },
  { f: B.PUSH_END, ...ACTIVITY },
  { f: B.SETTLE_START, ...ACTIVITY },
  { f: B.SETTLE_END, ...SETTLED },
];

/**
 * The portrait stage is filmed with the locked camera; over "in real time" it
 * breathes in by 2 % — about as far as it can go with the whole surface still
 * in frame (its sides reach x 9 / 1074 of 1080) and clear of the caption band.
 */
const SHOTS_V: Shot[] = [
  { f: 0, ...PORTRAIT_CAM },
  { f: B.SETTLE_START, ...PORTRAIT_CAM },
  { f: B.SETTLE_END, ...PORTRAIT_CAM, s: PORTRAIT_CAM.s * 1.02 },
];

/* ── Pointer paths (world px, from the renderers' own geometry) ─────────── */

const beforeAdd = launchState();

function pointerPath(vertical: boolean): { points: Waypoint[]; windows: [number, number][] } {
  const add = adderIcon(launchTreeBox(vertical, beforeAdd, "addButton"), vertical);
  if (vertical) {
    // A finger: it arrives just beside each target, settles, taps, lifts.
    const { rocket, dweeb } = VOICE_AIMS_V;
    return {
      points: [
        { f: B.ROCKET_PRESS - 9, x: rocket.x + 22, y: rocket.y - 30 },
        { f: B.ROCKET_PRESS - 3, x: rocket.x, y: rocket.y },
        { f: B.ROCKET_PRESS, x: rocket.x, y: rocket.y, press: true },
        { f: B.ROCKET_PRESS + 10, x: rocket.x + 10, y: rocket.y - 14 },
        { f: B.DWEEB_PRESS - 10, x: dweeb.x + 26, y: dweeb.y - 24 },
        { f: B.DWEEB_PRESS - 3, x: dweeb.x, y: dweeb.y },
        { f: B.DWEEB_PRESS, x: dweeb.x, y: dweeb.y, press: true },
        { f: B.DWEEB_PRESS + 12, x: dweeb.x + 12, y: dweeb.y - 12 },
        { f: B.ADD_PRESS - 14, x: add.x + 26, y: add.y - 24 },
        { f: B.ADD_PRESS - 5, x: add.x, y: add.y },
        { f: B.ADD_PRESS, x: add.x, y: add.y, press: true },
        { f: B.ADD_PRESS + 14, x: add.x + 12, y: add.y - 12 },
      ],
      windows: [
        [B.ROCKET_PRESS - 9, B.ROCKET_PRESS + 10],
        [B.DWEEB_PRESS - 10, B.DWEEB_PRESS + 12],
        [B.ADD_PRESS - 14, B.ADD_PRESS + 14],
      ],
    };
  }
  // The pointer fades in over the call, glides onto the rocket and waits
  // there for its tooltip; after the click it rises into the shelf that just
  // opened and rests on DWEEB's card (the whole card is the button) until
  // "Invite". Later it comes back for "+ Add button".
  const { rocket, dweeb, rest } = VOICE_AIMS_L;
  const card = { x: dweeb.x + 40, y: dweeb.y + 70 };
  return {
    points: [
      { f: B.POINTER_IN, x: rest.x, y: rest.y },
      { f: B.POINTER_IN + 2, x: rest.x, y: rest.y },
      { f: B.ROCKET_HOVER, x: rocket.x + 3, y: rocket.y + 4 },
      { f: B.ROCKET_PRESS, x: rocket.x + 3, y: rocket.y + 4, press: true },
      { f: B.ROCKET_PRESS + 3, x: rocket.x + 3, y: rocket.y + 4 },
      { f: B.DWEEB_HOVER, x: card.x, y: card.y },
      { f: B.DWEEB_PRESS, x: card.x, y: card.y, press: true },
      { f: B.POINTER_OUT, x: card.x + 70, y: card.y - 60 },
      { f: B.ADD_POINTER_IN, x: add.x + 150, y: add.y + 90 },
      { f: B.ADD_PRESS - 6, x: add.x + 2, y: add.y + 2 },
      { f: B.ADD_PRESS, x: add.x + 2, y: add.y + 2, press: true },
      { f: B.ADD_POINTER_OUT, x: add.x + 70, y: add.y + 70 },
    ],
    windows: [
      [B.POINTER_IN, B.POINTER_OUT],
      [B.ADD_POINTER_IN, B.ADD_POINTER_OUT],
    ],
  };
}

const PATH_L = pointerPath(false);
const PATH_V = pointerPath(true);

/**
 * Kai's keystroke ticks. A key that lands on Aria's click or on her button's
 * pop gives way to it — those two carry the viewer's own action, and they fall
 * on the typing rhythm anyway.
 */
const KEY_TICKS = B.KAI_KEY_FRAMES.filter((f) => Math.abs(f - B.ADD_PRESS) > 1 && Math.abs(f - B.ADDED) > 1);

/* ── Scene ──────────────────────────────────────────────────────────────── */

export const SceneActivity: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const vert = useVertical();

  const spr = (from: number, config: { damping: number; stiffness: number; mass: number }) =>
    frame < from ? 0 : settle(spring({ frame: frame - from, fps, config }));

  // ── The call ──
  const speaking: Record<string, number> = {};
  for (const t of B.TALK) speaking[t.name] = envelope(frame, t.from, t.to, 3, 5);
  const call = 1 - ramp(frame, B.CALL_OUT, 8);
  const rocketHover = frame >= B.ROCKET_HOVER && frame < B.ROCKET_PRESS + PRESS_FRAMES + 2;
  const rocketPressed = frame >= B.ROCKET_PRESS && frame < B.ROCKET_PRESS + PRESS_FRAMES;
  const tooltip = Math.min(ramp(frame, B.TOOLTIP_IN, 5), 1 - ramp(frame, B.TOOLTIP_OUT, 4));

  // ── The shelf → launch ──
  const shelf = Math.min(ramp(frame, B.SHELF_IN, 8), 1 - ramp(frame, B.SHELF_OUT, 5));
  const dweebHover = frame >= B.DWEEB_HOVER && frame < B.DWEEB_PRESS + PRESS_FRAMES;
  const dweebPressed = frame >= B.DWEEB_PRESS && frame < B.DWEEB_PRESS + PRESS_FRAMES;
  // Two layers at a time, never three: the shelf is gone before the splash is
  // up, and the splash stays opaque under the Activity as it dissolves in
  // (it covers the same box), then drops out once the Activity is solid.
  const EDITOR_FADE = 8;
  const editorIn = ramp(frame, B.EDITOR_IN, EDITOR_FADE);
  const splash = frame >= B.EDITOR_IN + EDITOR_FADE ? 0 : ramp(frame, B.SPLASH_IN, 5);
  // The loader's icon, name and bar leave just before the app arrives, so the
  // Activity dissolves in over the bare art, not through the logo.
  const splashContent = 1 - ramp(frame, B.EDITOR_IN - 2, 4);
  const loading = ramp(frame, B.SPLASH_IN + 2, B.EDITOR_IN + 2 - (B.SPLASH_IN + 2));
  const strip = ramp(frame, B.STRIP_IN, 12);

  // ── Kai joins ──
  const kai = spr(B.JOIN, { damping: 13, stiffness: 190, mass: 0.6 });
  const dockGlow = envelope(frame, B.JOIN, B.JOIN + 26, 3, 20);
  const inActivity = { [CAST.aria.name]: ramp(frame, B.EDITOR_IN, 6), [CAST.kai.name]: kai };

  // ── The message: Kai's keystrokes, then Aria's button ──
  const added = frame >= B.ADDED;
  const launch = launchState({ kaiTyped: B.kaiTyped(frame), suggestAdded: added });
  const stats = launchStats(launch);
  // The pills count every keystroke of Kai's live typing; they only bump for
  // Aria's added component (a bump per key would jitter).
  const tick = { components: bump(frame, B.ADDED), chars: bump(frame, B.ADDED) };

  // ── Presence + Aria's add ──
  const rowIn = spr(B.ADDED, { damping: 20, stiffness: 170, mass: 0.7 });
  const btnPop = spr(B.ADDED, { damping: 12, stiffness: 210, mass: 0.55 });
  const rowFlash = envelope(frame, B.ADDED, B.ADDED + 34, 4, 24);
  const btnGlow = envelope(frame, B.ADDED + 2, B.ADDED + 36, 5, 22);
  const adderHover = frame >= B.ADD_PRESS - 6 && frame < B.ADDED;
  const adderPressed = frame >= B.ADD_PRESS && frame < B.ADDED;

  const rows = launchRows(launch);
  const adders = launchAdders(launch);
  const tree = (
    <TreeView
      rows={rows}
      adders={adders}
      selected={added ? LAUNCH_NIGHT.suggest.id : null}
      presence={frame >= B.KAI_FOCUS ? { text: [CAST.kai] } : undefined}
      reveal={added ? { [LAUNCH_NIGHT.suggest.id]: rowIn } : undefined}
      highlight={added ? { [LAUNCH_NIGHT.suggest.id]: rowFlash } : undefined}
      hover={adderHover ? "addButton" : null}
      pressed={adderPressed ? "addButton" : null}
    />
  );
  const preview = (
    <LaunchPreview launch={launch} suggestPop={btnPop} suggestGlow={btnGlow} suggestSelected={added ? 1 : 0} />
  );
  const dock = <JoinDock kai={kai} glow={dockGlow} width={vert ? MOBILE_DOCK_W : undefined} />;

  const path = vert ? PATH_V : PATH_L;
  const pose = cursorAt(frame, path.points);

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={vert ? SHOTS_V : SHOTS_L}>
        {vert ? (
          <>
            {/* Touch has no hover: controls and the card light only under the finger's press. */}
            <VoiceCallV
              speaking={speaking}
              pressed={rocketPressed ? "rocket" : null}
              sheet={shelf}
              dweebPressed={dweebPressed}
              opacity={call}
            />
            <LaunchSplash rect={BOX_V} opacity={splash} progress={loading} content={splashContent} radius={18} scale={1.1} />
            {editorIn > 0.001 && (
              <div style={{ opacity: editorIn < 1 ? editorIn : undefined }}>
                <ActivityPortrait
                  bar={<ActivityBar width={520} channel={LAUNCH_NIGHT.channel} />}
                  preview={preview}
                  pills={<StatPills components={stats.components} chars={stats.chars} tick={tick} />}
                  tree={tree}
                  dock={dock}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <VoiceWindowL
              speaking={speaking}
              inActivity={inActivity}
              call={call}
              hover={rocketHover ? "rocket" : null}
              pressed={rocketPressed ? "rocket" : null}
              tooltip={tooltip}
              strip={strip}
            />
            <LaunchSplash rect={ACT_RECT_L} opacity={splash} progress={loading} content={splashContent} />
            {editorIn > 0.001 && (
              <div style={{ opacity: editorIn < 1 ? editorIn : undefined }}>
                <ActivityWindowL
                  bar={<ActivityBar width={GEO_L.editor.w} channel={LAUNCH_NIGHT.channel} />}
                  meta={<MetaHeader components={stats.components} chars={stats.chars} tick={tick} />}
                  tree={tree}
                  preview={preview}
                  dock={dock}
                />
              </div>
            )}
            <ActivityShelfL reveal={shelf} hover={dweebHover} pressed={dweebPressed} />
          </>
        )}
        <Cursor {...pose} variant={vert ? "touch" : "arrow"} opacity={cursorOpacity(frame, path.windows)} />
      </Camera>

      {/* Sound: the rocket click, starting DWEEB (its click + Discord's launch
          swell), Kai's arrival, his keystrokes (a touch under the UI sounds —
          they are someone else's), Aria's click and her button landing.
          Nothing before the dip's first visible frame. */}
      <Sequence from={B.ROCKET_PRESS} durationInFrames={SFX_FRAMES.click} name="sfx:rocket-click">
        <Audio src={staticFile(sfxVariant("click", 0))} volume={VOL.click} />
      </Sequence>
      <Sequence from={B.DWEEB_PRESS} durationInFrames={SFX_FRAMES.click} name="sfx:start-dweeb">
        <Audio src={staticFile(sfxVariant("click", 2))} volume={VOL.click} />
      </Sequence>
      <Sequence from={B.SPLASH_IN} durationInFrames={SFX_FRAMES["whoosh-soft"]} name="sfx:activity-launch">
        <Audio src={staticFile(WHOOSH_SOFT)} volume={VOL.whooshSoft * 0.8} />
      </Sequence>
      <Sequence from={B.JOIN} durationInFrames={SFX_FRAMES.pop} name="sfx:kai-joins">
        <Audio src={staticFile(sfxVariant("pop", 0))} volume={VOL.pop} />
      </Sequence>
      {KEY_TICKS.map((f, i) => (
        <Sequence key={`tick-${f}`} from={f} durationInFrames={SFX_FRAMES.tick} name={`sfx:kai-key-${i + 1}`}>
          <Audio src={staticFile(sfxVariant("tick", i))} volume={VOL.tick * 0.8} />
        </Sequence>
      ))}
      <Sequence from={B.ADD_PRESS} durationInFrames={SFX_FRAMES.click} name="sfx:add-click">
        <Audio src={staticFile(sfxVariant("click", 1))} volume={VOL.click} />
      </Sequence>
      <Sequence from={B.ADDED} durationInFrames={SFX_FRAMES.pop} name="sfx:suggest-pop">
        <Audio src={staticFile(sfxVariant("pop", 1))} volume={VOL.pop} />
      </Sequence>
    </AbsoluteFill>
  );
};
