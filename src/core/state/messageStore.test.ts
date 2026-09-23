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

import {
  getMessageDocumentGeneration,
  planSiblingMove,
  uniqueCustomId,
  useMessageStore,
} from "./messageStore";
import {
  ButtonStyle,
  ComponentType,
  LIMITS,
  walk,
  type AnyComponent,
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

/*
 * Tree fixtures for the move tests. Ids double as labels, so a tree reads back
 * as a compact string: `t0 c1[a b] t9` is a text, a Container holding a and b,
 * then another text. A Section's accessory isn't a list entry and never moves,
 * so `shape` leaves it out.
 */
const text = (id: string) => ({ _id: id, type: ComponentType.TextDisplay, content: id });
const container = (id: string, children: unknown[]) => ({
  _id: id,
  type: ComponentType.Container,
  components: children,
});
const section = (id: string, texts: unknown[]) => ({
  _id: id,
  type: ComponentType.Section,
  components: texts,
  accessory: { _id: `${id}_acc`, type: ComponentType.Thumbnail, media: { url: "" } },
});
const buttonRow = (id: string, ids: string[]) => ({
  _id: id,
  type: ComponentType.ActionRow,
  components: ids.map((b) => ({
    _id: b,
    type: ComponentType.Button,
    style: ButtonStyle.Primary,
    label: b,
    custom_id: b,
  })),
});
const tree = (...components: unknown[]): WebhookMessage => ({
  components: components as TopLevelComponent[],
});
/** `count` texts with ids `${prefix}1`…, for filling a list to its limit. */
const texts = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => text(`${prefix}${i + 1}`));

function shape(message: WebhookMessage = useMessageStore.getState().message): string {
  const node = (n: AnyComponent): string => {
    const kids = (n as { components?: AnyComponent[] }).components;
    return Array.isArray(kids) ? `${n._id}[${kids.map(node).join(" ")}]` : n._id;
  };
  return message.components.map(node).join(" ");
}

function move(message: WebhookMessage, id: string, direction: -1 | 1): string {
  seed(message);
  useMessageStore.getState().moveSibling(id, direction);
  return shape();
}

/**
 * The arrow buttons' contract. Between the top level and Containers an arrow
 * can cross a boundary — step into an adjacent Container, or out of the one it
 * sits in at either edge — while Section texts and Buttons Row children only
 * ever reorder inside their own parent. Pinned against the pre-refactor store,
 * so extracting the decision into `planSiblingMove` changed nothing.
 */
