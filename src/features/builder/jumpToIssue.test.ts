import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./scrollTreeRow", () => ({
  scrollTreeRowIntoView: vi.fn(),
  scrollPreviewNodeIntoView: vi.fn(),
}));

import { chipJumpTarget, issueDestination, jumpToIssue } from "./jumpToIssue";
import { scrollPreviewNodeIntoView, scrollTreeRowIntoView } from "./scrollTreeRow";
import { useOptionsRevealStore } from "./optionsReveal";
import { useMessageStore } from "@/core/state/messageStore";
import type { ValidationIssue } from "@/core/schema/validation";

function issue(partial: Partial<ValidationIssue> & { code: string }): ValidationIssue {
  return { severity: "error", message: partial.code, ...partial };
}

describe("issueDestination", () => {
  it("sends a component issue to its node", () => {
    expect(issueDestination({ nodeId: "n1", code: "TEXT_EMPTY" })).toEqual({
      kind: "node",
      nodeId: "n1",
    });
  });

  it("sends a message-level issue to its home field, or the options card", () => {
    expect(issueDestination({ code: "USERNAME_RESERVED" })).toEqual({
      kind: "message",
      field: "username",
    });
    expect(issueDestination({ code: "THREAD_NAME_REQUIRED" })).toEqual({
      kind: "message",
      field: "thread_name",
    });
    expect(issueDestination({ code: "TOTAL_CHARACTER_LIMIT" })).toEqual({
      kind: "message",
      field: null,
    });
  });

  it("has nowhere to take an empty message", () => {
    expect(issueDestination({ code: "EMPTY_MESSAGE" })).toBeNull();
  });
});

describe("jumpToIssue", () => {
  beforeEach(() => {
    vi.mocked(scrollTreeRowIntoView).mockClear();
    vi.mocked(scrollPreviewNodeIntoView).mockClear();
    useMessageStore.setState({ selectedId: null });
    useOptionsRevealStore.setState({ field: null, token: 0 });
  });

  it("selects a node and scrolls both its tree row and its preview", () => {
    expect(jumpToIssue({ nodeId: "btn-1", code: "BUTTON_NO_LABEL" })).toBe(true);
    expect(useMessageStore.getState().selectedId).toBe("btn-1");
    expect(scrollTreeRowIntoView).toHaveBeenCalledWith("btn-1");
    expect(scrollPreviewNodeIntoView).toHaveBeenCalledWith("btn-1");
    expect(useOptionsRevealStore.getState().token).toBe(0);
  });

  it("reveals a message-level issue's field without touching the selection", () => {
    expect(jumpToIssue({ code: "ALLOWED_MENTIONS_BAD_ROLE" })).toBe(true);
    expect(useOptionsRevealStore.getState()).toMatchObject({ field: "mention_roles", token: 1 });
    expect(useMessageStore.getState().selectedId).toBeNull();
    expect(scrollTreeRowIntoView).not.toHaveBeenCalled();
  });

  it("reports that an issue with no destination went nowhere, and does nothing", () => {
    expect(jumpToIssue({ code: "EMPTY_MESSAGE" })).toBe(false);
    expect(useMessageStore.getState().selectedId).toBeNull();
    expect(useOptionsRevealStore.getState().token).toBe(0);
    expect(scrollTreeRowIntoView).not.toHaveBeenCalled();
  });
});

describe("chipJumpTarget", () => {
  const base = {
    errorCount: 0,
    firstErrorNodeId: null,
    firstWarningNodeId: null,
    messageIssues: [] as ValidationIssue[],
  };

  it("prefers the first component of the dominant severity", () => {
    expect(
      chipJumpTarget({ ...base, errorCount: 2, firstErrorNodeId: "e1", firstWarningNodeId: "w1" }),
    ).toEqual({ nodeId: "e1", code: "" });
    expect(chipJumpTarget({ ...base, firstWarningNodeId: "w1" })).toEqual({
      nodeId: "w1",
      code: "",
    });
  });

  it("skips an empty-message error for a reachable message-level issue", () => {
    const reserved = issue({ code: "USERNAME_RESERVED" });
    expect(
      chipJumpTarget({
        ...base,
        errorCount: 2,
        messageIssues: [issue({ code: "EMPTY_MESSAGE" }), reserved],
      }),
    ).toBe(reserved);
  });

  it("falls back to a warned-about component when no error is reachable", () => {
    expect(
      chipJumpTarget({
        ...base,
        errorCount: 1,
        firstWarningNodeId: "w1",
        messageIssues: [issue({ code: "EMPTY_MESSAGE" })],
      }),
    ).toEqual({ nodeId: "w1", code: "" });
  });

  it("returns null when nothing is reachable", () => {
    expect(
      chipJumpTarget({ ...base, errorCount: 1, messageIssues: [issue({ code: "EMPTY_MESSAGE" })] }),
    ).toBeNull();
  });
});
