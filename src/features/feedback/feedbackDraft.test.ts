/**
 * An unsent feedback report survives the dialog closing — until it is sent or
 * discarded — and storage that is missing, blocked, or tampered with can never
 * break the dialog that reads it (the read runs in a `useState` initializer).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_DETAILS_MAX, FEEDBACK_SUMMARY_MAX, FEEDBACK_TAGS } from "@/core/feedback/submit";
import {
  clearFeedbackDraft,
  isEmptyFeedbackDraft,
  loadFeedbackDraft,
  saveFeedbackDraft,
  type FeedbackDraft,
} from "./feedbackDraft";

const KEY = "dweeb.feedback.draft.v1";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

const REPORT: FeedbackDraft = {
  tagIndex: 1,
  summary: "Preview clips long embeds",
  details: "Open a long container on a phone and scroll.",
  contact: "someone",
};

afterEach(() => vi.unstubAllGlobals());

describe("feedback draft", () => {
  it("round-trips a report, then forgets it once cleared", () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    saveFeedbackDraft(REPORT);
    expect(loadFeedbackDraft()).toEqual(REPORT);

    clearFeedbackDraft();
    expect(loadFeedbackDraft()).toBeNull();
  });

  it("drops the saved copy when the form is emptied — a picked type alone isn't a report", () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    saveFeedbackDraft(REPORT);
    saveFeedbackDraft({ tagIndex: 2, summary: " ", details: "", contact: "" });

    expect(storage.getItem(KEY)).toBeNull();
    expect(loadFeedbackDraft()).toBeNull();
    expect(isEmptyFeedbackDraft({ tagIndex: 3, summary: "", details: "\n", contact: "" })).toBe(
      true,
    );
  });

  it("repairs a tampered record instead of trusting it", () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    storage.setItem(
      KEY,
      JSON.stringify({
        tagIndex: FEEDBACK_TAGS.length + 4,
        summary: "s".repeat(FEEDBACK_SUMMARY_MAX + 50),
        details: 42,
      }),
    );

    expect(loadFeedbackDraft()).toEqual({
      tagIndex: 0,
      summary: "s".repeat(FEEDBACK_SUMMARY_MAX),
      details: "",
      contact: "",
    });

    storage.setItem(KEY, JSON.stringify({ details: "d".repeat(FEEDBACK_DETAILS_MAX + 1) }));
    expect(loadFeedbackDraft()?.details).toHaveLength(FEEDBACK_DETAILS_MAX);

    storage.setItem(KEY, "{not json");
    expect(loadFeedbackDraft()).toBeNull();
    storage.setItem(KEY, "null");
    expect(loadFeedbackDraft()).toBeNull();
  });

  it("never throws when storage is missing or blocked", () => {
    // No sessionStorage at all (this suite runs in Node).
    expect(loadFeedbackDraft()).toBeNull();
    expect(() => saveFeedbackDraft(REPORT)).not.toThrow();
    expect(() => clearFeedbackDraft()).not.toThrow();

    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.stubGlobal("sessionStorage", {
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
    });
    expect(loadFeedbackDraft()).toBeNull();
    expect(() => saveFeedbackDraft(REPORT)).not.toThrow();
    expect(() => clearFeedbackDraft()).not.toThrow();
  });
});
