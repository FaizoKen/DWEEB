/**
 * The schedule origin must never outlive the document it was loaded with: a
 * replacement message saved into the old scheduled post would silently swap
 * what a server is about to receive.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearScheduleOrigin,
  currentScheduleOrigin,
  isArmedOriginCurrent,
  isScheduleEditable,
  loadScheduledPost,
  noteScheduleSaved,
  scheduleOriginFromView,
  type ScheduleOrigin,
} from "./scheduleOrigin";
import type { ScheduleView } from "./api";
import { resetAccountScopedState } from "@/core/auth/accountScopedState";
import { getMessageDocumentGeneration, useMessageStore } from "@/core/state/messageStore";
import { ComponentType, type TopLevelComponent, type WebhookMessage } from "@/core/schema";

function textMessage(content: string): WebhookMessage {
  return {
    components: [{ _id: "t", type: ComponentType.TextDisplay, content } as TopLevelComponent],
  };
}

function view(partial: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: "sched-1",
    webhook_id: "111111111111111111",
    guild_id: "222222222222222222",
    dest_label: "#general · Test server",
    tz: "Asia/Kuala_Lumpur",
    recurrence: { kind: "once" },
    next_run_at: 1_900_000_000,
    status: "active",
    attempts: 0,
    runs_count: 0,
    created_at: 1_800_000_000,
    owned: true,
    ...partial,
  };
}

const ORIGIN: ScheduleOrigin = scheduleOriginFromView(view());

describe("scheduleOriginFromView", () => {
  it("keeps what the Send panel needs and nothing credential-like", () => {
    expect(ORIGIN).toEqual({
      scheduleId: "sched-1",
      guildId: "222222222222222222",
      webhookId: "111111111111111111",
      runAt: 1_900_000_000,
      tz: "Asia/Kuala_Lumpur",
      destLabel: "#general · Test server",
      status: "active",
    });
    expect(scheduleOriginFromView(view({ guild_id: null, dest_label: "  " }))).toMatchObject({
      guildId: null,
      destLabel: null,
    });
  });

  it("only treats a post that hasn't started going out as editable", () => {
    expect(isScheduleEditable({ status: "active" })).toBe(true);
    expect(isScheduleEditable({ status: "paused" })).toBe(true);
    expect(isScheduleEditable({ status: "suspended" })).toBe(true);
    expect(isScheduleEditable({ status: "sending" })).toBe(false);
    expect(isScheduleEditable({ status: "done" })).toBe(false);
    expect(isScheduleEditable({ status: "failed" })).toBe(false);
  });
});

describe("the origin follows its document", () => {
  beforeEach(() => {
    clearScheduleOrigin();
    useMessageStore.setState({ message: textMessage("draft"), past: [], future: [] });
    loadScheduledPost(textMessage("scheduled"), ORIGIN);
  });

  it("is armed by loading the scheduled post", () => {
    expect(currentScheduleOrigin()).toMatchObject({ scheduleId: "sched-1" });
    expect(useMessageStore.getState().message.components[0]).toMatchObject({
      content: "scheduled",
    });
  });

  it("survives ordinary edits, and undoing them", () => {
    useMessageStore.getState().setUsername("Announcer");
    expect(currentScheduleOrigin()).not.toBeNull();
    useMessageStore.getState().undo();
    expect(currentScheduleOrigin()).not.toBeNull();
  });

  it.each([
    ["a template or import", () => useMessageStore.getState().replaceMessage(textMessage("x"))],
    ["Clear", () => useMessageStore.getState().clearAll()],
    ["the default preset", () => useMessageStore.getState().loadDefaultPreset()],
    [
      "a Restore",
      () =>
        useMessageStore.getState().replaceMessageFromRestore(textMessage("restored"), {
          webhookUrl: "https://discord.com/api/webhooks/1/abc",
          messageId: "333333333333333333",
        }),
    ],
  ])("is dropped by %s", (_label, replace) => {
    replace();
    expect(currentScheduleOrigin()).toBeNull();
  });

  it("is dropped by undoing the load itself", () => {
    useMessageStore.getState().setUsername("Announcer");
    useMessageStore.getState().undo(); // back to the loaded post — still editing it
    expect(currentScheduleOrigin()).not.toBeNull();
    useMessageStore.getState().undo(); // back to the draft the load replaced
    expect(currentScheduleOrigin()).toBeNull();
  });

  it("is replaced, not merged, when another scheduled post is loaded", () => {
    loadScheduledPost(textMessage("second"), { ...ORIGIN, scheduleId: "sched-2" });
    expect(currentScheduleOrigin()).toMatchObject({ scheduleId: "sched-2" });
  });

  it("is dropped by the end of the account's session", () => {
    resetAccountScopedState();
    expect(currentScheduleOrigin()).toBeNull();
  });

  it("carries a save's new time forward only for its own schedule", () => {
    noteScheduleSaved(view({ id: "someone-else", next_run_at: 1 }));
    expect(currentScheduleOrigin()?.runAt).toBe(1_900_000_000);
    noteScheduleSaved(view({ next_run_at: 1_900_003_600, status: "paused" }));
    expect(currentScheduleOrigin()).toMatchObject({ runAt: 1_900_003_600, status: "paused" });
  });

  it("clears only the named schedule", () => {
    clearScheduleOrigin("sched-9");
    expect(currentScheduleOrigin()).not.toBeNull();
    clearScheduleOrigin("sched-1");
    expect(currentScheduleOrigin()).toBeNull();
  });
});

describe("isArmedOriginCurrent — the generation guard", () => {
  it("refuses an origin from an earlier document, or a rolled-back one", () => {
    const loaded = textMessage("loaded");
    const before = textMessage("before");
    const generation = getMessageDocumentGeneration();
    const armed = { generation, replaced: before };
    expect(isArmedOriginCurrent(armed, generation, loaded)).toBe(true);
    expect(isArmedOriginCurrent(armed, generation + 1, loaded)).toBe(false);
    expect(isArmedOriginCurrent(armed, generation, before)).toBe(false);
  });
});
