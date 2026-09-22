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

import { getMessageDocumentGeneration, uniqueCustomId, useMessageStore } from "./messageStore";
import {
  ButtonStyle,
  ComponentType,
  walk,
  type TopLevelComponent,
  type WebhookMessage,
} from "@/core/schema";

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

describe("whole-document generation", () => {
  beforeEach(() => {
    seed({ components: [textDisplay("t1", "hello")] });
  });

  it("advances for replacements but not ordinary edits", () => {
    const initial = getMessageDocumentGeneration();
    useMessageStore.getState().setUsername("same document");
    expect(getMessageDocumentGeneration()).toBe(initial);

    useMessageStore.getState().replaceMessage({
      components: [textDisplay("replacement", "new document")],
    });
    expect(getMessageDocumentGeneration()).toBe(initial + 1);

    useMessageStore.getState().clearAll();
    expect(getMessageDocumentGeneration()).toBe(initial + 2);
  });
});

/**
 * Every factory hands a new button/select the same readable default custom_id
 * (`btn_action`, `select_option`…). Discord requires custom_ids to be unique per
 * message, so the store makes them unique *on insert and on duplicate* — the
 * second button someone adds must never arrive already flagged on both rows.
 */
describe("custom_id uniqueness on insert and duplicate", () => {
  function button(id: string, customId: string) {
    return {
      _id: id,
      type: ComponentType.Button,
      style: ButtonStyle.Primary,
      label: "Click me",
      custom_id: customId,
    };
  }
  function row(id: string, buttons: ReturnType<typeof button>[]): TopLevelComponent {
    return {
      _id: id,
      type: ComponentType.ActionRow,
      components: buttons,
    } as unknown as TopLevelComponent;
  }
  function customIds(): string[] {
    const ids: string[] = [];
    for (const node of walk(useMessageStore.getState().message)) {
      const cid = (node as { custom_id?: string }).custom_id;
      if (cid) ids.push(cid);
    }
    return ids;
  }

  beforeEach(() => {
    seed({ components: [row("r1", [button("b1", "btn_action")])] });
  });

  it("a button added to a row never reuses the default already in the message", () => {
    useMessageStore.getState().addRowButton("r1");
    expect(customIds()).toEqual(["btn_action", "btn_action_2"]);
  });

  it("a button added at the top level gets its own id too", () => {
    useMessageStore.getState().addTopLevelComponent(ComponentType.Button);
    expect(customIds()).toEqual(["btn_action", "btn_action_2"]);
  });

  it("duplicating a button copies it under a fresh id", () => {
    useMessageStore.getState().duplicate("b1");
    expect(customIds()).toEqual(["btn_action", "btn_action_2"]);
  });

  it("duplicating a whole row renames every button in the copy", () => {
    seed({ components: [row("r1", [button("b1", "yes"), button("b2", "no")])] });
    useMessageStore.getState().duplicate("r1");
    expect(customIds()).toEqual(["yes", "no", "yes_2", "no_2"]);
  });

  it("bumps an existing numeric suffix instead of stacking one", () => {
    seed({ components: [row("r1", [button("b1", "btn_action"), button("b2", "btn_action_2")])] });
    useMessageStore.getState().duplicate("b2");
    expect(customIds()).toEqual(["btn_action", "btn_action_2", "btn_action_3"]);
  });

  it("copies a plugin binding verbatim — renaming it would route to a missing instance", () => {
    seed({ components: [row("r1", [button("b1", "giveaway:abc123")])] });
    useMessageStore.getState().duplicate("b1");
    expect(customIds()).toEqual(["giveaway:abc123", "giveaway:abc123"]);
  });

  it("uniqueCustomId leaves an unused id alone and otherwise suffixes it", () => {
    expect(uniqueCustomId("btn_action", new Set())).toBe("btn_action");
    expect(uniqueCustomId("btn_action", new Set(["btn_action"]))).toBe("btn_action_2");
    expect(uniqueCustomId("btn_action_2", new Set(["btn_action_2"]))).toBe("btn_action_3");
    expect(uniqueCustomId("btn_action", new Set(["btn_action", "btn_action_2"]))).toBe(
      "btn_action_3",
    );
  });
});
