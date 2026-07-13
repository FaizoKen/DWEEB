/**
 * Browser-local edit credentials for stateful plugin bindings.
 *
 * The token is deliberately separate from `custom_id`: Discord receives only
 * the opaque instance id, while this credential stays in this browser and is
 * sent back only to the matching plugin iframe during protocol-v2 init. A cache
 * miss is safe: the iframe creates a replacement instance and DWEEB rebinds the
 * component instead of attempting an unauthenticated in-place update.
 */

import { sanitizeManagementToken } from "./protocol";

interface EditTokenEntry {
  customId: string;
  pluginId: string;
  managementToken: string;
  savedAt: number;
}

const STORAGE_KEY = "dweeb.plugins.edit-access.v1";
const MAX_ENTRIES = 200;
function readAll(): EditTokenEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is EditTokenEntry =>
        !!entry &&
        typeof entry === "object" &&
        typeof entry.customId === "string" &&
        entry.customId.length > 0 &&
        entry.customId.length <= 100 &&
        typeof entry.pluginId === "string" &&
        entry.pluginId.length > 0 &&
        sanitizeManagementToken(entry.managementToken) !== undefined &&
        typeof entry.savedAt === "number" &&
        Number.isFinite(entry.savedAt),
    );
  } catch {
    return [];
  }
}

function writeAll(entries: EditTokenEntry[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
    return true;
  } catch {
    return false;
  }
}

export function getPluginEditToken(customId: string | undefined, pluginId: string): string | null {
  if (!customId) return null;
  const entry = readAll().find((item) => item.customId === customId && item.pluginId === pluginId);
  return entry?.managementToken ?? null;
}

export function setPluginEditToken(customId: string, pluginId: string, rawToken: unknown): boolean {
  const managementToken = sanitizeManagementToken(rawToken);
  if (!customId || customId.length > 100 || !pluginId || !managementToken) return false;
  const entries = readAll().filter(
    (entry) => entry.customId !== customId || entry.pluginId !== pluginId,
  );
  entries.push({ customId, pluginId, managementToken, savedAt: Date.now() });
  return writeAll(entries);
}

export function clearPluginEditToken(customId: string, pluginId?: string): void {
  const entries = readAll();
  const kept = entries.filter(
    (entry) =>
      entry.customId !== customId || (pluginId !== undefined && entry.pluginId !== pluginId),
  );
  if (kept.length !== entries.length) writeAll(kept);
}
