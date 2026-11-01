/**
 * The Tools trigger on both action bars.
 *
 * It replaced a bare "…", which named nothing: a word says what's behind it
 * where a glyph makes people guess, and an ellipsis reads as "the leftovers".
 * Labelled while the bar has room, and exactly the size of the icon button it
 * replaced once it doesn't (`toolsFoldSteps`), so a tight bar gives up nothing
 * to this. `Menu` clones its handlers and ARIA state on through `rest`.
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { ChevronDownIcon, ToolsIcon } from "@/ui/Icon";
import styles from "./ToolsButton.module.css";

interface ToolsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Show the word. Off, the button folds to its icon. */
  labelled: boolean;
  /** Carries the dot: this browser hasn't opened the menu yet (`toolsSeen`). */
  unseen: boolean;
  /** Tooltip naming what's inside, which the word alone can't. */
  hint: string;
}

export const ToolsButton = forwardRef<HTMLButtonElement, ToolsButtonProps>(function ToolsButton(
  { labelled, unseen, hint, className, ...rest },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant="secondary"
      size="sm"
      className={cn(styles.tools, !labelled && styles.iconOnly, className)}
      leadingIcon={<ToolsIcon size={15} />}
      trailingIcon={labelled ? <ChevronDownIcon size={12} /> : undefined}
      aria-label="Tools"
      title={hint}
      data-unseen={unseen ? "" : undefined}
      {...rest}
    >
      {labelled ? "Tools" : null}
    </Button>
  );
});
