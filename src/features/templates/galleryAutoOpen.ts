/**
 * "Should the Template Gallery auto-open?" decision.
 *
 * The gallery is the app's landing screen, but popping it on *every* visit /
 * refresh quickly turns into a nag — especially for a returning user who just
 * wants to keep editing. This module decides, on each load, whether auto-opening
 * is actually useful, and records when we last did so.
 *
 * The rule (deep-link / webhook flows are gated by the caller and never reach
 * here):
 *
 *  1. **First visit ever** — no record yet — open. This is the onboarding
 *     moment, the whole reason the gallery exists.
 *  2. **Anti-nag cooldown** — if we auto-opened within `COOLDOWN_MS`, skip. A
 *     refresh or same-session reload should never re-pop the gallery.
 *  3. **Respect work in progress** — past the cooldown, if there's a *fresh*
 *     draft (edited within `DRAFT_FRESH_MS`), the user is mid-task: they resume
 *     straight into the editor instead of being interrupted. With no draft, or
 *     an old/abandoned one, the gallery returns as a deliberate starting point.
 *
 * Net effect: shown once per fresh session at most, never on a quick refresh,
 * and never hidden forever (a new session with no active work brings it back).
 * It stays reopenable any time from the Builder action bar / Saved menu — only
 * the *automatic* open is governed here.
 *
 * Storage mirrors `draftStorage` / `webhook/history`: a versioned key and a
 * read that never throws (storage may be disabled or hold an older shape).
 */

import { loadDraft } from "@/core/state/draftStorage";

const STORAGE_KEY = "dweeb.gallery.lastAutoOpen.v1";

/** Don't auto-open again within this window of the last auto-open. */
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

/** A draft touched more recently than this counts as active, in-progress work. */
const DRAFT_FRESH_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Read the last auto-open timestamp, or null if never / unreadable. */
function readLastAutoOpen(): number | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Whether the gallery should auto-open on this load. Pure read — call
 * `markGalleryAutoOpened()` separately when actually opening so the cooldown
 * starts ticking.
 */
export function shouldAutoOpenGallery(now: number = Date.now()): boolean {
  const lastShown = readLastAutoOpen();

  // First visit ever — the landing screen earns its keep.
  if (lastShown === null) return true;

  // Anti-nag: a refresh / same-session reload shouldn't re-pop it.
  if (now - lastShown < COOLDOWN_MS) return false;

  // Past the cooldown (a later session). Don't interrupt active editing: a
  // freshly-touched draft means the user is mid-task and will resume in place.
  const draft = loadDraft();
  if (draft && now - draft.savedAt < DRAFT_FRESH_MS) return false;

  return true;
}

/** Record that the gallery just auto-opened, starting the cooldown. Never throws. */
export function markGalleryAutoOpened(now: number = Date.now()): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, String(now));
  } catch {
    // Storage disabled or over quota — losing the stamp only means the gallery
    // may auto-open once more than intended, which is harmless.
  }
}
