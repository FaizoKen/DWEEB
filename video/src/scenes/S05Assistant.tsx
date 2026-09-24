import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { typedChars } from "../components/Bits";
import { Camera, useVertical } from "../components/Camera";
import { CAPTION_EXIT_FRAMES, type CaptionCue } from "../components/Caption";
import { requiredLegibleFrames } from "../components/CaptionTrack";
import { Cursor, PRESS_FRAMES, cursorAt, cursorOpacity, type Waypoint } from "../components/Cursor";
import { CHIME, SFX_FRAMES, VOL, sfxVariant } from "../audio";
import { AI, campaignState } from "../story/campaign";
import { FPS, SCENES, TRANSITION_FRAMES, at, atAbs, seqFrom } from "../timeline";
import { EDITOR_GLOW, EDITOR_WIDE_L, PORTRAIT_CAM } from "./contracts";
import {
  AI_SHEET_H,
  AI_SHEET_H_APPLIED,
  DOCK_FRAMES,
  FAB_L,
  LandscapeAct,
  PortraitAct,
  Sfx,
  aiSheetV,
  dockL,
  pulse,
  ramp,
  springAt,
  TREE_V_PRE,
  type ActFrameProps,
} from "./plugins/act";

/**
 * AI ASSISTANT — "Got another idea? Ask the AI assistant to add it directly to
 * the message."
 *
 * One continuous take from cut B (the personalised message, contracts.ts):
 * landscape clicks the preview's sparkle FAB and the docked AI column slides
 * in beside the preview (which narrows, as the product's grid does); portrait
 * raises the phone's assistant over the lower editor. The prompt is TYPED in
 * the composer, sent as a bubble, the dots think, the reply streams in on
 * "add it directly", and as "directly" ends the edit lands: "✦ Updated the
 * message · Undo", the rewritten opening washed green in the preview, the
 * blurple 🎉 Enter giveaway popping in beside the others, the tree growing its
 * new Button row and the stat pills ticking to 9 / 202. The scene ends on the
 * resting conversation — the plugins scene opens on that exact frame.
 */

const T = TRANSITION_FRAMES;

/* ── Beats (scene-local frames, keyed to the VO) ────────────────────────── */

const W = {
  got: at("assistant", "Got"),
  assistantEnd: at("assistant", "assistant", { edge: "end" }),
  add: at("assistant", "add"),
  directlyEnd: at("assistant", "directly", { edge: "end" }),
};

/** ~32 characters per second: fast, but a viewer can read along. */
const TYPE_CPS = 32;
const TYPE_FRAMES = Math.ceil((AI.prompt.length * FPS) / TYPE_CPS);

export const ASSIST = (() => {
  // The dock opens right as the VO asks "Got another idea?".
  const fab = W.got - 3;
  const open = fab + 1;
  // Sent as "assistant" ends, so the typing fills "Ask the AI assistant".
  const send = W.assistantEnd - 12;
  const type = send - 3 - TYPE_FRAMES;
  const beats = {
    fab,
    open,
    type,
    send,
    sent: send + 1,
    // The Stop button replaces send once thinking starts — the pointer has left it by then.
    think: send + 7,
    /** The reply streams in over "add it directly"… */
    reply: W.add - 2,
    /** …and the edit lands as the stream (and "directly") ends — the product applies
     *  the AI's JSON when its stream completes. The chime rings in the pause after. */
    apply: W.directlyEnd - 1,
    chime: W.directlyEnd,
  };
  if (!(beats.fab > T && beats.type >= beats.open + DOCK_FRAMES + 2 && beats.reply > beats.think + 8 && beats.apply > beats.reply + 14)) {
    throw new Error(`S05Assistant: the VO no longer fits the assistant beats (${JSON.stringify(beats)}) — re-key them.`);
  }
  return beats;
})();

/** Caret blink (the product's 1 s steps(2) blink ≈ 15 frames on / off). */
const blinkOn = (frame: number, since: number) => Math.floor((frame - since) / 15) % 2 === 0;

/**
 * Portrait: the AI's 🎉 Enter giveaway pops in UNDER the assistant sheet, so
 * it is first seen only when the plugins scene slides the sheet away and
 * scrolls the button rows up. The product's blurple glow barely reads on the
 * blurple fill, so that first sighting gets a bright periwinkle halo: held at
 * `hidden` strength from the pop through the cut (a constant — both sides of
 * the assistant → plugins hold cut agree), swelled by the plugins scene as
 * the button comes into view (S06Plugins newButtonGlowV).
 */
export const NEW_BUTTON_GLOW_V = { color: "#b8bfff", hidden: 0.5 } as const;

