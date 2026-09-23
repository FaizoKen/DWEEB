/**
 * Every one of these selectors replaces a sentence the Send panel used to show
 * in a state where it wasn't true, so the tests are about the *claim*, not the
 * wording: "pick a channel below" with no channel list on screen, "All set" for
 * a URL nothing had checked, a disabled button explaining itself nowhere, and
 * Discord's "Unknown Message" standing in for "that message is gone".
 */

import { describe, expect, it } from "vitest";

import {
  PICK_DESTINATION_HINT,
  PICK_UPDATE_WEBHOOK_HINT,
  UNCHECKED_DESTINATION_TEXT,
  UPDATE_TARGET_GONE_TEXT,
  sendDestinationCopy,
  sendDisabledHint,
  sendLeadCopy,
  updateFailureMessage,
} from "./sendCopy";

describe("sendLeadCopy", () => {
  const signedIn: Parameters<typeof sendLeadCopy>[0] = {
    mode: "new",
    pickerActive: true,
    destinationPicked: false,
    signedOut: false,
  };

  it("tells a signed-out visitor what they can actually do", () => {
    const copy = sendLeadCopy({
      mode: "new",
      pickerActive: false,
      destinationPicked: false,
      signedOut: true,
    });
    expect(copy).toBe(
      "Sign in to pick a channel, or paste a webhook URL below — your message goes straight " +
        "from this browser to Discord. We never see or store it.",
    );
    // The privacy promise is the load-bearing half of the sentence — it must
    // survive every rewrite of the first half.
    expect(copy).toContain("We never see or store it.");
  });

  it("leaves the signed-in variants alone", () => {
    expect(sendLeadCopy({ ...signedIn, mode: "new" })).toMatch(
      /^Pick a channel below and hit send/,
    );
    expect(sendLeadCopy({ ...signedIn, destinationPicked: true })).toMatch(
      /^Check the channel below and hit send/,
    );
    expect(sendLeadCopy({ ...signedIn, mode: "update" })).toBe(
      "Your edit goes straight from this browser to Discord — we never see or store it.",
    );
  });

  it("never offers sign-in on the update screen", () => {
    expect(
      sendLeadCopy({
        mode: "update",
        pickerActive: false,
        destinationPicked: false,
        signedOut: true,
      }),
    ).not.toMatch(/Sign in/);
  });

  it("keeps the channel wording once a picker is on screen, even signed out mid-flight", () => {
    // `signedOut` is only ever passed for a definitively anonymous session, but
    // an active picker means a channel list *is* rendered — that wins.
    expect(
      sendLeadCopy({
        mode: "new",
        pickerActive: true,
        destinationPicked: false,
        signedOut: true,
      }),
    ).toMatch(/^Pick a channel below/);
  });
});

describe("sendDestinationCopy", () => {
  it("refuses to say 'All set' about a URL nothing has checked", () => {
    const copy = sendDestinationCopy({ known: false });
    expect(copy).toEqual({ kind: "unchecked", text: UNCHECKED_DESTINATION_TEXT });
    expect(copy.kind === "unchecked" && copy.text).toBe(
      "Ready to send — we'll check this webhook when you post.",
    );
  });

  it("stays honest even if names somehow rode along unverified", () => {
    expect(sendDestinationCopy({ known: false, channelName: "general" }).kind).toBe("unchecked");
  });

  it("names the destination once the webhook is verified or saved", () => {
    expect(
      sendDestinationCopy({ known: true, channelName: "general", guildName: "Faizo's" }),
    ).toEqual({ kind: "known", channelName: "general", guildName: "Faizo's" });
  });

  it("keeps the generic 'All set' when the destination has no resolved name", () => {
    expect(sendDestinationCopy({ known: true })).toEqual({
      kind: "known",
      channelName: undefined,
      guildName: undefined,
    });
  });
});

describe("sendDisabledHint", () => {
  it("says what is missing when no destination is chosen", () => {
    expect(
      sendDisabledHint({
        mode: "new",
        hasDestination: false,
        hasBlockingIssues: false,
        busy: false,
      }),
    ).toBe(PICK_DESTINATION_HINT);
  });

  it("asks for a webhook, not a channel, on the update screen", () => {
    expect(
      sendDisabledHint({
        mode: "update",
        hasDestination: false,
        hasBlockingIssues: false,
        busy: false,
      }),
    ).toBe(PICK_UPDATE_WEBHOOK_HINT);
  });

  it("stays quiet when a callout already explains the disabled button", () => {
    expect(
      sendDisabledHint({
        mode: "new",
        hasDestination: false,
        hasBlockingIssues: true,
        busy: false,
      }),
    ).toBeNull();
  });

  it("stays quiet when the primary button is the scheduling sign-in", () => {
    // That button is enabled and says what it does; the hint explains a
    // *disabled* send.
    expect(
      sendDisabledHint({
        mode: "new",
        hasDestination: false,
        hasBlockingIssues: false,
        busy: false,
        primaryIsSignIn: true,
      }),
    ).toBeNull();
  });

  it("stays quiet with a destination chosen, or while busy", () => {
    expect(
      sendDisabledHint({
        mode: "new",
        hasDestination: true,
        hasBlockingIssues: false,
        busy: false,
      }),
    ).toBeNull();
    expect(
      sendDisabledHint({
        mode: "new",
        hasDestination: false,
        hasBlockingIssues: false,
        busy: true,
      }),
    ).toBeNull();
  });
});

describe("updateFailureMessage", () => {
  const unknownMessage = {
    status: 404,
    error: "Discord (404, code 10008): Unknown Message",
    body: { code: 10008, message: "Unknown Message" },
  };

  it("explains a 404 instead of relaying 'Unknown Message'", () => {
    expect(updateFailureMessage(unknownMessage)).toBe(UPDATE_TARGET_GONE_TEXT);
    expect(updateFailureMessage(unknownMessage)).toContain(
      "only messages this same webhook posted",
    );
  });

  it("explains a 404 with no usable body too", () => {
    expect(
      updateFailureMessage({ status: 404, error: "Discord could not find that webhook (404)." }),
    ).toBe(UPDATE_TARGET_GONE_TEXT);
    expect(updateFailureMessage({ status: 404, error: "x", body: "not json" })).toBe(
      UPDATE_TARGET_GONE_TEXT,
    );
  });

  it("keeps Discord's wording when the *webhook* is the thing that's gone", () => {
    // 10015 points at a different fix (create a new webhook), and the panel's
    // own "was deleted on Discord" path handles it.
    const error = "Discord (404, code 10015): Unknown Webhook";
    expect(updateFailureMessage({ status: 404, error, body: { code: 10015 } })).toBe(error);
  });

  it("passes every other status straight through", () => {
    for (const status of [400, 401, 403, 429, 500, 0]) {
      expect(updateFailureMessage({ status, error: `boom ${status}` })).toBe(`boom ${status}`);
    }
  });
});

describe("sendLeadCopy — saving into a loaded scheduled post", () => {
  it("says the changes go into the existing post instead of asking for a channel", () => {
    const copy = sendLeadCopy({
      mode: "new",
      pickerActive: true,
      destinationPicked: false,
      signedOut: false,
      editingSchedule: true,
    });
    expect(copy).toContain("already scheduled");
    expect(copy).not.toContain("Pick a channel");
  });
});
