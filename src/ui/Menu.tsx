import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import styles from "./Menu.module.css";

interface TriggerProps {
  onClick?: (e: ReactMouseEvent) => void;
  "aria-haspopup"?: "menu";
  "aria-expanded"?: boolean;
}

interface MenuProps {
  /** Element that toggles the menu; its onClick is preserved. */
  trigger: ReactElement<TriggerProps>;
  /** Which edge of the trigger the panel aligns to. */
  align?: "start" | "end";
  /** Receives `close` so items can dismiss the menu after selection. */
  children: (close: () => void) => ReactNode;
}

/**
 * Anchored dropdown menu. Closes on outside click or Escape. The trigger keeps
 * its own onClick; the menu adds open/close on top.
 */
export function Menu({ trigger, align = "end", children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const triggerWithToggle = cloneElement(trigger, {
    onClick: (e: ReactMouseEvent) => {
      trigger.props.onClick?.(e);
      setOpen((v) => !v);
    },
    "aria-haspopup": "menu",
    "aria-expanded": open,
  });

  return (
    <span ref={wrapperRef} className={styles.wrapper}>
      {triggerWithToggle}
      {open ? (
        <div
          role="menu"
          className={cn(styles.panel, align === "end" ? styles.alignEnd : styles.alignStart)}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </span>
  );
}

interface MenuItemProps {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export function MenuItem({ icon, children, onSelect, disabled }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={styles.item}
      onClick={onSelect}
      disabled={disabled}
    >
      {icon ? <span className={styles.itemIcon}>{icon}</span> : null}
      <span className={styles.itemLabel}>{children}</span>
    </button>
  );
}

export function MenuDivider() {
  return <div className={styles.divider} role="separator" />;
}
