import { Fragment } from "react";
import { MenuDivider, MenuItem, MenuLabel } from "@/ui/Menu";
import type { PlaceholderGroup } from "@/core/plugins/placeholders";

interface PlaceholderMenuItemsProps {
  /** Placeholders to list, grouped by provider (core first, then plugins). */
  placeholders: PlaceholderGroup[];
  /** Inserts the chosen token (already wrapped, e.g. `{server}`) at the caret. */
  onInsert: (snippet: string) => void;
  /** Closes the surrounding menu after a pick. */
  close: () => void;
}

/**
 * The body of a placeholder insert menu: one labelled section per provider, each
 * item showing the human label beside the literal `{token}` it inserts. Shared by
 * the markdown toolbar's `{}` dropdown and the single-line {@link PlaceholderInput}
 * so both read identically.
 */
export function PlaceholderMenuItems({ placeholders, onInsert, close }: PlaceholderMenuItemsProps) {
  return (
    <>
      {placeholders.map((group, gi) => (
        <Fragment key={group.source}>
          {gi > 0 ? <MenuDivider /> : null}
          <MenuLabel>{group.source}</MenuLabel>
          {group.items.map((p) => (
            <MenuItem
              key={p.token}
              onSelect={() => {
                onInsert(`{${p.token}}`);
                close();
              }}
            >
              {`${p.label} — {${p.token}}`}
            </MenuItem>
          ))}
        </Fragment>
      ))}
    </>
  );
}
