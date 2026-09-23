import { describe, expect, it } from "vitest";

import { ComponentType, LIMITS, type TopLevelComponent, type WebhookMessage } from "@/core/schema";
import { planSiblingMove } from "@/core/state/messageStore";
import { CLICK_SLOP, moveArrowKey, moveArrowLabel, swallowsClickAfterDrag } from "./treeRowActions";

const text = (id: string) => ({ _id: id, type: ComponentType.TextDisplay, content: id });
const container = (id: string, children: unknown[]) => ({
  _id: id,
  type: ComponentType.Container,
  components: children,
});
const tree = (...components: unknown[]): WebhookMessage => ({
  components: components as TopLevelComponent[],
});

/** The label an arrow shows for `id` in `message`, straight from the store's plan. */
const label = (message: WebhookMessage, id: string, direction: -1 | 1) =>
  moveArrowLabel(moveArrowKey(planSiblingMove(message, id, direction)), direction);

describe("move arrow labels", () => {
  it("say a plain reorder plainly", () => {
    const m = tree(text("t1"), text("t2"), text("t3"));
    expect(label(m, "t2", -1)).toBe("Move up");
    expect(label(m, "t2", 1)).toBe("Move down");
  });

  it("name the Container an arrow steps into", () => {
    expect(label(tree(container("c1", [text("a")]), text("t1")), "t1", -1)).toBe(
      "Move into the Container above",
    );
    expect(label(tree(text("t1"), container("c1", [text("a")])), "t1", 1)).toBe(
      "Move into the Container below",
    );
  });

  it("say when an arrow steps out of the Container", () => {
    const m = tree(container("c1", [text("a"), text("b")]));
    expect(label(m, "a", -1)).toBe("Move up out of the Container");
    expect(label(m, "b", 1)).toBe("Move down out of the Container");
  });

  it("explain a way out shut by the top-level limit, with the number", () => {
    const m = tree(
      container("c1", [text("a")]),
      ...Array.from({ length: LIMITS.TOP_LEVEL_COMPONENTS - 1 }, (_, i) => text(`t${i}`)),
    );
    expect(moveArrowKey(planSiblingMove(m, "a", -1))).toBe("top-level-full");
    expect(label(m, "a", -1)).toBe(
      `Can't move out of the Container — top-level limit of ${LIMITS.TOP_LEVEL_COMPONENTS} reached`,
    );
  });

  it("keep the plain name at an edge, where the arrow renders disabled", () => {
    const m = tree(text("t1"), text("t2"));
    expect(moveArrowKey(planSiblingMove(m, "t1", -1))).toBe("none");
    expect(label(m, "t1", -1)).toBe("Move up");
    expect(label(m, "t2", 1)).toBe("Move down");
  });
});

describe("swallowsClickAfterDrag", () => {
  const mouse = { pointerType: "mouse", dx: 0, dy: 0, showedDropTarget: false };

  it("lets a mouse wobble through as a click", () => {
    expect(swallowsClickAfterDrag({ ...mouse, dx: 5, dy: -3 })).toBe(false);
    expect(swallowsClickAfterDrag({ ...mouse, dx: CLICK_SLOP, dy: CLICK_SLOP })).toBe(false);
  });

  it("swallows the click after a mouse drag that travelled", () => {
    expect(swallowsClickAfterDrag({ ...mouse, dy: CLICK_SLOP + 1 })).toBe(true);
    expect(swallowsClickAfterDrag({ ...mouse, dx: -40 })).toBe(true);
  });

  it("swallows it once a drop indicator was shown, however short the trip", () => {
    expect(swallowsClickAfterDrag({ ...mouse, dy: 3, showedDropTarget: true })).toBe(true);
  });

  it("always swallows it after a touch or pen drag", () => {
    expect(swallowsClickAfterDrag({ ...mouse, pointerType: "touch" })).toBe(true);
    expect(swallowsClickAfterDrag({ ...mouse, pointerType: "pen" })).toBe(true);
  });
});
