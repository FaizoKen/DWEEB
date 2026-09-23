/**
 * The confirm flow every whole-draft action in the Activity goes through: it
 * runs at once when nobody else would lose anything, and otherwise waits for an
 * explicit yes — a cancel must leave the shared draft untouched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";
import type { CollabParticipant } from "./collab";

const activity = vi.hoisted(() => ({
  participants: [] as CollabParticipant[],
  user: { id: "me", name: "Faiz", avatar: null } as { id: string } | null,
}));
vi.mock("./activityStore", () => ({
  useActivityStore: { getState: () => activity },
}));

import { useMessageStore } from "@/core/state/messageStore";
import {
  cancelRoomReplace,
  confirmRoomReplace,
  requestRoomReplace,
  useRoomReplaceStore,
} from "./roomReplaceConfirm";

const me: CollabParticipant = { id: "me", name: "Faiz", avatar: null };
const ana: CollabParticipant = { id: "ana", name: "Ana", avatar: null };
const work = {
  components: [{ _id: "t", type: ComponentType.TextDisplay, content: "Our announcement" }],
} as unknown as WebhookMessage;

describe("requestRoomReplace", () => {
  beforeEach(() => {
    useRoomReplaceStore.setState({ pending: null });
    useMessageStore.setState({ message: work });
    activity.participants = [me, ana];
  });

  it("runs straight away for solo use — no extra step", () => {
    activity.participants = [me];
    const run = vi.fn();
    requestRoomReplace({ action: "Starting from scratch", run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(useRoomReplaceStore.getState().pending).toBeNull();
  });

  it("runs straight away when the draft holds nothing to lose", () => {
    useMessageStore.setState({ message: { components: [] } });
    const run = vi.fn();
    requestRoomReplace({ action: "Loading the “Welcome” template", run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(useRoomReplaceStore.getState().pending).toBeNull();
  });

  it("waits for a yes while someone else is editing a draft with work in it", () => {
    const run = vi.fn();
    requestRoomReplace({ action: "Restoring this message", confirmLabel: "Restore", run });
    expect(run).not.toHaveBeenCalled();
    expect(useRoomReplaceStore.getState().pending).toMatchObject({
      action: "Restoring this message",
      confirmLabel: "Restore",
    });

    confirmRoomReplace();
    expect(run).toHaveBeenCalledTimes(1);
    expect(useRoomReplaceStore.getState().pending).toBeNull();
    // A stray second confirm can't run it again.
    confirmRoomReplace();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("drops the replace on cancel", () => {
    const run = vi.fn();
    requestRoomReplace({ action: "Importing this JSON", run });
    cancelRoomReplace();
    expect(useRoomReplaceStore.getState().pending).toBeNull();
    confirmRoomReplace();
    expect(run).not.toHaveBeenCalled();
  });
});
