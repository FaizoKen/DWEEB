import { beforeEach, describe, expect, it } from "vitest";
import { canDuplicateNode, freshCustomId, useMessageStore } from "@/core/state/messageStore";
import { validateMessage } from "@/core/schema/validation";
import { LIMITS } from "@/core/schema/limits";
import { ComponentType, type ActionRowComponent, type WebhookMessage } from "@/core/schema/types";

const store = () => useMessageStore.getState();

function rowOf(message: WebhookMessage): ActionRowComponent {
  return message.components[0] as ActionRowComponent;
}

describe("duplicate respects the parent's capacity", () => {
  beforeEach(() => {
    store().replaceMessage({ components: [] });
  });

  it("refuses a sixth button in a full row", () => {
    store().addTopLevelComponent(ComponentType.Button); // a row with one button
    const rowId = store().message.components[0]!._id;
    for (let i = 1; i < LIMITS.ACTION_ROW_BUTTONS; i++) store().addRowButton(rowId);
    const first = rowOf(store().message).components[0]!;
    expect(rowOf(store().message).components).toHaveLength(LIMITS.ACTION_ROW_BUTTONS);
    expect(canDuplicateNode(store().message, first._id)).toBe(false);

    const before = store().message;
    store().duplicate(first._id);
    expect(store().message).toBe(before);
    expect(rowOf(store().message).components).toHaveLength(LIMITS.ACTION_ROW_BUTTONS);
  });

  it("refuses a copy past the top-level limit", () => {
    for (let i = 0; i < LIMITS.TOP_LEVEL_COMPONENTS; i++) {
      store().addTopLevel(ComponentType.TextDisplay);
    }
    const first = store().message.components[0]!;
    expect(canDuplicateNode(store().message, first._id)).toBe(false);
    store().duplicate(first._id);
    expect(store().message.components).toHaveLength(LIMITS.TOP_LEVEL_COMPONENTS);
  });

  it("still duplicates where there is room, with a fresh custom_id", () => {
    store().addTopLevelComponent(ComponentType.Button);
    const button = rowOf(store().message).components[0]!;
    expect(canDuplicateNode(store().message, button._id)).toBe(true);
    store().duplicate(button._id);
    const row = rowOf(store().message);
    expect(row.components).toHaveLength(2);
    expect(validateMessage(store().message).issues.map((i) => i.code)).not.toContain(
      "CUSTOM_ID_DUPLICATE",
    );
  });
});

describe("freshCustomId for a button becoming interactive", () => {
  beforeEach(() => {
    store().replaceMessage({ components: [] });
  });

  it("never hands out an id another component holds", () => {
    store().addTopLevelComponent(ComponentType.Button); // btn_action
    const rowId = store().message.components[0]!._id;
    store().addRowButton(rowId); // btn_action_2
    const [first, second] = rowOf(store().message).components;
    // The second button's own id doesn't count against it…
    expect(freshCustomId("btn_action", second!._id)).toBe("btn_action_2");
    // …but the first button's always does.
    expect(freshCustomId("btn_action", first!._id)).toBe("btn_action");
    expect(freshCustomId("btn_action")).toBe("btn_action_3");
  });
});
