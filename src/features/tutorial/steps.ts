/**
 * The onboarding tour's script — five steps, one sentence each.
 *
 * The tour runs over the user's *real* message (whatever the gallery just
 * applied), so every step anchors to a live editor control rather than a
 * staged screenshot. Steps deliberately cover only the essentials a first-time
 * user needs to reach their first posted message — build, preview, reuse,
 * assist, send — and end on Send, the first-success action.
 *
 * Each step lists its anchor *candidates* in priority order; the overlay picks
 * the first one that's actually visible in the viewport. That's how one script
 * serves both layouts: the preview step anchors the desktop side pane when
 * it's on screen, and falls back to the mobile preview FAB when the pane is an
 * off-screen sheet. A candidate can carry its own copy when the fallback
 * element needs different wording. A step none of whose candidates resolve is
 * skipped silently.
 *
 * Selectors lean on stable, purpose-built hooks: `data-tour` attributes and
 * the Send button's long-standing `#builder-send-action` id (also used by the
 * send coach-mark).
 */

/** Which side of the anchor the callout prefers (it flips when out of room). */
export type TourSide = "top" | "bottom" | "left" | "right";

export interface TourAnchor {
  /** CSS selector for the element to spotlight. */
  selector: string;
  /** Preferred callout side relative to the anchor. */
  place: TourSide;
  /** Copy override when this particular anchor wins (e.g. mobile fallback). */
  body?: string;
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Tried in order; the first visible element is spotlighted. */
  anchors: TourAnchor[];
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "tree",
    title: "Your message is a stack of blocks",
    body: "Everything you see in the preview lives here as a block — click one to edit it, drag to reorder, or add more with “Add component”.",
    anchors: [{ selector: '[data-tour="tree"]', place: "right" }],
  },
  {
    id: "preview",
    title: "Preview it live",
    body: "This is exactly how your message will look in Discord, updating as you type — no guessing, no test posts.",
    anchors: [
      { selector: '[data-tour="preview-pane"]', place: "left" },
      {
        selector: '[data-tour="preview-fab"]',
        place: "top",
        body: "Tap here any time to see exactly how your message will look in Discord — it updates live as you edit.",
      },
    ],
  },
  {
    id: "saved",
    title: "Templates & saved messages",
    body: "The gallery you just saw lives here — start from a ready-made template or save your own messages to reuse later.",
    anchors: [{ selector: '[data-tour="saved"]', place: "bottom" }],
  },
  {
    id: "ai",
    title: "Or just describe it",
    body: "In a hurry? Tell the AI assistant what you want — “a welcome message with a rules button” — and it builds the blocks for you.",
    anchors: [{ selector: '[data-tour="ai"]', place: "top" }],
  },
  {
    id: "send",
    title: "Send it to your server",
    body: "When you're happy with it, Send posts the message to your server — and walks you through connecting a webhook the first time. That's the whole tour!",
    anchors: [{ selector: "#builder-send-action", place: "bottom" }],
  },
];