/** The assistant's state at a scene frame (shared by both aspects). */
function assistantFrame(frame: number, vert: boolean): ActFrameProps {
  const b = ASSIST;
  const applied = frame >= b.apply;
  const state = campaignState(applied ? "final" : "select");
  const typed = Math.min(AI.prompt.length, typedChars(frame, b.type, TYPE_CPS, FPS));
  const typing = frame >= b.type && typed < AI.prompt.length;
  const focused = frame >= b.open + DOCK_FRAMES && frame < b.sent;
  // The reply streams at a reading pace and completes on the apply frame.
  const streamed = Math.min(AI.reply.length, Math.ceil((AI.reply.length * (frame - b.reply + 1)) / (b.apply - b.reply)));

  const pop = springAt(frame, b.apply, { damping: 12, mass: 0.55, stiffness: 170 });
  // Landscape sees the button pop, so its glow is a pulse; in portrait the
  // button is still under the sheet, so its halo is held until the plugins
  // scene uncovers it on "that button" (a constant across the cut).
  const glow = vert ? NEW_BUTTON_GLOW_V.hidden * ramp(frame, b.apply, 8) : pulse(frame, b.apply, b.apply + 36, 6, 18);
  const tick = pulse(frame, b.apply, b.apply + 14, 4, 9);

  return {
    state,
    pills: { tick: { components: tick, chars: tick } },
    tree: {
      // Portrait: once the AI sheet covers the builder sheet, its tree is
      // scrolled (unseen) to the button family the plugins scene reveals.
      scroll: vert && frame >= b.open + DOCK_FRAMES + 4 ? TREE_V_PRE : 0,
      reveal: { giveaway: applied ? springAt(frame, b.apply, { damping: 18, stiffness: 150 }) : 1 },
      highlight: { giveaway: pulse(frame, b.apply, b.apply + 40, 6, 22), text: pulse(frame, b.apply, b.apply + 34, 6, 20) },
    },
    preview: {
      pop: { giveaway: applied ? pop : 1 },
      glow: { giveaway: glow },
      glowColor: vert ? { giveaway: NEW_BUTTON_GLOW_V.color } : undefined,
      bodyHighlight: ramp(frame, b.apply + 1, 16, (t) => t),
    },
    sparklePressed: !vert && frame >= b.fab && frame < b.fab + PRESS_FRAMES,
    ai: {
      reveal: ramp(frame, b.open, vert ? DOCK_FRAMES + 1 : DOCK_FRAMES),
      // Portrait: the sheet's edge moves with the body's reflow, in the SAME
      // frame, so it keeps to the gap of the shortened body (act.tsx) — eased
      // over the product's panel curve instead, it lagged the reflow and a
      // strip of the gallery showed for 4 frames right under the green wipe.
      // The plugins scene inherits the final height through assistantRest.
      height: vert ? (applied ? AI_SHEET_H_APPLIED : AI_SHEET_H) : undefined,
      panel: {
        composer: frame < b.sent ? AI.prompt.slice(0, typed) : "",
        caret: focused,
        caretOn: typing || blinkOn(frame, frame < b.type ? b.open + DOCK_FRAMES : b.type + TYPE_FRAMES),
        sent: frame >= b.sent ? AI.prompt : null,
        sentReveal: springAt(frame, b.sent, { damping: 18, stiffness: 190 }),
        // Dots until the first words arrive; the composer shows Stop until the edit is applied.
        thinking: frame >= b.think && frame < b.apply,
        frame,
        reply: frame >= b.reply ? AI.reply.slice(0, Math.max(1, streamed)) : null,
        replyReveal: springAt(frame, b.think, { damping: 18, stiffness: 190 }),
        applied: springAt(frame, b.apply, { damping: 14, stiffness: 170 }),
        usage: AI.usage(applied ? 1 : 0),
        sendPressed: frame >= b.send && frame < b.send + PRESS_FRAMES,
        suggestions: vert ? 1 : 2,
      },
    },
  };
}

/* ── Pointer paths ──────────────────────────────────────────────────────── */

/** Landscape: in from the preview, onto the sparkle FAB — and the dock slides in under the pointer, so
 *  its send button arrives exactly where the FAB was; the pointer waits there while the prompt types. */
