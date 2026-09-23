/**
 * Every failed "Create link" says what to try next — the dialog announces this
 * text as an alert, so a bare "Discord error 503: …" leaves a screen-reader user
 * (and everyone else) with nothing to do about it.
 */

import { describe, expect, it } from "vitest";
import { GuildApiError } from "@/core/guild/api";
import { inviteErrorMessage } from "./inviteError";

describe("inviteErrorMessage", () => {
  it("passes through proxy messages that already say what to do", () => {
    const permission =
      "DWEEB's bot can't create a collaboration link in that channel yet — it needs the Create Invite permission. Re-add the bot to this server (Account → Add to another server) to grant it, then try again.";
    expect(inviteErrorMessage(new GuildApiError(permission, 403))).toBe(permission);
    expect(
      inviteErrorMessage(new GuildApiError("Rate limited by Discord — try again shortly.", 429)),
    ).toBe("Rate limited by Discord — try again shortly.");
    expect(
      inviteErrorMessage(new GuildApiError("Couldn't reach the server. Check your connection.", 0)),
    ).toBe("Couldn't reach the server. Check your connection.");
  });

  it("points a missing or refused channel at another channel", () => {
    expect(inviteErrorMessage(new GuildApiError("That channel isn't in this server.", 404))).toBe(
      "That channel isn't in this server. Try a different channel.",
    );
    expect(
      inviteErrorMessage(new GuildApiError("Discord rejected the request: Invalid Form Body", 400)),
    ).toBe("Discord rejected the request: Invalid Form Body. Try a different channel.");
  });

  it("asks for a retry when the failure was on Discord's side or ours", () => {
    expect(inviteErrorMessage(new GuildApiError("Discord error 503: upstream", 503))).toBe(
      "Discord error 503: upstream. Try again in a moment.",
    );
  });

  it("never shows an empty or raw error", () => {
    const fallback = "Couldn’t create a collaboration link. Check your connection, then try again.";
    expect(inviteErrorMessage(new TypeError("Failed to fetch"))).toBe(fallback);
    expect(inviteErrorMessage(new GuildApiError("  ", 500))).toBe(fallback);
    expect(inviteErrorMessage(undefined)).toBe(fallback);
  });
});