describe("moveSibling", () => {
  it("swaps top-level siblings", () => {
    expect(move(tree(text("t1"), text("t2"), text("t3")), "t2", -1)).toBe("t2 t1 t3");
    expect(move(tree(text("t1"), text("t2"), text("t3")), "t2", 1)).toBe("t1 t3 t2");
  });

  it("steps into the Container above, landing last", () => {
    expect(move(tree(container("c1", [text("a")]), text("t1")), "t1", -1)).toBe("c1[a t1]");
  });

  it("steps into the Container below, landing first", () => {
    expect(move(tree(text("t1"), container("c1", [text("a")])), "t1", 1)).toBe("c1[t1 a]");
  });

  it("moves a whole Section or Buttons Row into a Container too", () => {
    const withSection = tree(container("c1", [text("a")]), section("s1", [text("x")]));
    expect(move(withSection, "s1", -1)).toBe("c1[a s1[x]]");
    const withRow = tree(buttonRow("r1", ["b1"]), container("c1", [text("a")]));
    expect(move(withRow, "r1", 1)).toBe("c1[r1[b1] a]");
  });

  it("swaps past a full Container instead of entering it", () => {
    const full = () => container("c1", texts("f", LIMITS.CONTAINER_CHILDREN));
    expect(move(tree(full(), text("t1")), "t1", -1).startsWith("t1 c1[")).toBe(true);
    expect(move(tree(text("t1"), full()), "t1", 1).endsWith("] t1")).toBe(true);
  });

  it("never nests a Container in a Container — it swaps past instead", () => {
    const pair = () => tree(container("c1", [text("a")]), container("c2", [text("b")]));
    expect(move(pair(), "c2", -1)).toBe("c2[b] c1[a]");
    expect(move(pair(), "c1", 1)).toBe("c2[b] c1[a]");
  });

  it("reorders a Container's children inside it", () => {
    const c = () => tree(container("c1", [text("a"), text("b"), text("c")]));
    expect(move(c(), "b", -1)).toBe("c1[b a c]");
    expect(move(c(), "b", 1)).toBe("c1[a c b]");
  });

  it("steps out of a Container at its first child, landing just above it", () => {
    const m = tree(text("t0"), container("c1", [text("a"), text("b")]), text("t9"));
    expect(move(m, "a", -1)).toBe("t0 a c1[b] t9");
  });

  it("steps out of a Container at its last child, landing just below it", () => {
    const m = tree(text("t0"), container("c1", [text("a"), text("b")]), text("t9"));
    expect(move(m, "b", 1)).toBe("t0 c1[a] b t9");
  });

  it("refuses to step out while the top level is full, without an undo step", () => {
    const m = tree(
      container("c1", [text("a"), text("b")]),
      ...texts("t", LIMITS.TOP_LEVEL_COMPONENTS - 1),
    );
    const before = shape(m);
    expect(move(m, "a", -1)).toBe(before);
    expect(move(m, "b", 1)).toBe(before);
    expect(useMessageStore.getState().past).toHaveLength(0);
    // Reordering inside the Container still works.
    expect(move(m, "a", 1).startsWith("c1[b a]")).toBe(true);
  });

  it("reorders Section texts only inside their Section", () => {
    const m = () => tree(text("t0"), section("s1", [text("x"), text("y")]), text("t9"));
    expect(move(m(), "x", -1)).toBe("t0 s1[x y] t9");
    expect(move(m(), "y", 1)).toBe("t0 s1[x y] t9");
    expect(move(m(), "x", 1)).toBe("t0 s1[y x] t9");
    // Inside a Container too: the text still can't leave its Section.
    expect(move(tree(container("c1", [section("s1", [text("x")])])), "x", -1)).toBe("c1[s1[x]]");
  });

  it("never moves a Section's accessory", () => {
    const m = tree(section("s1", [text("x")]), text("t1"));
    expect(move(m, "s1_acc", -1)).toBe("s1[x] t1");
    expect(move(m, "s1_acc", 1)).toBe("s1[x] t1");
    expect(useMessageStore.getState().message.components[0]).toMatchObject({
      accessory: { _id: "s1_acc" },
    });
  });

  it("reorders Buttons Row children only inside their row", () => {
    const m = () => tree(buttonRow("r1", ["b1", "b2"]), buttonRow("r2", ["b3"]));
    expect(move(m(), "b2", 1)).toBe("r1[b1 b2] r2[b3]");
    expect(move(m(), "b1", -1)).toBe("r1[b1 b2] r2[b3]");
    expect(move(m(), "b1", 1)).toBe("r1[b2 b1] r2[b3]");
    expect(move(m(), "b3", -1)).toBe("r1[b1 b2] r2[b3]");
  });

  it("does nothing at the absolute edges, and records no undo step", () => {
    expect(move(tree(text("t1"), text("t2")), "t1", -1)).toBe("t1 t2");
    expect(useMessageStore.getState().past).toHaveLength(0);
    expect(move(tree(text("t1"), text("t2")), "t2", 1)).toBe("t1 t2");
    expect(useMessageStore.getState().past).toHaveLength(0);
  });

  it("records one undo step for a move that happens", () => {
    move(tree(text("t1"), text("t2")), "t2", -1);
    expect(useMessageStore.getState().past).toHaveLength(1);
    useMessageStore.getState().undo();
    expect(shape()).toBe("t1 t2");
  });
});

