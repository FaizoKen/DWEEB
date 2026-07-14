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
import { wireControl } from "@/ui/Field";

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
