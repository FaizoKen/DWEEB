/**
 * Pins the undo ↔ collaboration interaction so the trade-off stays a *known*
 * one (see the collab.ts module docs and docs/activity.md "Limitations").
 *
 * Remote collab frames are applied with a bare `setState` — deliberately
 * outside the store's actions — so they never push an undo frame (the editor
 * must not "fight the typist", and a peer's keystrokes must not flood local
 * history). The corollary: the local undo stack snapshots *whole messages*
 * from before each local edit, so undoing after a peer's patch restores a
 * snapshot that predates their work — reverting it locally — and the collab
 * subscription then re-broadcasts that restored state as an ordinary local
 * change (last-write-wins, applied to time travel).
 *
 * If this test starts failing, one of two things happened: history gained
 * collab awareness (great — update the docs and rewrite this pin), or a
 * regression made remote applies push phantom undo frames (bad — a peer's
 * every patch would eat the local user's undo budget).
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useMessageStore } from "./messageStore";
import { ComponentType, type TopLevelComponent, type WebhookMessage } from "@/core/schema";

function textDisplay(id: string, content: string): TopLevelComponent {
  return { _id: id, type: ComponentType.TextDisplay, content } as unknown as TopLevelComponent;
}

/** The store is a module singleton — reset the slices this test reads. */
function seed(message: WebhookMessage): void {
  useMessageStore.setState({ message, past: [], future: [], selectedId: null });
}

function content(m: WebhookMessage): string {
  return (m.components[0] as unknown as { content: string }).content;
}

describe("undo vs. remote collab patches", () => {
  beforeEach(() => {
    seed({ components: [textDisplay("t1", "hello")] });
  });

  it("a remote apply pushes no history frame", () => {
    // Exactly what collab's applyPatch/applyFull do: a bare setState.
    useMessageStore.setState({ message: { components: [textDisplay("t1", "peer edit")] } });
    expect(useMessageStore.getState().past).toHaveLength(0);
    expect(useMessageStore.getState().canUndo()).toBe(false);
  });

  it("undo after a peer's patch restores the pre-edit snapshot, peer edit included", () => {
    const s = useMessageStore.getState();

    // 1. A local edit through a store action — pushes one history frame
    //    holding the pre-edit message.
    s.setUsername("me");
    expect(useMessageStore.getState().past).toHaveLength(1);

    // 2. A peer's patch lands (bare setState, as collab applies it): their
    //    edit is in the tree, but no history frame records it.
    const withPeerEdit: WebhookMessage = {
      ...useMessageStore.getState().message,
      components: [textDisplay("t1", "peer was here")],
    };
    useMessageStore.setState({ message: withPeerEdit });
    expect(useMessageStore.getState().past).toHaveLength(1);
    expect(content(useMessageStore.getState().message)).toBe("peer was here");

    // 3. Local undo restores the whole pre-edit snapshot — the username edit
    //    is undone AND the peer's edit is gone with it. (Collab would now
    //    broadcast this state to the room: last-write-wins, via time travel.)
    useMessageStore.getState().undo();
    const after = useMessageStore.getState();
    expect(after.message.username).toBeUndefined();
    expect(content(after.message)).toBe("hello");
  });
});
