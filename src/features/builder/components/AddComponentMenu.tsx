/**
 * The component library popover — used for both the top-level "Add component"
 * button and the per-parent "+" affordances inside the tree.
 *
 * Two panes: a categorized list of everything that can be added, and a preview
 * pane showing a miniature Discord-style sketch of whichever row is hovered or
 * focused (see `AddMenuPreview`), so each entry is visually self-explanatory
 * before it's added. On narrow viewports the preview pane hides and the rows'
 * text descriptions come back (pure CSS, see the module).
 *
 * Position strategy: anchored to the trigger with `position: fixed` so the menu
 * floats above whatever scroll container holds the trigger. Outside-clicks
 * close the menu; Escape closes the menu and restores focus to the trigger.
 * Arrow keys move between rows (wrapping); ArrowRight/ArrowLeft expand and
 * collapse group rows.
 */

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { COMPONENT_META } from "@/core/schema/metadata";
import { ComponentType, type ComponentTypeValue } from "@/core/schema/types";
import { ChevronDownIcon, ChevronRightIcon } from "@/ui/Icon";
import { cn } from "@/lib/cn";
import { AddMenuPreview, previewKindFor, type AddPreviewKind } from "./AddMenuPreview";
import styles from "./AddComponentMenu.module.css";

/**
 * One row of the add menu. A leaf (no `children`) runs `onPick` when clicked.
 * A node with `children` renders as a group header: clicking it just toggles
 * the indented child rows — it adds nothing itself, so `onPick` is omitted.
 * `type` drives the glyph / label / description shown (via `COMPONENT_META`).
 */
export interface AddMenuNode {
  type: ComponentTypeValue;
  onPick?: () => void;
  children?: AddMenuNode[];
}

interface AddComponentMenuProps {
  nodes: AddMenuNode[];
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

/**
 * Library shelf each component type sits on. Headers only render when the
 * caller's node list spans more than one shelf — the small "fill this row
 * with a select" menu stays a plain list.
 */
const CATEGORY: Partial<Record<ComponentTypeValue, string>> = {
  [ComponentType.Container]: "Structure",
  [ComponentType.Section]: "Structure",
  [ComponentType.Separator]: "Structure",
  [ComponentType.TextDisplay]: "Content",
  [ComponentType.MediaGallery]: "Content",
  [ComponentType.File]: "Content",
  [ComponentType.ActionRow]: "Interactive",
  [ComponentType.StringSelect]: "Interactive",
  [ComponentType.UserSelect]: "Interactive",
  [ComponentType.RoleSelect]: "Interactive",
  [ComponentType.MentionableSelect]: "Interactive",
  [ComponentType.ChannelSelect]: "Interactive",
};

/** What the preview pane shows for the highlighted row. */
interface RowDescriptor {
  id: string;
  kind: AddPreviewKind;
  title: string;
  desc: string;
}

function descriptorFor(type: ComponentTypeValue, group?: ComponentTypeValue): RowDescriptor {
  const meta = COMPONENT_META[type];
  // Under Section the child adds a whole section-with-accessory, so the
  // preview title says so; a Buttons Row child stands on its own.
  const title =
    group === ComponentType.Section ? `${COMPONENT_META[group].label} · ${meta.label}` : meta.label;
  return {
    id: group !== undefined ? `${group}:${type}` : String(type),
    kind: previewKindFor(type, group),
    title,
    desc: meta.description,
  };
}

export function AddComponentMenu({
  nodes,
  disabled,
  align = "bottom",
  trigger,
}: AddComponentMenuProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorPos | null>(null);
  const [effectiveAlign, setEffectiveAlign] = useState<"top" | "bottom">(align);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const [leftShift, setLeftShift] = useState(0);
  // Which expandable parent rows are open. Reset each time the menu opens so it
  // always starts collapsed.
  const [expanded, setExpanded] = useState<Set<ComponentTypeValue>>(() => new Set());
  // The row the preview pane describes — follows hover and keyboard focus.
  const [active, setActive] = useState<RowDescriptor | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const innerMenuRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();

  // Nodes grouped onto their library shelves, preserving first-appearance
  // order. A single shelf means headers add nothing — render flat.
  const shelves = useMemo(() => {
    const out: { label: string; nodes: AddMenuNode[] }[] = [];
    for (const node of nodes) {
      const label = CATEGORY[node.type] ?? "Other";
      const shelf = out.find((s) => s.label === label);
      if (shelf) shelf.nodes.push(node);
      else out.push({ label, nodes: [node] });
    }
    return out;
  }, [nodes]);

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
    setExpanded(new Set());
    const first = shelves[0]?.nodes[0];
    setActive(first ? descriptorFor(first.type) : null);
    setOpen(true);
  };

