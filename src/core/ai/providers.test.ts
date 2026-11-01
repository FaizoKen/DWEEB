/**
 * A BYOK provider's HTTP error leads with what to do and keeps the provider's
 * own words as the detail after it. The old order ("Provider error (401):
 * Incorrect API key provided: sk-…") said what broke in the provider's
 * vocabulary and never what to try — and whenever the body carried a message,
 * the per-status advice was unreachable.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { callAI, describeHttpError, type AiPrompt } from "./providers";
import type { AiProvider } from "./types";

const body = (message: string) => ({ error: { message } });

describe("callAI — a reply that stopped at the output limit", () => {
  const prompt: AiPrompt = { system: "system", context: "{}" };
  const settings = (provider: AiProvider) => ({
    provider,
    apiKey: "key",
    model: "model",
    baseUrl: "https://provider.test",
  });

  /** Answer the next fetch with these server-sent events. */
  function streamEvents(events: unknown[]) {
    const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(lines, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
  }

  const send = (provider: AiProvider) =>
    callAI(settings(provider), prompt, [{ role: "user", content: "hi" }], undefined, () => {});

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const openAiShaped = (finishReason: string) => [
    { choices: [{ delta: { content: "half a" } }] },
    { choices: [{ delta: {}, finish_reason: finishReason }] },
  ];

  it.each(["dweeb", "openai"] as const)("reads finish_reason on the %s path", async (provider) => {
    streamEvents(openAiShaped("length"));
    expect(await send(provider)).toMatchObject({ ok: true, text: "half a", truncated: true });

    streamEvents(openAiShaped("stop"));
    expect((await send(provider)).truncated).toBe(false);
  });

  it("reads Anthropic's stop_reason", async () => {
    const reply = (stopReason: string) => [
      { type: "content_block_delta", delta: { type: "text_delta", text: "half a" } },
      { type: "message_delta", delta: { stop_reason: stopReason } },
    ];
    streamEvents(reply("max_tokens"));
    expect((await send("anthropic")).truncated).toBe(true);

    streamEvents(reply("end_turn"));
    expect((await send("anthropic")).truncated).toBe(false);
  });

  it("reads Gemini's finishReason", async () => {
    const reply = (finishReason: string) => [
      { candidates: [{ content: { parts: [{ text: "half a" }] }, finishReason }] },
    ];
    streamEvents(reply("MAX_TOKENS"));
    expect(await send("gemini")).toMatchObject({ text: "half a", truncated: true });

    streamEvents(reply("STOP"));
    expect((await send("gemini")).truncated).toBe(false);
  });
});

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
