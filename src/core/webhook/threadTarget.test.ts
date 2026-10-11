import { describe, expect, it } from "vitest";
import type { WebhookMessage } from "@/core/schema/types";
import { forThreadTarget } from "./threadTarget";

const POST = "1558142497497022585";
const titled: WebhookMessage = {
  components: [],
  thread_name: "Patch notes",
  applied_tags: ["1185234567890123456"],
};

describe("forThreadTarget", () => {
  // 2026-10-12: a picked post + a leftover title answered 400 code 220002.
  it("leaves the fields that start a forum post out of a post into a thread", () => {
    const out = forThreadTarget(titled, POST);
    expect(out.thread_name).toBeUndefined();
    expect(out.applied_tags).toBeUndefined();
    expect(out.components).toBe(titled.components);
    expect(titled.thread_name).toBe("Patch notes"); // the draft itself is untouched
  });

  it("keeps them for a new post — they are what starts it", () => {
    expect(forThreadTarget(titled, "")).toBe(titled);
    expect(forThreadTarget(titled, "  ")).toBe(titled);
    expect(forThreadTarget(titled, undefined)).toBe(titled);
  });

  it("returns the message itself when there is nothing to drop", () => {
    const plain: WebhookMessage = { components: [] };
    expect(forThreadTarget(plain, POST)).toBe(plain);
  });
});
