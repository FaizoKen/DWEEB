import { RETITLE_KEYS } from "../../story/campaign";
import { SCENES, TRANSITION_FRAMES, at } from "../../timeline";

/**
 * The build scene's beats (scene-local frames), keyed to its VO line:
 *
 *   "Shape it with real Discord components"      → retitle the heading in the
 *                                                   Text row's inline editor
 *   "while a high-fidelity preview updates live" → swap the gallery's hero art,
 *                                                   add 🎁 Claim reward, add the
 *                                                   platform select
 *   "and every limit is checked for you"         → the stat pills flash ✓ on
 *                                                   "checked"; the chime answers
 *                                                   after "for you"
 *
 * Both aspects share the VO-critical beats (the retitle, the pills, the chime).
 * The portrait stage's builder sheet shows about four rows, so it adds a tap
 * that folds the Text editor away again (the product toggles a selected row
 * shut) and a swipe that brings "+ Add button" up from under the gallery
 * editor, and shifts the later presses a little to make room for them.
 */

const T = TRANSITION_FRAMES;

/** The scene's last visible frame (the build → assistant hold cut follows it). */
export const LAST = SCENES.build.durationInFrames + T - 1;

/** Click the Text row just ahead of "Shape". */
export const TEXT_PRESS = at("build", "Shape", { offset: -1 });
/** Drag-select "📢 Announcement" in the textarea once its editor has unfolded. */
export const SEL_DOWN = TEXT_PRESS + 14;
export const SEL_UP = SEL_DOWN + 6;
/** Type "🚀 Season 4 is live" — one key per ~1.35 frames (≈ 22 keys/s). */
export const TYPE_START = SEL_UP + 2;
export const KEY_FRAMES = RETITLE_KEYS.map((_, i) => TYPE_START + Math.round(i * 1.35));
export const TYPE_END = KEY_FRAMES[KEY_FRAMES.length - 1];

/** Keys typed by `frame` (0 → the stock heading, still selected). */
export const keysTyped = (frame: number) => KEY_FRAMES.filter((f) => f <= frame).length;

/** "…is checked": the pills flash green ✓ with the word, and settle before the cut. */
export const OK_ON = at("build", "checked", { offset: -3 });
/** The chime rings in the pause after "for you". */
export const CHIME_AT = at("build", "you", { edge: "end" });
export const OK_OFF = CHIME_AT + 2;

export type BuildBeats = {
  textPress: number;
  /** Portrait only: the tap that closes the Text editor again. */
  textClose: number | null;
  galleryPress: number;
  dropPress: number;
  /** Portrait only: the finger drags the sheet up to reveal "+ Add button". */
  swipe: { down: number; up: number } | null;
  addButtonPress: number;
  addContainerPress: number;
  groupPress: number;
  optionPress: number;
  /** Portrait only: the preview, then the tree, scroll home for cut B. */
  settlePreview: number;
  settleTree: number;
};

export const BEATS_L: BuildBeats = {
  textPress: TEXT_PRESS,
  textClose: null,
  galleryPress: at("build", "high-fidelity", { offset: -4 }),
  dropPress: at("build", "preview", { offset: -6 }),
  swipe: null,
  addButtonPress: at("build", "updates"),
  addContainerPress: at("build", "live", { offset: -1 }),
  groupPress: at("build", "live", { offset: 9 }),
  optionPress: at("build", "live", { offset: 17 }),
  settlePreview: at("build", "every"),
  settleTree: at("build", "every"),
};

export const BEATS_V: BuildBeats = {
  textPress: TEXT_PRESS,
  textClose: TYPE_END + 5,
  galleryPress: at("build", "high-fidelity", { offset: 1 }),
  dropPress: at("build", "preview", { offset: -3 }),
  swipe: { down: at("build", "preview", { offset: 3 }), up: at("build", "updates", { offset: 1 }) },
  addButtonPress: at("build", "updates", { offset: 6 }),
  addContainerPress: at("build", "live", { offset: 7 }),
  groupPress: at("build", "live", { offset: 17 }),
  optionPress: at("build", "and", { offset: 1 }),
  // The preview comes home first (showing the whole heading again); the tree
  // follows slowly enough to start under the "checked" flash without pulling
  // the eye from it, and is still before the cut.
  settlePreview: at("build", "every", { offset: 10 }),
  settleTree: at("build", "every", { offset: 14 }),
};