  const toggleExpanded = (type: ComponentTypeValue) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
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

    // The list column scrolls internally once a max-height applies, which
    // would make scrollHeight report the clamped size — lift the clamp for
    // the measurement (we're pre-paint, so nothing flashes).
    const clamped = menuEl.style.maxHeight;
    menuEl.style.maxHeight = "none";
    const naturalHeight = menuEl.offsetHeight;
    const naturalWidth = menuEl.offsetWidth;
    menuEl.style.maxHeight = clamped;

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
  }, [open, anchor, align, expanded]);

  // Move focus into the menu on open so arrow keys work immediately. The
  // container (not the first row) takes focus, so mouse users don't see a
  // stray focus ring; ArrowDown from the container lands on the first row.
  useLayoutEffect(() => {
    if (open) innerMenuRef.current?.focus();
  }, [open]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const menuEl = innerMenuRef.current;
    if (!menuEl) return;
    const items = Array.from(menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    const current =
      document.activeElement instanceof HTMLButtonElement
        ? items.indexOf(document.activeElement)
        : -1;
    const focusAt = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        focusAt(current + 1);
        break;
      case "ArrowUp":
        focusAt(current === -1 ? items.length - 1 : current - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(items.length - 1);
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        const target = document.activeElement as HTMLElement | null;
        if (target?.dataset.group !== "true") break;
        const isExpanded = target.getAttribute("aria-expanded") === "true";
        if (e.key === "ArrowRight" ? !isExpanded : isExpanded) {
          e.preventDefault();
          target.click();
        }
        break;
      }
    }
  };

  const renderLeaf = (node: AddMenuNode, group?: ComponentTypeValue) => {
    const meta = COMPONENT_META[node.type];
    const d = descriptorFor(node.type, group);
    return (
      <button
        key={d.id}
        role="menuitem"
        type="button"
        className={cn(styles.item, group !== undefined && styles.childItem)}
        data-active={active?.id === d.id || undefined}
        onMouseEnter={() => setActive(d)}
        onFocus={() => setActive(d)}
        onClick={() => {
          node.onPick?.();
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
  };

  // Group: the whole row just toggles the child dropdown — it adds nothing
  // itself, since its children cover every case.
  const renderGroup = (node: AddMenuNode) => {
    const meta = COMPONENT_META[node.type];
    const d = descriptorFor(node.type);
    const isExpanded = expanded.has(node.type);
    return (
      <div key={d.id} className={styles.group}>
        <button
          role="menuitem"
          type="button"
          className={cn(styles.item, styles.groupToggle)}
          data-group="true"
          data-active={active?.id === d.id || undefined}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${meta.label} options`}
          onMouseEnter={() => setActive(d)}
          onFocus={() => setActive(d)}
          onClick={() => toggleExpanded(node.type)}
        >
          <span className={styles.itemGlyph}>{meta.glyph}</span>
          <span className={styles.itemBody}>
            <span className={styles.itemTitle}>{meta.label}</span>
            <span className={styles.itemSub}>{meta.description}</span>
          </span>
          <span className={styles.groupChevron} aria-hidden="true">
            {isExpanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
          </span>
        </button>
        {isExpanded ? (
          <div className={styles.childList}>
            {node.children!.map((child) => renderLeaf(child, node.type))}
          </div>
        ) : null}
      </div>
    );
  };

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
            <div ref={menuRef} className={styles.positioner} style={placement}>
              <div
                ref={innerMenuRef}
                id={labelId}
                role="menu"
                tabIndex={-1}
                className={styles.menu}
                data-align={effectiveAlign}
                style={maxHeight !== undefined ? { maxHeight } : undefined}
                onKeyDown={onMenuKeyDown}
              >
                <div className={styles.list}>
                  {shelves.map((shelf) => (
                    <div key={shelf.label} className={styles.shelf}>
                      {shelves.length > 1 ? (
                        <div className={styles.shelfLabel} aria-hidden="true">
                          {shelf.label}
                        </div>
                      ) : null}
                      {shelf.nodes.map((node) =>
                        node.children && node.children.length > 0
                          ? renderGroup(node)
                          : renderLeaf(node),
                      )}
                    </div>
                  ))}
                </div>

                {/* Decorative for AT: rows keep their (visually hidden)
                    descriptions, so this pane only duplicates them. */}
                <div className={styles.previewPane} aria-hidden="true">
                  {active ? (
                    <>
                      <AddMenuPreview kind={active.kind} />
                      <div className={styles.previewTitle}>{active.title}</div>
                      <div className={styles.previewDesc}>{active.desc}</div>
                    </>
                  ) : null}
                  <div className={styles.previewKeys}>↑↓ to browse · Enter to add</div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
