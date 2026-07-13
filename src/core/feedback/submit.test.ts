import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activity: false,
  feedbackAvailable: true,
  proxyFetch: vi.fn(),
}));

vi.mock("@/core/activity/runtime", () => ({
  isActivityMode: () => mocks.activity,
}));
vi.mock("@/core/feedback/availability", () => ({
  isFeedbackConfigured: () => mocks.feedbackAvailable,
  ensureFeedbackAvailability: async () => mocks.feedbackAvailable,
  useFeedbackConfigured: () => mocks.feedbackAvailable,
}));
vi.mock("@/core/net/proxyFetch", () => ({
  proxyFetch: mocks.proxyFetch,
}));

import { FEEDBACK_TAGS, isFeedbackConfigured, submitFeedback } from "./submit";

describe("feedback submission", () => {
  beforeEach(() => {
    mocks.activity = false;
    mocks.feedbackAvailable = true;
    mocks.proxyFetch.mockReset();
    mocks.proxyFetch.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it("sends the allow-listed report shape to the anonymous web relay", async () => {
    const result = await submitFeedback({
      tag: FEEDBACK_TAGS[1]!,
      summary: "  Preview clips on mobile  ",
      details: "  Reproduce by resizing the preview.  ",
      contact: "  helper  ",
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.proxyFetch).toHaveBeenCalledOnce();
    const [path, init] = mocks.proxyFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/feedback");
    expect(JSON.parse(String(init.body))).toEqual({
      category: "bug",
      summary: "Preview clips on mobile",
      details: "Reproduce by resizing the preview.",
      contact: "helper",
    });
  });

  it("keeps Activity feedback on its bearer-aware endpoint", async () => {
    mocks.activity = true;
    await submitFeedback({
      tag: FEEDBACK_TAGS[0]!,
      summary: "Suggestion",
      details: "Please add this.",
    });

    expect(mocks.proxyFetch).toHaveBeenCalledWith(
      "/api/activity/feedback",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("is gated by the server capability, not by a browser webhook credential", async () => {
    mocks.feedbackAvailable = false;
    expect(isFeedbackConfigured()).toBe(false);

    const result = await submitFeedback({
      tag: FEEDBACK_TAGS[3]!,
      summary: "Other",
      details: "Some feedback.",
    });

    expect(result).toEqual({ ok: false, error: "Feedback isn’t available in this build." });
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it("surfaces the proxy's safe error response", async () => {
    mocks.proxyFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "Too many requests — slow down." }), {
        status: 429,
      }),
    );

    const result = await submitFeedback({
      tag: FEEDBACK_TAGS[2]!,
      summary: "Question",
      details: "How does this work?",
    });

    expect(result).toEqual({ ok: false, error: "Too many requests — slow down." });
  });
});
