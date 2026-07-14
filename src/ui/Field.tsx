import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import styles from "./Field.module.css";

/**
 * Generic labeled wrapper used by every inspector control. Renders a label
 * row, optional hint, and an optional error/warning under the control.
 *
 * It accepts a render-prop child and wires its rendered control to the hint,
 * warning, and error by the id passed to that child. Recursing through the
 * returned elements also covers controls wrapped beside secondary buttons.
 */
interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Softer than `error` (amber): Discord accepts the value but degrades it.
   *  Shown only while no error stands, so the two never stack. */
  warning?: string | null;
  htmlFor?: string;
  /** When true, the label is visually hidden but still announced to AT. */
  hideLabel?: boolean;
  className?: string;
  children: (controlId: string) => ReactNode;
}

interface AccessibleElementProps {
  id?: string;
  /** Not just `ReactNode`: the children we walk are whatever the caller put in
   *  the tree, and a render-prop component (`Menu`, a nested `Field`) carries a
   *  *function* here. Saying so keeps `wireControl` honest about what it meets. */
  children?: ReactNode | ((...args: never[]) => ReactNode);
  "aria-describedby"?: string;
  "aria-errormessage"?: string;
  "aria-invalid"?: boolean | "true" | "false";
}

function mergeIds(existing: string | undefined, generated: string[]): string | undefined {
  const ids = [...(existing?.split(/\s+/).filter(Boolean) ?? []), ...generated];
  return ids.length > 0 ? [...new Set(ids)].join(" ") : undefined;
}

/** Inject accessibility props into the rendered element carrying controlId.
 * Recursing also handles Field children that wrap an input beside a button.
 *
 * Exported for `Field.test.ts`: `Field` itself calls `useId`, so it can only run
 * inside a renderer, while this — the part that rewrites other people's props,
 * and the part that broke — is pure and testable on its own. */
export function wireControl(
  node: ReactNode,
  controlId: string,
  describedByIds: string[],
  errorId: string | undefined,
): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement(child)) return child;
    const element = child as ReactElement<AccessibleElementProps>;
    const props = element.props;

    if (props.id === controlId) {
      return cloneElement(element, {
        "aria-describedby": mergeIds(props["aria-describedby"], describedByIds),
        "aria-errormessage": errorId ?? props["aria-errormessage"],
        "aria-invalid": errorId ? true : props["aria-invalid"],
      });
    }

    // A render-prop child (`Menu`, a nested `Field`) holds a *function* in
    // `children`, not a tree, and there is nothing here to recurse into — the
    // subtree only exists once that component calls it. Descending anyway is not
    // merely useless, it is destructive: `Children.map` wraps the function into
    // `[fn]`, and the clone below would write that array back over `children`,
    // so the component ends up invoking an array. That is exactly how opening
    // the emoji picker took the whole app down with "children is not a
    // function" — the throw lands in the child, far from this line.
    if (typeof props.children === "function") return child;

    if (props.children === undefined) return child;
    return cloneElement(element, {
      children: wireControl(props.children, controlId, describedByIds, errorId),
    });
  });
}

export function Field({
  label,
  hint,
  error,
  warning,
  htmlFor,
  hideLabel,
  className,
  children,
}: FieldProps) {
  const reactId = useId();
  const controlId = htmlFor ?? reactId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const warningId = `${controlId}-warning`;
  const hasHint = Boolean(hint);
  const hasError = Boolean(error);
  const hasWarning = !hasError && Boolean(warning);
  const describedByIds = [
    ...(hasHint ? [hintId] : []),
    ...(hasError ? [errorId] : []),
    ...(hasWarning ? [warningId] : []),
  ];
  const control = wireControl(
    children(controlId),
    controlId,
    describedByIds,
    hasError ? errorId : undefined,
  );

  return (
    <div className={cn(styles.field, className)}>
      <label htmlFor={controlId} className={cn(styles.label, hideLabel && styles.labelHidden)}>
        {label}
      </label>
      <div className={styles.control}>{control}</div>
      {hint ? (
        <div id={hintId} className={styles.hint}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div id={errorId} className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
      {!error && warning ? (
        <div id={warningId} className={styles.warning}>
          {warning}
        </div>
      ) : null}
    </div>
  );
}
