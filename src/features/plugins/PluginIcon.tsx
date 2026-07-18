/**
 * Plugin icon — shared by the inspector's attached chip and the plugin
 * library rows.
 *
 * Resolution order: the per-instance summary icon, then the manifest's icon
 * URL, then a built-in inline SVG for curated plugins, then the manifest's
 * default emoji, then a monogram. The built-in SVGs ship in the bundle so the
 * picker paints instantly with no network fetch; a manifest icon still wins so
 * a plugin keeps owning its branding. Unknown plugins get a monogram tinted by
 * a hue derived from their id, so every row stays visually distinct without any
 * per-plugin code.
 *
 * The icon URL is a remote image. Inside a production Discord Activity the
 * sandboxed `…discordsays.com` iframe's CSP blocks arbitrary `<img>` hosts, and
 * element loads (unlike `fetch`/XHR) aren't caught by the SDK's
 * `patchUrlMappings` — so a link plugin's icon on another host (e.g.
 * `rolelogic.faizo.net`) would be blocked and paint a torn-image glyph. We route
 * it through the proxy's image endpoint via {@link proxiedMediaUrl}, exactly as
 * every preview renderer does, so the real branded icon loads inside the Activity
 * (and is a no-op on the web app, where it already loads directly).
 *
 * The `onError` fallback stays as a safety net for a host that's genuinely down
 * or slow: a failed load falls through to the offline chain (built-in SVG →
 * default emoji → monogram), all of which paint with no network, so the picker
 * shows a clean, on-brand mark instead of a torn-image icon.
 */

import { useEffect, useState, type ReactNode } from "react";
import { proxiedMediaUrl } from "@/core/activity/runtime";
import styles from "./PluginIcon.module.css";

/**
 * The display identity an icon needs — structurally satisfied by both manifest
 * kinds (the interactive `PluginManifest` and the URL-based
 * `LinkPluginManifest`), so one icon serves every library row and chip. Both
 * kinds carry an optional `defaultEmoji`, used as the offline fallback mark when
 * a remote `icon` can't load.
 */
export interface PluginIconSource {
  id: string;
  name: string;
  icon?: string;
  defaultEmoji?: string;
}

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
  // An admission ticket with a perforated stub.
  tickets: {
    color: "#fbbf24",
    bg: "rgba(251, 191, 36, 0.14)",
    paths: (
      <>
        <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
        <path d="M13 5v2" />
        <path d="M13 11v2" />
        <path d="M13 17v2" />
      </>
    ),
  },
  // A wrapped gift box — the prize on the line.
  giveaway: {
    color: "#f472b6",
    bg: "rgba(244, 114, 182, 0.14)",
    paths: (
      <>
        <rect x="3" y="8" width="18" height="4" rx="1" />
        <path d="M12 8v13" />
        <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
        <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />
      </>
    ),
  },
  // A chat bubble with a reply arrow.
  "quick-replies": {
    color: "#2dd4bf",
    bg: "rgba(45, 212, 191, 0.14)",
    paths: (
      <>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <path d="m10 7-3 3 3 3" />
        <path d="M17 13v-1a2 2 0 0 0-2-2H7" />
      </>
    ),
  },
  // Rising result bars — the live tally.
  poll: {
    color: "#818cf8",
    bg: "rgba(129, 140, 248, 0.14)",
    paths: (
      <>
        <path d="M6 20v-4" />
        <path d="M12 20V10" />
        <path d="M18 20V4" />
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
  manifest: PluginIconSource;
  summaryIcon?: string;
}) {
  // Route the remote icon through the Activity image proxy so it loads inside the
  // sandboxed iframe (see the module doc); a no-op on the web app and in dev.
  const rawSrc = summaryIcon ?? manifest.icon;
  const src = rawSrc ? proxiedMediaUrl(rawSrc) : undefined;
  // Whether the remote image failed to load — then we render the offline chain
  // instead of a broken-image glyph. Reset when `src` changes so switching the
  // chip's plugin re-attempts the new URL rather than staying failed.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (src && !failed) {
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
        onError={() => setFailed(true)}
      />
    );
  }

  return offlineFallback(manifest);
}

/**
 * The no-network icon: a built-in SVG for a curated plugin, else the manifest's
 * default emoji, else a hue-tinted monogram. Used both when a plugin has no
 * remote icon and when its remote icon fails to load (see the component doc).
 */
function offlineFallback(manifest: PluginIconSource): ReactNode {
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

  // A link plugin's brand emoji (🌍, 🗳️, ⚔️…) — a clean, on-brand mark when the
  // remote icon can't load, and nicer than a bare monogram.
  if (manifest.defaultEmoji) {
    return (
      <span className={styles.iconEmoji} aria-hidden>
        {manifest.defaultEmoji}
      </span>
    );
  }

  // Last resort: a monogram from the plugin name, hue-tinted per id.
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
