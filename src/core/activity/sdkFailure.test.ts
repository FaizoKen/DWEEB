import { describe, expect, it } from "vitest";
import { sdkFailure } from "./sdkFailure";

const STAGE = "authorizing with Discord";

describe("sdkFailure", () => {
  it("reads the plain { code, message } the SDK rejects with", () => {
    const e = sdkFailure({ code: 5000, message: "OAuth2 error." }, STAGE);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe(
      "Couldn't finish authorizing with Discord: OAuth2 error (code 5000). Try relaunching DWEEB.",
    );
  });

  it("never renders an object as [object Object]", () => {
    for (const rejected of [{}, { code: 4006 }, { message: "" }, { message: 7 }, null, undefined]) {
      expect(sdkFailure(rejected, STAGE).message).not.toContain("[object");
    }
  });

  it("still names the code when Discord sends no message", () => {
    expect(sdkFailure({ code: 4006 }, STAGE).message).toContain("(code 4006)");
  });

  it("passes a real Error through untouched", () => {
    const original = new Error("Timed out while authorizing with Discord.");
    expect(sdkFailure(original, STAGE)).toBe(original);
  });

  it("doesn't read a string rejection as a reason it can't vouch for", () => {
    expect(sdkFailure("nope", STAGE).message).toContain("Discord gave no reason");
  });
});
