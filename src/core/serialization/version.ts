/**
 * Wire-format versioning.
 *
 * Every encoded share URL carries an integer version prefix. When the editor's
 * schema changes in a backwards-incompatible way, bump `CURRENT_VERSION` and
 * register a migration in `migrations`. Older URLs run through the migration
 * chain on decode so they stay openable.
 *
 * Forward compatibility: an encoded URL from a future version is rejected
 * with a clear error rather than silently truncated.
 */

import type { WebhookMessage } from "@/core/schema/types";

export const CURRENT_VERSION = 1;

/** Migration runs in-place; it receives the previous-version JSON shape. */
type Migration = (input: unknown) => unknown;

/**
 * Map of `from -> to` migrations. Keys are the version number the input is
 * leaving. The decode loop applies migrations in ascending order until the
 * input reaches `CURRENT_VERSION`.
 *
 * Example for a v1→v2 bump:
 *   const migrations: Record<number, Migration> = {
 *     1: (msg) => ({ ...msg, newField: defaultValue }),
 *   };
 */
const migrations: Record<number, Migration> = {};

/**
 * Run any pending migrations on a payload that claims a specific version.
 * Throws if the version is in the future.
 */
export function migrate(version: number, payload: unknown): WebhookMessage {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Unsupported share version: ${version}`);
  }
  if (version > CURRENT_VERSION) {
    throw new Error(
      `Share URL was created with a newer version (${version}) of the builder. Update the builder to open it.`,
    );
  }
  let current = payload;
  for (let v = version; v < CURRENT_VERSION; v++) {
    const m = migrations[v];
    if (!m) throw new Error(`Missing migration from v${v} to v${v + 1}.`);
    current = m(current);
  }
  return current as WebhookMessage;
}
