/**
 * `Field` wires its label, hint and error to the control the caller rendered, by
 * walking the returned element tree and cloning accessibility props onto it.
 * Walking someone else's tree means rewriting props it does not own, and these
 * tests pin the one rule that makes that safe: **only descend into a subtree
 * that actually exists.**
 *
 * The regression they guard is a real production crash (a `boundary` beacon from
 * the shipped 0.12.0 build). `Menu` takes a render prop — `children` is a
 * *function*, `(close) => ReactNode` — and `EmojiField` renders a `<Menu>` inside
 * a `<Field>`. `wireControl` used to recurse whenever `children` was not
 * `undefined`, so it handed that function to `Children.map`. Preact's
 * `Children.map` wraps a lone child into an array, and the clone wrote `[fn]`
 * back over `children` — so the moment the user opened the emoji picker, `Menu`
 * invoked an array and the whole app fell to the ErrorBoundary with
 * "children is not a function".
 *
 * Elements are built with `createElement` rather than JSX so the suite stays a
 * plain `.ts` file, and the config aliases `react` → `preact/compat` so the
 * `Children.map` semantics under test are the ones that actually ship.
 */

import { describe, expect, it } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { counterState, wireControl } from "@/ui/Field";

const CONTROL_ID = "field-1";
const DESCRIBED_BY = ["field-1-hint"];

/** Stand-in for `Menu`: a component whose `children` is a render prop. */
function RenderPropComponent({ children }: { children: (close: () => void) => ReactNode }) {
  return children(() => {});
}

/** Props off a cloned element, without asserting the caller's shape. */
function propsOf(node: ReactNode): Record<string, unknown> {
  if (!isValidElement(node)) throw new Error("expected an element");
  return (node as ReactElement<Record<string, unknown>>).props;
}

/** `wireControl` returns whatever `Children.map` returns; the tree we pass is a
 *  single root, so normalize the (array-wrapped) result back to that one node. */
function single(result: ReactNode): ReactNode {
  const list = Array.isArray(result) ? result : [result];
  expect(list).toHaveLength(1);
  return list[0] as ReactNode;
}

describe("wireControl", () => {
  it("leaves a render prop callable instead of wrapping it in an array", () => {
    const renderProp = (close: () => void) => createElement("span", { onClick: close });

    const tree = createElement(
      "div",
      null,
      createElement("input", { id: CONTROL_ID }),
      createElement(RenderPropComponent, { children: renderProp }),
    );

    const wrapper = single(wireControl(tree, CONTROL_ID, DESCRIBED_BY, undefined));
    const [, menu] = propsOf(wrapper).children as ReactNode[];

    // The bug: this used to be `[renderProp]`, and calling it threw
    // "children is not a function" the first time the menu was opened.
    const children = propsOf(menu).children;
    expect(typeof children).toBe("function");
    expect(children).toBe(renderProp);
    expect(() => (children as (close: () => void) => ReactNode)(() => {})).not.toThrow();
  });

  it("still wires the control that carries the id, alongside a render prop", () => {
    const tree = createElement(
      "div",
      null,
      createElement("input", { id: CONTROL_ID }),
      createElement(RenderPropComponent, { children: () => null }),
    );

    const wrapper = single(wireControl(tree, CONTROL_ID, DESCRIBED_BY, "field-1-error"));
    const [control] = propsOf(wrapper).children as ReactNode[];

    expect(propsOf(control)["aria-describedby"]).toBe("field-1-hint");
    expect(propsOf(control)["aria-errormessage"]).toBe("field-1-error");
    expect(propsOf(control)["aria-invalid"]).toBe(true);
  });

  it("reaches a control nested below plain wrapper elements", () => {
    const tree = createElement(
      "div",
      null,
      createElement("div", null, createElement("input", { id: CONTROL_ID })),
    );

    const outer = single(wireControl(tree, CONTROL_ID, DESCRIBED_BY, undefined));
    const inner = single(propsOf(outer).children as ReactNode);
    const control = single(propsOf(inner).children as ReactNode);

    expect(propsOf(control)["aria-describedby"]).toBe("field-1-hint");
  });

  it("merges generated ids into an existing aria-describedby", () => {
    const tree = createElement("input", {
      id: CONTROL_ID,
      "aria-describedby": "caller-said-this",
    });

    const control = single(wireControl(tree, CONTROL_ID, DESCRIBED_BY, undefined));

    expect(propsOf(control)["aria-describedby"]).toBe("caller-said-this field-1-hint");
  });
});

/**
 * The character count a clamped field shows as it fills. Hidden below 75% of
 * the cap, neutral from there, amber from 90%, red at the cap — and measured in
 * the unit `maxLength` clamps in, or the count and the input would disagree
 * about where the wall is.
 */
describe("counterState", () => {
  const at = (length: number, max: number) => counterState({ value: "x".repeat(length), max });

  it("stays hidden below three quarters of the cap", () => {
    expect(at(0, 80)).toBeNull();
    expect(at(59, 80)).toBeNull();
    // 75% of 150 is 112.5 — the count appears on the first whole character past it.
    expect(at(112, 150)).toBeNull();
  });

  it("appears at three quarters, neutral until nine tenths", () => {
    expect(at(60, 80)).toEqual({ length: 60, max: 80, tone: "neutral" });
    expect(at(113, 150)?.tone).toBe("neutral");
    expect(at(71, 80)?.tone).toBe("neutral");
  });

  it("turns amber from nine tenths and red at the cap", () => {
    expect(at(72, 80)?.tone).toBe("warning");
    expect(at(79, 80)?.tone).toBe("warning");
    expect(at(80, 80)?.tone).toBe("danger");
    expect(at(1024, 1024)?.tone).toBe("danger");
  });

  it("reads a value already over the cap as danger, with its true length", () => {
    // `maxLength` stops typing, not an imported value that was already longer.
    expect(at(120, 100)).toEqual({ length: 120, max: 100, tone: "danger" });
  });

  it("counts UTF-16 code units, the unit maxLength and the schema limits use", () => {
    // 40 emoji are 80 code units: exactly as full as the input thinks it is.
    expect(counterState({ value: "😀".repeat(40), max: 80 })).toEqual({
      length: 80,
      max: 80,
      tone: "danger",
    });
    expect(counterState({ value: "😀".repeat(30), max: 80 })?.tone).toBe("neutral");
  });

  it("shows nothing for a missing or nonsensical cap", () => {
    expect(at(10, 0)).toBeNull();
    expect(at(10, -5)).toBeNull();
    expect(at(10, Number.NaN)).toBeNull();
  });
});
