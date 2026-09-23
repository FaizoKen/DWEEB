/**
 * Pure rules behind the component tree's row actions, kept out of
 * ComponentTree.tsx so they're testable without a DOM.
 */

import { COMPONENT_META } from "@/core/schema/metadata";
import { LIMITS } from "@/core/schema/limits";
import { ComponentType } from "@/core/schema/types";
import type { SiblingMovePlan } from "@/core/state/messageStore";

/**
 * Everything an up/down arrow renders from, as one string — cheap for a store
 * selector to return (a fresh plan object would re-render the row on every
 * edit). `top-level-full` is a `none` plan the user can't see a reason for.
 */
export type MoveArrowKey = SiblingMovePlan["kind"] | "top-level-full";

export function moveArrowKey(plan: SiblingMovePlan): MoveArrowKey {
  return plan.kind === "none" && plan.blocked === "top-level-full" ? "top-level-full" : plan.kind;
}

/**
 * An arrow's label and tooltip: what pressing it will really do. A move into
 * or out of a Container says so — a bare "Move up" that silently re-parented
 * the component was the old surprise. A direction with nowhere to go keeps its
 * plain name (the button renders disabled), except when the only thing in the
 * way is the top-level limit, which nothing on screen would otherwise explain.
 */
export function moveArrowLabel(key: MoveArrowKey, direction: -1 | 1): string {
  const up = direction === -1;
  const container = COMPONENT_META[ComponentType.Container].label;
  switch (key) {
    case "enter":
      return `Move into the ${container} ${up ? "above" : "below"}`;
    case "exit":
      return `Move ${up ? "up" : "down"} out of the ${container}`;
    case "top-level-full":
      return `Can't move out of the ${container} — top-level limit of ${LIMITS.TOP_LEVEL_COMPONENTS} reached`;
    default:
      return up ? "Move up" : "Move down";
  }
}

/** How far (px, per axis) a mouse press may wander and still count as a click. */
export const CLICK_SLOP = 8;

/**
 * Whether to swallow the click a browser fires on a row after a drag gesture
 * ended there. A drag starts after a few pixels of mouse movement, so a shaky
 * click used to become a "drag" whose click was then eaten — the row simply
 * didn't open. Only that case gets its click back: a mouse press that stayed
 * within {@link CLICK_SLOP} and never showed a drop indicator. Anything that
 * travelled, showed where it would land, or came from touch/pen (whose drag
 * starts with a deliberate long-press) is still a drag.
 */
export function swallowsClickAfterDrag(gesture: {
  pointerType: string;
  dx: number;
  dy: number;
  showedDropTarget: boolean;
}): boolean {
  if (gesture.pointerType !== "mouse" || gesture.showedDropTarget) return true;
  return Math.abs(gesture.dx) > CLICK_SLOP || Math.abs(gesture.dy) > CLICK_SLOP;
}
