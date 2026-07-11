import { describe, expect, it } from "vitest";

import { fieldForIssueCode, routeMessageIssues, sectionForField } from "./optionsReveal";
import type { ValidationIssue } from "@/core/schema/validation";

describe("fieldForIssueCode — message-level issues find their home field", () => {
  it("routes every field-owned code", () => {
    expect(fieldForIssueCode("USERNAME_TOO_LONG")).toBe("username");
    expect(fieldForIssueCode("USERNAME_RESERVED")).toBe("username");
    expect(fieldForIssueCode("AVATAR_URL_INVALID")).toBe("avatar");
    expect(fieldForIssueCode("AVATAR_URL_TOO_LONG")).toBe("avatar");
    expect(fieldForIssueCode("THREAD_NAME_REQUIRED")).toBe("thread_name");
    expect(fieldForIssueCode("THREAD_NAME_FORBIDDEN")).toBe("thread_name");
    expect(fieldForIssueCode("THREAD_NAME_LONG")).toBe("thread_name");
    expect(fieldForIssueCode("APPLIED_TAG_BAD")).toBe("applied_tags");
    expect(fieldForIssueCode("APPLIED_TAGS_LIMIT")).toBe("applied_tags");
    expect(fieldForIssueCode("APPLIED_TAGS_NO_THREAD")).toBe("applied_tags");
    expect(fieldForIssueCode("ALLOWED_MENTIONS_BAD_ROLE")).toBe("mention_roles");
    expect(fieldForIssueCode("ALLOWED_MENTIONS_CONFLICT_ROLES")).toBe("mention_roles");
    expect(fieldForIssueCode("ALLOWED_MENTIONS_BAD_USER")).toBe("mention_users");
    expect(fieldForIssueCode("ALLOWED_MENTIONS_CONFLICT_USERS")).toBe("mention_users");
  });

  it("leaves truly message-wide codes homeless (they stay in the banner)", () => {
    expect(fieldForIssueCode("EMPTY_MESSAGE")).toBeNull();
    expect(fieldForIssueCode("TOP_LEVEL_LIMIT")).toBeNull();
    expect(fieldForIssueCode("TOTAL_COMPONENT_LIMIT")).toBeNull();
    expect(fieldForIssueCode("TOTAL_CHARACTER_LIMIT")).toBeNull();
    // Node-scoped codes never reach the router in practice, but stay null too.
    expect(fieldForIssueCode("BUTTON_NO_LABEL")).toBeNull();
  });
});

describe("sectionForField — which Message-options lane hosts a field", () => {
  it("maps lane fields, and meta-header fields to none", () => {
    expect(sectionForField("thread_name")).toBe("forum");
    expect(sectionForField("applied_tags")).toBe("forum");
    expect(sectionForField("mention_roles")).toBe("notification");
    expect(sectionForField("mention_users")).toBe("notification");
    expect(sectionForField("username")).toBeNull();
    expect(sectionForField("avatar")).toBeNull();
  });
});

describe("routeMessageIssues — grouping into field slots", () => {
  const issue = (code: string, severity: "error" | "warning", message = code): ValidationIssue => ({
    code,
    severity,
    message,
  });

  it("keeps the first error and first warning per field, in issue order", () => {
    const routed = routeMessageIssues([
      issue("APPLIED_TAG_BAD", "error", "bad tag"),
      issue("APPLIED_TAGS_LIMIT", "error", "too many tags"),
      issue("APPLIED_TAGS_NO_THREAD", "warning", "tags need a thread"),
      issue("THREAD_NAME_REQUIRED", "error", "needs a title"),
    ]);
    expect(routed.get("applied_tags")).toEqual({
      error: "bad tag",
      warning: "tags need a thread",
    });
    expect(routed.get("thread_name")).toEqual({ error: "needs a title" });
  });

  it("skips homeless codes entirely", () => {
    const routed = routeMessageIssues([issue("TOP_LEVEL_LIMIT", "error")]);
    expect(routed.size).toBe(0);
  });
});
