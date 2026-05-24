/**
 * Renders a Discord button to match the native widget exactly: per-style
 * fills, hover transition, optional emoji, leading external-link arrow on
 * Link buttons.
 *
 * Interactive (custom_id) buttons render as no-op buttons here — the preview
 * is read-only. URL buttons open the destination in a new tab.
 */

import { ButtonStyle, type ButtonComponent } from "@/core/schema/types";
import { cn } from "@/lib/cn";
import styles from "./ButtonRenderer.module.css";

// CSS-module values are `string | undefined` under `noUncheckedIndexedAccess`;
// the fallback below (`?? styles.secondary`) absorbs the undefined.
const STYLE_CLASS: Record<number, string | undefined> = {
  [ButtonStyle.Primary]: styles.primary,
  [ButtonStyle.Secondary]: styles.secondary,
  [ButtonStyle.Success]: styles.success,
  [ButtonStyle.Danger]: styles.danger,
  [ButtonStyle.Link]: styles.link,
  [ButtonStyle.Premium]: styles.premium,
};

export function ButtonRenderer({ node }: { node: ButtonComponent }) {
  const cls = STYLE_CLASS[node.style] ?? styles.secondary;
  const isLink = node.style === ButtonStyle.Link;
  const isPremium = node.style === ButtonStyle.Premium;

  const content = (
    <>
      {"emoji" in node && node.emoji?.name ? (
        <span className={styles.emoji}>{node.emoji.name}</span>
      ) : null}
      {isPremium ? (
        <span>SKU&nbsp;{node.sku_id || "unset"}</span>
      ) : (
        <span>{"label" in node && node.label ? node.label : "Button"}</span>
      )}
      {isLink ? (
        <svg
          className={styles.external}
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="14"
          height="14"
        >
          <path
            d="M14 4h6v6M20 4l-9 9M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </>
  );

  if (isLink) {
    return (
      <a
        className={cn(styles.btn, cls, node.disabled && styles.disabled)}
        href={node.disabled ? undefined : (node as { url: string }).url}
        target="_blank"
        rel="noreferrer noopener"
        aria-disabled={node.disabled || undefined}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cn(styles.btn, cls, node.disabled && styles.disabled)}
      disabled={node.disabled}
      onClick={(e) => e.preventDefault()}
    >
      {content}
    </button>
  );
}
