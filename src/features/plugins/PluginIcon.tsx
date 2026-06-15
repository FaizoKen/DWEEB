/**
 * Plugin icon — shared by the inspector's attached chip and the plugin
 * library rows.
 *
 * Resolution order: the per-instance summary icon, then the manifest's icon
 * URL, then a built-in inline SVG for curated plugins, then a monogram. The
 * built-in SVGs ship in the bundle so the picker paints instantly with no
 * network fetch; a manifest icon still wins so a plugin keeps owning its
 * branding. Unknown plugins get a monogram tinted by a hue derived from their
 * id, so every row stays visually distinct without any per-plugin code.
 */

import type { ReactNode } from "react";
import type { PluginManifest } from "@/core/plugins/manifest";
import styles from "./PluginIcon.module.css";

/** Bundled 24×24 stroke icons for the curated plugins, keyed by manifest id. */
const BUILTIN_ICONS: Record<string, { color: string; bg: string; paths: ReactNode }> = {
  // A modal window with form-field rows.
  "modal-form": {
    color: "#a78bfa",
    bg: "rgba(167, 139, 250, 0.14)",
    paths: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2.5" />
        <path d="M3 8.5h18" />
        <path d="M7 13h10" />
        <path d="M7 17h6" />
      </>
    ),
  },
  // A latency pulse, echoing the plugin's round-trip report.
  "ping-pong": {
    color: "#34d399",
    bg: "rgba(52, 211, 153, 0.14)",
    paths: <path d="M2.5 12H6l2.5-7 6.5 14 2.5-7h4" />,
  },
  // A member with a check badge — granting yourself a role.
  "self-role": {
    color: "#60a5fa",
    bg: "rgba(96, 165, 250, 0.14)",
    paths: (
      <>
        <circle cx="9" cy="7" r="4" />
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <path d="M15.5 11l2 2 4-4" />
      </>
    ),
  },
};

/** Deterministic hue from a plugin id, for the monogram fallback tint. */
function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function PluginIcon({
  manifest,
  summaryIcon,
}: {
  manifest: PluginManifest;
  summaryIcon?: string;
}) {
  const src = summaryIcon ?? manifest.icon;
  if (src) {
    return (
      <img
        className={styles.icon}
        src={src}
        alt=""
        aria-hidden
        width={28}
        height={28}
        loading="lazy"
        decoding="async"
      />
    );
  }

  const builtin = BUILTIN_ICONS[manifest.id];
  if (builtin) {
    return (
      <span
        className={styles.iconBuiltin}
        style={{ color: builtin.color, background: builtin.bg }}
        aria-hidden
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {builtin.paths}
        </svg>
      </span>
    );
  }

  // Fallback monogram from the plugin name, hue-tinted per id.
  const hue = hueOf(manifest.id);
  return (
    <span
      className={styles.iconFallback}
      style={{ color: `hsl(${hue}, 65%, 75%)`, background: `hsla(${hue}, 65%, 60%, 0.14)` }}
      aria-hidden
    >
      {manifest.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
