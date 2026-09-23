/**
 * A BYOK provider's HTTP error leads with what to do and keeps the provider's
 * own words as the detail after it. The old order ("Provider error (401):
 * Incorrect API key provided: sk-…") said what broke in the provider's
 * vocabulary and never what to try — and whenever the body carried a message,
 * the per-status advice was unreachable.
 */

import { describe, expect, it } from "vitest";
import { describeHttpError } from "./providers";

const body = (message: string) => ({ error: { message } });

describe("describeHttpError", () => {
  it("puts the advice first and the provider's message after it", () => {
    const text = describeHttpError(401, body("Incorrect API key provided: sk-****abcd."), "openai");
    const [lead, detail] = text.split("\n\n");
    expect(lead).toMatch(/^The provider didn't accept your API key \(401\)\. Check the key/);
    expect(detail).toBe("The provider said: Incorrect API key provided: sk-****abcd.");
  });

  it("gives advice even when the provider sent no message", () => {
    expect(describeHttpError(404, null)).toBe(
      "The model or endpoint wasn't found (404). Check the model id and base URL in AI settings.",
    );
    // A non-JSON body (a proxy's HTML page) has no message worth quoting.
    expect(describeHttpError(403, "<html>Forbidden</html>")).not.toContain("The provider said");
  });

  it("covers the statuses BYOK users actually meet", () => {
    expect(describeHttpError(400, body("API key not valid."), "gemini")).toMatch(
      /^The provider couldn't accept the request \(400\)\. Check the API key and model id/,
    );
    expect(describeHttpError(402, body("Insufficient credits"), "openrouter")).toMatch(
      /^Your provider account is out of credit \(402\)/,
    );
    expect(describeHttpError(503, body("Overloaded"))).toMatch(
      /^The provider had a problem on its end \(503\)\. Try again in a moment/,
    );
    expect(describeHttpError(422, null)).toMatch(/^The provider returned an unexpected 422/);
  });

  it("leaves the rate-limit copy as it was", () => {
    expect(describeHttpError(429, body("slow down"), "groq")).toMatch(
      /^Rate limited \(429\): slow down\.\n\nFree models can be busy/,
    );
  });
});
