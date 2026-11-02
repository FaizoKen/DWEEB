/**
 * Checks the boot path runs on the namespaces its `import()`s resolve to.
 *
 * An engine verifies a *static* import when it links the importing module, so a
 * chunk that arrives without the export another chunk imports fails with a
 * message naming both (`… doesn't provide an export named: 'u'`). A dynamic
 * `import()` gets no such check: it resolves with whatever namespace the fetched
 * file produced, an empty one included, and the failure surfaces later as a
 * property read on `undefined` that says nothing about why. That was the
 * 2026-11-03 page: an empty precached `flows-*.js` handed the boot an undefined
 * `webhookFlow`, and the crash read `can't access property "parse", t is
 * undefined`. It looked like a bug of ours and could not be told apart from
 * one.
 *
 * So the entry passes each boot namespace through [`requireBootExports`], which
 * turns a missing export into the hollow-chunk error that the recovery ladder
 * repairs and the reporter verifies (`isHollowChunkMessage` in
 * `core/telemetry/crashReport`). Rollup checks every name at build time, and the
 * types check the list here, so this can only fire for a file that differs from
 * the one we built.
 */

import { hollowChunkMessage } from "@/core/telemetry/crashReport";

/**
 * `namespace`, once every export in `names` is present on it. Throws the
 * hollow-chunk error otherwise, naming `chunk`'s URL when this page fetched one.
 * `namespace` may itself be `undefined`: a module Vite merged into another chunk
 * is read off that chunk's namespace, which an empty file lacks entirely.
 */
export function requireBootExports<T, K extends keyof T>(
  namespace: T,
  chunk: string,
  names: readonly K[],
): T {
  for (const name of names) {
    const value =
      namespace !== null && typeof namespace === "object"
        ? (namespace as Record<PropertyKey, unknown>)[name as PropertyKey]
        : undefined;
    if (value === undefined) {
      throw new Error(hollowChunkMessage(chunk, String(name), fetchedChunkUrl(chunk)));
    }
  }
  return namespace;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The URL this page fetched the JS chunk named `chunk` from — Vite emits
 * `assets/<name>-<hash>.js`, and Resource Timing lists every module this
 * document requested, service-worker responses included (verified in Firefox
 * 150) — or `null` unless exactly one same-origin entry matches. `null` repairs
 * nothing and keeps the report paging, which is the safe direction if this ever
 * stops finding the file.
 */
export function fetchedChunkUrl(chunk: string): string | null {
  try {
    const origin = location.origin;
    const pattern = new RegExp(`^/assets/${escapeRegExp(chunk)}-[A-Za-z0-9_-]+\\.m?js$`);
    const found = new Set<string>();
    for (const entry of performance.getEntriesByType("resource")) {
      const url = new URL(entry.name);
      if (url.origin === origin && pattern.test(url.pathname)) {
        found.add(`${url.origin}${url.pathname}`);
      }
    }
    return found.size === 1 ? ([...found][0] ?? null) : null;
  } catch {
    return null;
  }
}
