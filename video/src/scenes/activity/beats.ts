import { LAUNCH_SUFFIX_KEYS } from "../../story/campaign";
import { SCENES, TRANSITION_FRAMES, at, speechEnd } from "../../timeline";
import { DIP_OUT } from "../../components/SceneTransition";

/**
 * The Activity coda's beats (scene-local frames), keyed to its VO line:
 *
 *   "Need another pair of hands?"   → the staff's voice call in Discord (four
 *                                      members, Mira and Kai talking); Aria's
 *                                      pointer finds the call's rocket
 *                                      ("Start an Activity") and clicks it on
 *                                      "hands" — the Activities shelf opens
 *   "Invite"                        → she starts DWEEB from the shelf: Discord's
 *                                      launch splash, then the Activity opens in
 *                                      the call (starting it in the call is what
 *                                      invites everyone in it)
 *   "your team,"  (pause)           → Kai joins: his avatar pops into the dock
 *                                      and the Activity badge onto his row in
 *                                      the channel list; the camera pushes into
 *                                      the Activity
 *   "then build together"           → Kai's presence lands on the Text row and
 *                                      he types " — Friday!" into the heading
 *   "inside Discord —"              → while he types, Aria adds
 *                                      "💡 Suggest a game" from "+ Add button"
 *   "in real time."                 → both edits settled; a slow breath in,
 *                                      then a still frame for the hard cut
 *
 * Both aspects share every beat: the desktop client in landscape (the
 * Activity runs in the call's focused tile), Discord mobile in portrait (the
 * Activities sheet, then the Activity full-screen in the same box).
 */

const T = TRANSITION_FRAMES;

/** First visible frame: the dip mounts this scene DIP_OUT frames in. */
export const FIRST = DIP_OUT;
/** The dip has fully revealed the scene by this frame. */
export const REVEALED = T - 1;
/** The scene's last visible frame (the CTA hard-cuts in on the next one). */
export const LAST = SCENES.activity.durationInFrames + T - 1;

/* ── The call ──────────────────────────────────────────────────────────── */

/** Life in the call before anyone clicks anything: Mira, then Kai, talking. */
export const TALK: { name: string; from: number; to: number }[] = [
  { name: "Mira", from: FIRST + 1, to: REVEALED + 16 },
  { name: "Kai", from: REVEALED + 18, to: at("activity", "pair", { offset: 4 }) },
];

/** Aria's pointer fades in over the call on "Need"… */
export const POINTER_IN = at("activity", "Need", { offset: -6 });
/** …settles on the call's rocket by "pair" (its tooltip rises a beat later)… */
export const ROCKET_HOVER = at("activity", "pair");
export const TOOLTIP_IN = ROCKET_HOVER + 3;
/** …and clicks it on "hands": the Activities shelf opens. */
export const ROCKET_PRESS = at("activity", "hands", { offset: 3 });
export const TOOLTIP_OUT = ROCKET_PRESS + 2;
export const SHELF_IN = ROCKET_PRESS + 1;

/* ── Starting DWEEB ─────────────────────────────────────────────────────── */

/** The pointer reaches DWEEB's card with time to read it… */
export const DWEEB_HOVER = at("activity", "Invite", { offset: -12 });
/** …and starts it on "Invite" — the CLICK plays on this frame. */
export const DWEEB_PRESS = at("activity", "Invite");
/** The shelf closes on the click; the call view gives way to Discord's launch splash. */
export const SHELF_OUT = DWEEB_PRESS + 1;
export const CALL_OUT = DWEEB_PRESS + 4;
export const SPLASH_IN = DWEEB_PRESS + 4;
/** The Activity is up on "team"; the splash dissolves under it. */
export const EDITOR_IN = at("activity", "team");
/** Landscape: the call's participants settle into a strip under the Activity. */
export const STRIP_IN = DWEEB_PRESS + 8;
/** Aria's pointer drifts off once the Activity starts loading. */
export const POINTER_OUT = DWEEB_PRESS + 14;

/* ── Kai joins ──────────────────────────────────────────────────────────── */

/** In the breath after "your team," — his avatar pops into the dock. */
export const JOIN = at("activity", "team", { offset: 16 });

/** Landscape: the push from the whole client into the Activity, done as "together" starts. */
export const PUSH_START = at("activity", "team", { offset: 6 });
export const PUSH_END = at("activity", "together");

/* ── Building together ──────────────────────────────────────────────────── */

/**
 * Kai focuses the Text component: his outline + avatar land on its row, at
 * once, as in the product (the outline has no transition).
 */
