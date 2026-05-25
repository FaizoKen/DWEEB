/**
 * Popover used for both the top-level "Add component" button and the per-parent
 * "+" affordances inside the tree.
 *
 * Position strategy: anchored to the trigger with `position: fixed` so the menu
 * floats above whatever scroll container holds the trigger. Outside-clicks
 * close the menu; Escape closes the menu and restores focus to the trigger.
 */

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { COMPONENT_META } from "@/core/schema/metadata";
import type { ComponentTypeValue } from "@/core/schema/types";
import styles from "./AddComponentMenu.module.css";

interface AddComponentMenuProps {
  allowed: ComponentTypeValue[];
  onPick: (type: ComponentTypeValue) => void;
  disabled?: boolean;
  align?: "top" | "bottom";
  /**
   * The trigger element. Pass a render function to react to open state — e.g.
   * to swap the label/icon to a "Close" affordance while the menu is open.
   */
  trigger: ReactElement | ((state: { open: boolean }) => ReactElement);
}

interface AnchorPos {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export function AddComponentMenu({
  allowed,
  onPick,
  disabled,
  align = "bottom",
  trigger,
}: AddComponentMenuProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorPos | null>(null);
  const [effectiveAlign, setEffectiveAlign] = useState<"top" | "bottom">(align);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const [leftShift, setLeftShift] = useState(0);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const innerMenuRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (
        menuRef.current?.contains(e.target as Node) ||
        triggerRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        (triggerRef.current as HTMLElement | null)?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleMenu = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width });
    // Reset to caller's preferred placement; the layout effect will flip if it
    // doesn't fit. Without this reset, a previously-flipped menu would keep
    // its old align on the next open before measurement runs.
    setEffectiveAlign(align);
    setMaxHeight(undefined);
    setLeftShift(0);
    setOpen(true);
  };

  // After the menu mounts, measure it and flip / clamp so it stays inside the
  // viewport. Runs before paint so the user never sees the cut-off position.
  useLayoutEffect(() => {
    if (!open || !anchor || !innerMenuRef.current) return;
    const menuEl = innerMenuRef.current;
    const margin = 8;
    const gap = 4;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    const naturalHeight = menuEl.scrollHeight;
    const naturalWidth = menuEl.offsetWidth;

    const spaceBelow = viewportH - anchor.bottom - margin - gap;
    const spaceAbove = anchor.top - margin - gap;

    let chosenAlign: "top" | "bottom";
    let availableHeight: number;
    if (align === "bottom") {
      if (naturalHeight <= spaceBelow || spaceBelow >= spaceAbove) {
        chosenAlign = "bottom";
        availableHeight = spaceBelow;
      } else {
        chosenAlign = "top";
        availableHeight = spaceAbove;
      }
    } else {
      if (naturalHeight <= spaceAbove || spaceAbove >= spaceBelow) {
        chosenAlign = "top";
        availableHeight = spaceAbove;
      } else {
        chosenAlign = "bottom";
        availableHeight = spaceBelow;
      }
    }

    setEffectiveAlign(chosenAlign);
    setMaxHeight(naturalHeight > availableHeight ? Math.max(120, availableHeight) : undefined);

    let left = anchor.left;
    if (left + naturalWidth > viewportW - margin) left = viewportW - naturalWidth - margin;
    if (left < margin) left = margin;
    setLeftShift(left - anchor.left);
  }, [open, anchor, align]);

  const resolvedTrigger = typeof trigger === "function" ? trigger({ open }) : trigger;
  const child = isValidElement(resolvedTrigger)
    ? cloneElement(resolvedTrigger as ReactElement<Record<string, unknown>>, {
        ref: (el: HTMLElement | null) => {
          triggerRef.current = el;
        },
        onClick: () => toggleMenu(),
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": labelId,
      })
    : resolvedTrigger;

  const placement =
    effectiveAlign === "top" && anchor
      ? { left: anchor.left + leftShift, top: anchor.top - 8, transform: "translateY(-100%)" }
      : anchor
        ? { left: anchor.left + leftShift, top: anchor.bottom + 4 }
        : {};

  return (
    <>
      {child}
      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.positioner}
              style={placement}
            >
              <div
                ref={innerMenuRef}
                id={labelId}
                role="menu"
                className={styles.menu}
                data-align={effectiveAlign}
                style={{
                  minWidth: Math.max(220, anchor.width),
                  ...(maxHeight !== undefined ? { maxHeight, overflowY: "auto" } : {}),
                }}
              >
                {allowed.map((t) => {
                  const meta = COMPONENT_META[t];
                  return (
                    <button
                      key={t}
                      role="menuitem"
                      type="button"
                      className={styles.item}
                      onClick={() => {
                        onPick(t);
                        setOpen(false);
                      }}
                    >
                      <span className={styles.itemGlyph}>{meta.glyph}</span>
                      <span className={styles.itemBody}>
                        <span className={styles.itemTitle}>{meta.label}</span>
                        <span className={styles.itemSub}>{meta.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