/** The decision `moveSibling` carries out, and the tree's arrows describe. */
describe("planSiblingMove", () => {
  it("plans a swap as a reorder with moveToParent's pre-removal index", () => {
    const m = tree(text("t1"), text("t2"), text("t3"));
    expect(planSiblingMove(m, "t2", -1)).toEqual({
      kind: "reorder",
      targetParentId: null,
      targetIndex: 0,
    });
    expect(planSiblingMove(m, "t2", 1)).toEqual({
      kind: "reorder",
      targetParentId: null,
      targetIndex: 3,
    });
    const inside = tree(container("c1", [text("a"), text("b")]));
    expect(planSiblingMove(inside, "a", 1)).toEqual({
      kind: "reorder",
      targetParentId: "c1",
      targetIndex: 2,
    });
  });

  it("plans entering the Container above at its end, and the one below at its start", () => {
    const above = tree(container("c1", [text("a"), text("b")]), text("t1"));
    expect(planSiblingMove(above, "t1", -1)).toEqual({
      kind: "enter",
      targetParentId: "c1",
      targetIndex: 2,
    });
    const below = tree(text("t1"), container("c1", [text("a")]));
    expect(planSiblingMove(below, "t1", 1)).toEqual({
      kind: "enter",
      targetParentId: "c1",
      targetIndex: 0,
    });
  });

  it("plans a plain reorder past a full Container, or a Container past a Container", () => {
    const full = tree(container("c1", texts("f", LIMITS.CONTAINER_CHILDREN)), text("t1"));
    expect(planSiblingMove(full, "t1", -1).kind).toBe("reorder");
    const pair = tree(container("c1", []), container("c2", []));
    expect(planSiblingMove(pair, "c2", -1).kind).toBe("reorder");
  });

  it("plans stepping out of a Container to just above or below it", () => {
    const m = tree(text("t0"), container("c1", [text("a"), text("b")]), text("t9"));
    expect(planSiblingMove(m, "a", -1)).toEqual({
      kind: "exit",
      targetParentId: null,
      targetIndex: 1,
    });
    expect(planSiblingMove(m, "b", 1)).toEqual({
      kind: "exit",
      targetParentId: null,
      targetIndex: 2,
    });
  });

  it("says why stepping out is blocked when the top level is full", () => {
    const m = tree(
      container("c1", [text("a"), text("b")]),
      ...texts("t", LIMITS.TOP_LEVEL_COMPONENTS - 1),
    );
    expect(planSiblingMove(m, "a", -1)).toEqual({ kind: "none", blocked: "top-level-full" });
    expect(planSiblingMove(m, "b", 1)).toEqual({ kind: "none", blocked: "top-level-full" });
  });

  it("plans nothing at a list's edge, for an accessory, or for an unknown id", () => {
    const m = tree(section("s1", [text("x"), text("y")]), buttonRow("r1", ["b1"]), text("t1"));
    expect(planSiblingMove(m, "s1", -1)).toEqual({ kind: "none" });
    expect(planSiblingMove(m, "t1", 1)).toEqual({ kind: "none" });
    expect(planSiblingMove(m, "x", -1)).toEqual({ kind: "none" });
    expect(planSiblingMove(m, "y", 1)).toEqual({ kind: "none" });
    expect(planSiblingMove(m, "b1", -1)).toEqual({ kind: "none" });
    expect(planSiblingMove(m, "s1_acc", 1)).toEqual({ kind: "none" });
    expect(planSiblingMove(m, "missing", 1)).toEqual({ kind: "none" });
  });

  it("is what moveSibling does, for every node in both directions", () => {
    // `moveSibling` must be exactly "apply the plan": the tree labels its
    // arrows from the plan, so any divergence would make an arrow lie.
    const fixtures: WebhookMessage[] = [
      tree(
        text("t0"),
        container("c1", [
          text("a"),
          section("s1", [text("x"), text("y")]),
          buttonRow("r1", ["b1"]),
        ]),
        buttonRow("r2", ["b2", "b3"]),
        container("c2", [text("d")]),
        container("c3", []),
        section("s2", [text("z")]),
      ),
      tree(container("c1", [text("a"), text("b")]), ...texts("t", LIMITS.TOP_LEVEL_COMPONENTS - 1)),
      tree(container("c1", texts("f", LIMITS.CONTAINER_CHILDREN)), text("t1"), container("c2", [])),
    ];
    for (const fixture of fixtures) {
      const ids = [...walk(fixture)].map((n) => n._id);
      for (const id of ids) {
        for (const direction of [-1, 1] as const) {
          const plan = planSiblingMove(fixture, id, direction);
          seed(fixture);
          useMessageStore.getState().moveSibling(id, direction);
          const moved = useMessageStore.getState();
          seed(fixture);
          if (plan.kind !== "none") {
            useMessageStore.getState().moveToParent(id, plan.targetParentId, plan.targetIndex);
          }
          const planned = useMessageStore.getState();
          const where = `${id} ${direction === -1 ? "up" : "down"} (${plan.kind})`;
          expect(moved.message, where).toEqual(planned.message);
          expect(moved.past.length, where).toBe(planned.past.length);
          // A planned move always changes the tree; `none` never does.
          expect(shape(moved.message) === shape(fixture), where).toBe(plan.kind === "none");
        }
      }
    }
  });
});
