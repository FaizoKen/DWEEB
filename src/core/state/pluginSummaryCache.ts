/**
 * Plugin display-summary cache.
 *
 * DWEEB stores nothing authoritative about a plugin binding — the component's
 * `custom_id` is the whole binding, and the plugin's own backend holds the
 * config. This cache is a *cosmetic* convenience only: it remembers the label /
 * description / icon a plugin handed back on save, keyed by `custom_id`, so the
 * attached-plugin chip reads nicely without re-opening the iframe.
 *
 * It is fully expendable. A cache miss (e.g. a share link opened on another
 * device) just means the chip shows the plugin's manifest name instead of a
 * per-instance summary, which is still correct. We never rely on it to decide
 * *which* plugin owns a component — that's always recomputed from `custom_id`
 * via `targets.matchPlugin`.
 *
 * Versioned key + safe parse + graceful storage failure, mirroring
 * `prefsStorage.ts`.
 */

import type { PluginSummary } from "@/core/plugins/protocol";

interface CacheEntry {
  pluginId: string;
  summary: PluginSummary;
  /**
   * The guild this binding targets, for a guild-scoped plugin. Like the summary
   * it's an expendable, same-device convenience: when present the Send panel can
   * warn before posting the message to a *different* server (where the component
   * would be dead); a miss just skips that check.
   */
  guildId?: string;
  /**
   * Static values for the placeholders the plugin declared, keyed by token
   * (e.g. `prize → "a Nitro month"`). Used to render the message's `{token}`
   * text at send and in the preview. Expendable like the rest: a miss falls back
   * to each token's manifest sample, and the plugin still renders the live values
   * itself once the message is posted.
   */
  placeholderValues?: Record<string, string>;
}

type CacheMap = Record<string, CacheEntry>;

const STORAGE_KEY = "dweeb.plugins.summaries.v1";
/** Bound the map so it can't grow without limit across many edits. */
const MAX_ENTRIES = 200;

function readAll(): CacheMap {
  if (typeof localStorage === "undefined") return {};
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as CacheMap) : {};
  } catch {
    return {};
  }
}

function writeAll(map: CacheMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota / disabled storage — a missing cosmetic summary is harmless.
  }
}

/** Look up a cached summary for a `custom_id`, if one was stored. */
export function getPluginSummary(customId: string | undefined): CacheEntry | null {
  if (!customId) return null;
  const entry = readAll()[customId];
  return entry && typeof entry === "object" && typeof entry.pluginId === "string" ? entry : null;
}

/** The guild a guild-scoped binding targets, if one was cached for this id. */
export function getPluginBindingGuild(customId: string | undefined): string | null {
  const entry = getPluginSummary(customId);
  return entry && typeof entry.guildId === "string" ? entry.guildId : null;
}

/** The static placeholder values cached for a binding, if any — used to render
 *  the message's `{token}` text at send / in the preview. */
export function getPluginPlaceholderValues(
  customId: string | undefined,
): Record<string, string> | null {
  const entry = getPluginSummary(customId);
  return entry && entry.placeholderValues && typeof entry.placeholderValues === "object"
    ? entry.placeholderValues
    : null;
}

/** Remember the summary (and, for a guild-scoped binding, the guild; plus any
 *  placeholder values) a plugin returned for a `custom_id`. */
export function setPluginSummary(
  customId: string,
  pluginId: string,
  summary: PluginSummary,
  guildId?: string,
  placeholderValues?: Record<string, string>,
): void {
  const map = readAll();
  map[customId] = {
    pluginId,
    summary,
    ...(guildId ? { guildId } : {}),
    ...(placeholderValues ? { placeholderValues } : {}),
  };
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    // Cheap eviction: drop the oldest-inserted keys (JSON preserves order).
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
  }
  writeAll(map);
}

/** Forget a binding's summary (e.g. on detach). */
export function clearPluginSummary(customId: string): void {
  const map = readAll();
  if (customId in map) {
    delete map[customId];
    writeAll(map);
  }
}
