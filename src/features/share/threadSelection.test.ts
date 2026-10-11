import { describe, expect, it } from "vitest";
import type { ChannelThread } from "@/core/guild/api";
import { filterThreads, forumNeedsPost, isForumType, threadTags } from "./threadSelection";

const thread = (over: Partial<ChannelThread> = {}): ChannelThread => ({
  id: "1558142497497022585",
  name: "Feature requests",
  type: 11,
  archived: false,
  locked: false,
  pinned: false,
  ...over,
});

describe("isForumType", () => {
  it("is forum and media channels only", () => {
    expect(isForumType(15)).toBe(true);
    expect(isForumType(16)).toBe(true);
    for (const t of [0, 5, 10, 11, null, undefined]) expect(isForumType(t)).toBe(false);
  });
});

describe("forumNeedsPost", () => {
  const base = { mode: "new" as const, channelType: 15, threadId: "", postTitle: "" };

  it("flags a new forum message with neither a post nor a title", () => {
    expect(forumNeedsPost(base)).toBe(true);
    expect(forumNeedsPost({ ...base, postTitle: "   " })).toBe(true);
  });

  it("is satisfied by a picked post or a post title", () => {
    expect(forumNeedsPost({ ...base, threadId: "1558142497497022585" })).toBe(false);
    expect(forumNeedsPost({ ...base, postTitle: "Patch notes" })).toBe(false);
  });

  it("never applies to an update, a regular channel, or an unknown channel", () => {
    expect(forumNeedsPost({ ...base, mode: "update" })).toBe(false);
    expect(forumNeedsPost({ ...base, channelType: 0 })).toBe(false);
    expect(forumNeedsPost({ ...base, channelType: undefined })).toBe(false);
  });
});

describe("filterThreads", () => {
  const list = [thread({ id: "1", name: "Bug reports" }), thread({ id: "2", name: "Ideas" })];

  it("matches names case-insensitively and leaves an empty query alone", () => {
    expect(filterThreads(list, "  bug ").map((t) => t.id)).toEqual(["1"]);
    expect(filterThreads(list, "")).toBe(list);
  });

  it("finds a thread by its exact id", () => {
    expect(filterThreads(list, "2").map((t) => t.id)).toEqual(["2"]);
  });
});

describe("threadTags", () => {
  it("names a closed forum post a post, and a closed thread archived", () => {
    expect(threadTags(thread({ archived: true }), true)).toEqual(["Closed"]);
    expect(threadTags(thread({ archived: true }), false)).toEqual(["Archived"]);
  });

  it("says locked instead of closed, and pinned first", () => {
    expect(threadTags(thread({ archived: true, locked: true, pinned: true }), true)).toEqual([
      "Pinned",
      "Locked",
    ]);
    expect(threadTags(thread(), true)).toEqual([]);
  });
});