const sendL = dockL().send;
const POINTER_L: Waypoint[] = [
  { f: T + 1, x: FAB_L.x - 44, y: FAB_L.y - 60 },
  { f: ASSIST.fab - 1, x: FAB_L.x, y: FAB_L.y },
  { f: ASSIST.fab, x: FAB_L.x, y: FAB_L.y, press: true },
  { f: ASSIST.fab + PRESS_FRAMES + 6, x: FAB_L.x, y: FAB_L.y },
  { f: ASSIST.fab + PRESS_FRAMES + 16, x: sendL.x + 2, y: sendL.y + 1 },
  { f: ASSIST.send, x: sendL.x + 2, y: sendL.y + 1, press: true },
  { f: ASSIST.send + PRESS_FRAMES + 5, x: sendL.x + 34, y: sendL.y + 50 },
];
const POINTER_L_ON: [number, number][] = [[T + 1, ASSIST.send + PRESS_FRAMES + 6]];

/** Portrait: a finger comes down on the sheet's send button (fades in on the spot, taps, lifts). */
const sendV = aiSheetV().send;
const TOUCH_V: Waypoint[] = [
  { f: ASSIST.send - 6, x: sendV.x, y: sendV.y },
  { f: ASSIST.send, x: sendV.x, y: sendV.y, press: true },
];
const TOUCH_V_ON: [number, number][] = [[ASSIST.send - 6, ASSIST.send + 7]];

/* ── Sound ──────────────────────────────────────────────────────────────── */

/** A soft key tick on every other typed character (skipping spaces) — typing texture, not a buzz. */
const TICKS = [...AI.prompt]
  .map((ch, i) => ({ ch, i, f: ASSIST.type + Math.ceil(((i + 1) * FPS) / TYPE_CPS) }))
  .filter(({ ch, i }) => ch !== " " && i % 2 === 0);

/* ── Captions ───────────────────────────────────────────────────────────── */

const APPLY_ABS = seqFrom("assistant") + ASSIST.apply;
const CAPTION_WORDS = 4; // "Ask. Apply. Keep building."
/** Frames a caption part takes to settle after it rises (captionReport's part settle). */
const PART_SETTLE = 9;
export const captions: CaptionCue[] = [
  {
    id: "assistant",
    label: "AI assistant",
    // "Apply." and "Keep building." rise together on the apply beat…
    parts: ["Ask.", { text: "Apply.", hl: true, at: APPLY_ABS }, { text: "Keep building.", at: APPLY_ABS }],
    // In on "Ask the AI assistant"; the build scene's LIVE PREVIEW super is out by then.
    from: atAbs("assistant", "Ask", { offset: 2 }),
    // …so it can leave as soon as it has been read (no slack): its exit fade is
    // over before the plugins scene selects the button row, whose unfolding
    // editor pushes tree rows into the caption zone (S06Plugins checks this).
    to: APPLY_ABS + PART_SETTLE + requiredLegibleFrames(CAPTION_WORDS, FPS) + CAPTION_EXIT_FRAMES,
    accent: "#9b84ee",
  },
];

/* ── Scene ──────────────────────────────────────────────────────────────── */

export const SceneAssistant: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const props = assistantFrame(frame, vert);
  return (
    <AbsoluteFill>
      <Background glow={EDITOR_GLOW} />
      <Camera shots={[{ f: T, ...(vert ? PORTRAIT_CAM : EDITOR_WIDE_L) }]}>
        {vert ? <PortraitAct {...props} /> : <LandscapeAct {...props} />}
        {vert ? (
          <Cursor variant="touch" {...cursorAt(frame, TOUCH_V)} opacity={cursorOpacity(frame, TOUCH_V_ON)} />
        ) : (
          <Cursor {...cursorAt(frame, POINTER_L)} opacity={cursorOpacity(frame, POINTER_L_ON)} />
        )}
      </Camera>

      {!vert && <Sfx from={ASSIST.fab} src={sfxVariant("click", 0)} frames={SFX_FRAMES.click} volume={VOL.click} />}
      <Sfx from={ASSIST.open} src={sfxVariant("pop", 0)} frames={SFX_FRAMES.pop} volume={VOL.pop} />
      {TICKS.map((t, n) => (
        <Sfx key={t.i} from={t.f} src={sfxVariant("tick", n)} frames={SFX_FRAMES.tick} volume={VOL.tick} />
      ))}
      <Sfx from={ASSIST.send} src={sfxVariant("click", 1)} frames={SFX_FRAMES.click} volume={VOL.click} />
      <Sfx from={ASSIST.chime} src={CHIME} frames={SFX_FRAMES.chime} volume={VOL.chime} />
    </AbsoluteFill>
  );
};

/** The scene's last visible frame (its next cut is the plugins scene's first). */
export const ASSIST_LAST = SCENES.assistant.durationInFrames + T - 1;

/**
 * The frame this scene leaves on screen — the plugins scene opens on it (the
 * assistant→plugins hold cut), so both sides are the same props by construction.
 */
export const assistantRest = (vert: boolean) => assistantFrame(ASSIST_LAST, vert);
