/**
 * When replacing the whole shared draft asks first, and what the people it
 * lands on are told. The confirm must appear exactly when someone else would
 * lose work — never for solo use, never for a draft nobody has touched.
 */

import { describe, expect, it } from "vitest";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";
import { DEFAULT_PRESET } from "@/data/showcase";
import type { CollabParticipant } from "./collab";
import {
  actorDisplayName,
  editingTogetherPhrase,
  isPristineDraft,
  needsRoomReplaceConfirm,
  otherEditors,
  peerReplaceNotice,
} from "./roomReplace";

const me: CollabParticipant = { id: "me", name: "Faiz", avatar: null };
const ana: CollabParticipant = { id: "ana", name: "Ana", avatar: null };
const bo: CollabParticipant = { id: "bo", name: "Bo", avatar: null };

/** A deep copy with every editor id swapped — what a peer's copy of the same
 *  draft looks like after the room re-ids and ships it as JSON. */
function reIded(message: WebhookMessage): WebhookMessage {
  let n = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = k === "_id" ? `re-${n++}` : walk(val);
      return out;
    }
    return v;
  };
  return walk(JSON.parse(JSON.stringify(message))) as WebhookMessage;
}

const edited: WebhookMessage = {
  components: [{ _id: "t", type: ComponentType.TextDisplay, content: "Our announcement" }],
} as unknown as WebhookMessage;

describe("otherEditors", () => {
  it("leaves you out and counts someone on two devices once", () => {
    expect(otherEditors([me, ana, ana, bo], "me")).toEqual([ana, bo]);
    expect(otherEditors([me], "me")).toEqual([]);
    expect(otherEditors([], "me")).toEqual([]);
  });
});

describe("isPristineDraft", () => {
  it("treats a blank draft and the untouched fresh-open default as nothing to lose", () => {
    expect(isPristineDraft({ components: [] })).toBe(true);
    expect(isPristineDraft(DEFAULT_PRESET.message)).toBe(true);
    // Compared by content: the ids a room re-assigns don't matter.
    expect(isPristineDraft(reIded(DEFAULT_PRESET.message))).toBe(true);
  });

  it("treats any real edit as work worth keeping — message options included", () => {
    expect(isPristineDraft(edited)).toBe(false);
    expect(isPristineDraft({ components: [], username: "Announcements" })).toBe(false);
    expect(isPristineDraft({ ...reIded(DEFAULT_PRESET.message), username: "Mod team" })).toBe(
      false,
    );
  });
});

describe("needsRoomReplaceConfirm", () => {
  it("asks when someone else is editing a draft with work in it", () => {
    expect(needsRoomReplaceConfirm(edited, [me, ana], "me")).toBe(true);
  });

  it("never asks solo — even with work in the draft", () => {
    expect(needsRoomReplaceConfirm(edited, [me], "me")).toBe(false);
    // Before the roster arrives (or offline from the start) nobody is known.
    expect(needsRoomReplaceConfirm(edited, [], "me")).toBe(false);
    // You on a second device is still just you.
    expect(needsRoomReplaceConfirm(edited, [me, me], "me")).toBe(false);
  });

  it("doesn't ask when the draft is blank or still the untouched default", () => {
    expect(needsRoomReplaceConfirm({ components: [] }, [me, ana], "me")).toBe(false);
    expect(needsRoomReplaceConfirm(DEFAULT_PRESET.message, [me, ana, bo], "me")).toBe(false);
  });
});

describe("editingTogetherPhrase", () => {
  it("names one other person and counts several", () => {
    expect(editingTogetherPhrase([ana])).toBe("You and Ana");
    expect(editingTogetherPhrase([ana, bo, { id: "c", name: "Cy", avatar: null }])).toBe(
      "You and 3 others",
    );
    expect(editingTogetherPhrase([{ id: "x", name: "  ", avatar: null }])).toBe(
      "You and one other person",
    );
    expect(editingTogetherPhrase([])).toBe("Only you");
  });
});

describe("peer replace notice", () => {
  it("names the replacer from the room roster first, then their announced name", () => {
    expect(actorDisplayName({ userId: "ana", name: "ana_old" }, [me, ana])).toBe("Ana");
    expect(actorDisplayName({ userId: "gone", name: "Dee" }, [me, ana])).toBe("Dee");
    expect(actorDisplayName({ userId: "gone", name: " " }, [me])).toBeNull();
    expect(actorDisplayName(null, [me, ana])).toBeNull();
  });

  it("says who replaced or cleared the draft, and never guesses", () => {
    expect(peerReplaceNotice("Ana", false)).toBe("Ana replaced the whole draft.");
    expect(peerReplaceNotice("Ana", true)).toBe("Ana cleared the draft.");
    expect(peerReplaceNotice(null, false)).toBe("Someone replaced the whole draft.");
    expect(peerReplaceNotice(null, true)).toBe("Someone cleared the draft.");
  });
});
