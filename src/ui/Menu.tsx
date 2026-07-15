import {
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "./Menu.module.css";

interface TriggerProps {
  onClick?: (e: ReactMouseEvent) => void;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
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

interface Anchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Anchored dropdown menu. Closes on outside click or Escape.
 *
 * The panel is portalled to `<body>` with `position: fixed` so it floats above
 * whatever scroll container holds the trigger instead of being clipped by it
 * (the same strategy the tree's "Add component" popover uses). It opens below
 * the trigger, flipping above when there isn't room, and clamps horizontally to
 * the viewport. The trigger keeps its own onClick; the menu adds open/close.
 */
export function Menu({ trigger, align = "end", children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<"first" | "last">("first");
  const needsInitialFocusRef = useRef(false);

  const triggerElement = () =>
    wrapperRef.current?.querySelector<HTMLElement>("[aria-haspopup='menu']") ?? null;
  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerElement()?.focus({ preventScroll: true }));
    }
  };

  const menuItems = () =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        "[role='menuitem']:not(:disabled):not([aria-disabled='true'])",
      ) ?? [],
    );
  const focusPastTrigger = (backward: boolean) => {
    const trigger = triggerElement();
    if (!trigger) return;
    const selector =
      "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
      (element) =>
        !panelRef.current?.contains(element) &&
        !element.closest("[inert]") &&
        element.getClientRects().length > 0,
    );
    const index = candidates.indexOf(trigger);
    const target = candidates[index + (backward ? -1 : 1)];
    setOpen(false);
    requestAnimationFrame(() => (target ?? trigger).focus({ preventScroll: true }));
  };

  const measureAnchor = () => {
    const r = wrapperRef.current?.getBoundingClientRect();
    if (r) setAnchor({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu(true);
      }
    };
    // Keep the floating panel pinned to the trigger as the page scrolls/resizes.
    const onReflow = () => measureAnchor();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
    // Listeners are (re)bound once per open/close. The handlers only touch
    // stable refs and setters (`setOpen`, `triggerElement()`, `panelRef`), so
    // binding to `open` alone is intentional — not a stale-closure risk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Measure the panel and place it before paint so the user never sees it jump.
  useLayoutEffect(() => {
    if (!open || !anchor || !panelRef.current) return;
    const margin = 8;
    const gap = 6;
    const panel = panelRef.current;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = align === "start" ? anchor.left : anchor.right - w;
    if (left + w > vw - margin) left = vw - w - margin;
    if (left < margin) left = margin;

    const spaceBelow = vh - anchor.bottom - margin;
    const spaceAbove = anchor.top - margin;
    const openUp = h + gap > spaceBelow && spaceAbove > spaceBelow;
    const top = openUp ? Math.max(margin, anchor.top - gap - h) : anchor.bottom + gap;

    setPos({ left, top });
  }, [open, anchor, align]);

  // A menu opens with one item focused; its items then use arrow-key movement
  // instead of placing every command in the page's Tab sequence.
  useEffect(() => {
    if (!open || !pos || !needsInitialFocusRef.current) return;
    needsInitialFocusRef.current = false;
    const items = menuItems();
    const target = initialFocusRef.current === "last" ? items.at(-1) : items[0];
    target?.focus({ preventScroll: true });
  }, [open, pos]);

  const openMenu = (initial: "first" | "last" = "first") => {
    initialFocusRef.current = initial;
    needsInitialFocusRef.current = true;
    measureAnchor();
    setPos(null);
    setOpen(true);
  };

  const triggerWithToggle = cloneElement(trigger, {
    onClick: (e: ReactMouseEvent) => {
      trigger.props.onClick?.(e);
      if (e.defaultPrevented) return;
      if (open) {
        closeMenu(false);
      } else {
        openMenu();
      }
    },
    onKeyDown: (e: ReactKeyboardEvent) => {
      trigger.props.onKeyDown?.(e);
      if (e.defaultPrevented) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu(e.key === "ArrowUp" ? "last" : "first");
      }
    },
    "aria-haspopup": "menu",
    "aria-expanded": open,
  });

  return (
    <span ref={wrapperRef} className={styles.wrapper}>
      {triggerWithToggle}
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              className={styles.panel}
              style={{
                position: "fixed",
                left: pos?.left ?? -9999,
                top: pos?.top ?? -9999,
                // Rendered offscreen until measured so there's no positioning flash.
                visibility: pos ? "visible" : "hidden",
              }}
              onKeyDown={(event) => {
                const items = menuItems();
                if (items.length === 0) return;
                const current = document.activeElement;
                const index = items.findIndex((item) => item === current);
                let target: HTMLElement | undefined;
                if (event.key === "ArrowDown") {
                  target = items[(index + 1 + items.length) % items.length];
                } else if (event.key === "ArrowUp") {
                  target = items[(index - 1 + items.length) % items.length];
                } else if (event.key === "Home") {
                  target = items[0];
                } else if (event.key === "End") {
                  target = items.at(-1);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeMenu(true);
                  return;
                } else if (event.key === "Tab") {
                  // The panel is portalled at the end of body, so native Tab
                  // order from a menu item would not continue after the trigger.
                  event.preventDefault();
                  focusPastTrigger(event.shiftKey);
                  return;
                } else {
                  return;
                }
                event.preventDefault();
                target?.focus();
              }}
            >
              {children(() => closeMenu(true))}
            </div>,
            document.body,
          )
        : null}
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
      tabIndex={-1}
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

/** Non-interactive section heading, for grouping items within one menu. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className={styles.label} role="presentation">
      {children}
    </div>
  );
}
