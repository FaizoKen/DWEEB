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
import { cn } from "@/lib/cn";
import { placeMenu, type MenuAnchor, type MenuPlacement } from "./menuPlacement";
import { typeaheadIndex } from "./menuTypeahead";
import styles from "./Menu.module.css";

/** Typed characters within this long of each other build one search ("ex", "exp"…). */
const TYPEAHEAD_RESET_MS = 500;

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

/**
 * A field whose arrow keys do something of their own — stepping a date, time
 * or number, moving between a textarea's lines — unlike a single-line search
 * box, where ArrowDown is the way into the menu's results.
 */
function ownsArrowKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return (
    target instanceof HTMLInputElement &&
    /^(date|time|datetime-local|month|week|number|range)$/.test(target.type)
  );
}

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

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
  /** Extra class on the panel, for a menu that needs its own width. */
  className?: string;
  /** Runs each time the menu opens, however it was opened (click or arrow key). */
  onOpen?: () => void;
  /** Receives `close` so items can dismiss the menu after selection. */
  children: (close: () => void) => ReactNode;
}

/**
 * Anchored dropdown menu. Closes on outside click or Escape.
 *
 * The panel is portalled to `<body>` with `position: fixed` so it floats above
 * whatever scroll container holds the trigger instead of being clipped by it
 * (the same strategy the tree's "Add component" popover uses). `placeMenu`
 * decides where it goes. The trigger keeps its own onClick; the menu adds
 * open/close.
 */
export function Menu({ trigger, align = "end", className, onOpen, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [pos, setPos] = useState<MenuPlacement | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<"first" | "last">("first");
  const needsInitialFocusRef = useRef(false);
  const typeaheadRef = useRef({ text: "", at: 0 });

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
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
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
    const panel = panelRef.current;
    // Read the natural height, not the cap an earlier pass left on the panel,
    // so a window that grew gets its whole list back.
    const cap = panel.style.maxHeight;
    panel.style.maxHeight = "none";
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    panel.style.maxHeight = cap;
    setPos(
      placeMenu(anchor, size, { width: window.innerWidth, height: window.innerHeight }, align),
    );
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
    typeaheadRef.current = { text: "", at: 0 };
    measureAnchor();
    setPos(null);
    setOpen(true);
    onOpen?.();
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
              className={cn(styles.panel, className)}
              style={{
                position: "fixed",
                // Rendered offscreen until measured so there's no positioning
                // flash. Never `visibility: hidden` as well: reduced motion's
                // blanket rule transitions every property for 0.01ms, so the
                // panel is still hidden when the first row is focused, `focus()`
                // silently does nothing, and the keyboard can't enter the menu.
                left: pos?.left ?? -9999,
                top: pos?.top ?? -9999,
                // Only a panel too tall for the viewport scrolls; every other
                // menu keeps its overflow, and anything that hangs out of it.
                maxHeight: pos?.maxHeight ?? undefined,
                overflowY: pos?.maxHeight != null ? "auto" : undefined,
              }}
              onKeyDown={(event) => {
                // A form field inside the panel whose arrows mean something
                // (the timestamp picker's date and time) keeps its own keys:
                // arrows step the value, and Tab walks to the next field — the
                // panel only takes Tab over at its edge, to leave past the
                // trigger. Hijacking them left those fields mouse-only.
                if (ownsArrowKeys(event.target)) {
                  if (event.key === "Tab") {
                    const fields = Array.from(
                      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
                    );
                    const at = fields.indexOf(event.target as HTMLElement);
                    const next = at + (event.shiftKey ? -1 : 1);
                    if (at >= 0 && next >= 0 && next < fields.length) return;
                    event.preventDefault();
                    focusPastTrigger(event.shiftKey);
                    return;
                  }
                  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                }
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
                } else if (
                  event.key.length === 1 &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.altKey &&
                  // A search field inside the panel (the emoji picker) keeps its keys.
                  !isTextEntry(event.target)
                ) {
                  // Typeahead: jump to the item whose label starts with what was
                  // typed. Space still activates the focused item unless a search
                  // is under way, where it's part of the label ("export as").
                  const now = Date.now();
                  const last = typeaheadRef.current;
                  const pending = now - last.at <= TYPEAHEAD_RESET_MS ? last.text : "";
                  if (event.key === " " && !pending) return;
                  const text = pending + event.key;
                  typeaheadRef.current = { text, at: now };
                  const labels = items.map((item) => item.textContent ?? "");
                  target = items[typeaheadIndex(labels, index, text)];
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
  /** One line under the label saying what the row is for. It follows the label
   *  in the row's text, so typeahead still matches on the label. */
  description?: string;
  /** Marker at the row's far edge, such as the glyph for "opens a new tab". */
  trailing?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

export function MenuItem({
  icon,
  children,
  description,
  trailing,
  onSelect,
  disabled,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={styles.item}
      data-described={description ? "" : undefined}
      onClick={onSelect}
      disabled={disabled}
    >
      {icon ? <span className={styles.itemIcon}>{icon}</span> : null}
      <span className={styles.itemLabel}>
        {children}
        {description ? <span className={styles.itemDescription}>{description}</span> : null}
      </span>
      {trailing ? <span className={styles.itemTrailing}>{trailing}</span> : null}
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
