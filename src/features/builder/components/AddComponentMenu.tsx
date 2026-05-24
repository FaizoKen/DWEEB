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
  trigger: ReactElement;
}

interface AnchorPos {
  left: number;
  top: number;
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
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
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

  const openMenu = () => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ left: rect.left, top: rect.top + rect.height, width: rect.width });
    setOpen(true);
  };

  const child = isValidElement(trigger)
    ? cloneElement(trigger as ReactElement<Record<string, unknown>>, {
        ref: (el: HTMLElement | null) => {
          triggerRef.current = el;
        },
        onClick: () => openMenu(),
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": labelId,
      })
    : trigger;

  const placement =
    align === "top" && anchor
      ? { left: anchor.left, top: anchor.top - 8, transform: "translateY(-100%)" }
      : anchor
        ? { left: anchor.left, top: anchor.top + 4 }
        : {};

  return (
    <>
      {child}
      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              id={labelId}
              role="menu"
              className={styles.menu}
              style={{ ...placement, minWidth: Math.max(220, anchor.width) }}
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
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