export const KAI_FOCUS = at("activity", "together", { offset: -6 });
/**
 * Kai types " — Friday!" onto the heading, one grapheme per keystroke, at a
 * human pace (≈ 9 keys/s, a small hitch after the dash). The preview and the
 * Text row's summary update on every key — collab edits arrive per keystroke.
 */
const KAI_TYPE_START = at("activity", "together", { offset: 1 });
const KAI_GAPS = [0, 3, 3, 5, 3, 3, 3, 4, 3, 3];
export const KAI_KEY_FRAMES: number[] = KAI_GAPS.slice(0, LAUNCH_SUFFIX_KEYS).reduce<number[]>(
  (acc, g) => [...acc, (acc.length ? acc[acc.length - 1] : KAI_TYPE_START) + g],
  [],
);
if (KAI_KEY_FRAMES.length !== LAUNCH_SUFFIX_KEYS) {
  throw new Error(`activity beats: ${KAI_KEY_FRAMES.length} key frames for a ${LAUNCH_SUFFIX_KEYS}-key suffix`);
}
export const KAI_TYPE_END = KAI_KEY_FRAMES[KAI_KEY_FRAMES.length - 1];
/** Graphemes of " — Friday!" Kai has typed by `frame`. */
export const kaiTyped = (frame: number) => KAI_KEY_FRAMES.filter((f) => f <= frame).length;

/**
 * Aria clicks "+ Add button" while Kai is still typing — two people changing
 * one message at the same moment is the whole point of the beat.
 */
export const ADD_POINTER_IN = at("activity", "inside", { offset: -10 });
export const ADD_PRESS = at("activity", "inside", { offset: 9 });
/** The product adds on click: the row slides in, the preview button pops. */
export const ADDED = ADD_PRESS + 3;
export const ADD_POINTER_OUT = ADD_PRESS + 20;

/* ── Coda ───────────────────────────────────────────────────────────────── */

/** A slow breath in over "in real time", settled before the last frames. */
export const SETTLE_START = at("activity", "Discord", { offset: 10 });
export const SETTLE_END = LAST - 8;

/**
 * The super: in straight after the dip (the send scene's super ends its exit
 * on exactly this frame, so the plates hand over without overlapping), out
 * just after the line's last word, leaving the final frames clean.
 */
export const CAPTION_IN = T + 4;
export const CAPTION_OUT = speechEnd("activity") + 6;

// Keep the beats in story order, all after the first visible frame (sound
// scheduled earlier would be dropped: the dip doesn't mount this scene until
// FIRST) and the super gone before the camera settles. A re-recorded line
// that breaks any of this fails loudly here instead of drifting.
const ORDER: [string, number][] = [
  ["FIRST", FIRST],
  ["REVEALED", REVEALED],
  ["CAPTION_IN", CAPTION_IN],
  ["POINTER_IN", POINTER_IN],
  ["ROCKET_HOVER", ROCKET_HOVER],
  ["TOOLTIP_IN", TOOLTIP_IN],
  ["ROCKET_PRESS", ROCKET_PRESS],
  ["DWEEB_HOVER", DWEEB_HOVER],
  ["DWEEB_PRESS", DWEEB_PRESS],
  ["STRIP_IN", STRIP_IN],
  ["EDITOR_IN", EDITOR_IN],
  ["POINTER_OUT", POINTER_OUT],
  ["PUSH_START", PUSH_START],
  ["JOIN", JOIN],
  ["KAI_FOCUS", KAI_FOCUS],
  ["PUSH_END", PUSH_END],
  ["ADD_POINTER_IN", ADD_POINTER_IN],
  ["ADD_PRESS", ADD_PRESS],
  ["KAI_TYPE_END", KAI_TYPE_END],
  ["SETTLE_START", SETTLE_START],
  ["CAPTION_OUT", CAPTION_OUT],
  ["SETTLE_END", SETTLE_END],
  ["LAST", LAST],
];
ORDER.forEach(([name, f], i) => {
  if (i > 0 && !(f > ORDER[i - 1][1])) {
    throw new Error(`activity beats out of order: ${ORDER[i - 1][0]}=${ORDER[i - 1][1]} ≥ ${name}=${f}`);
  }
});
// The shelf must be up long enough to read DWEEB's card before the click.
if (DWEEB_PRESS - SHELF_IN < 18) {
  throw new Error(`activity beats: the Activities shelf is only up ${DWEEB_PRESS - SHELF_IN} frames before DWEEB is started`);
}
