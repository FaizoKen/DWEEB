/**
 * Editor draft persistence.
 *
 * Saves the in-progress message to `localStorage` so a returning user can
 * pick up where they left off. Mirrors the storage pattern used by
 * `webhook/history.ts` (versioned key, safe JSON parse, never throws).
 *
 * What gets saved:
 *  - The wire-format payload (no editor `_id`s) — same shape as a share URL.
 *  - A `savedAt` timestamp so callers can show "last edited X ago".
 *  - An optional, *non-credential* `origin` pointer (Discord message id + its
 *    home guild) when the draft is editing a message that was already posted, so
 *    a reopened session can re-link "Update existing" + the origin-guild banner.
 *    The webhook token is deliberately NOT stored here — it's recovered from the
 *    server library's posted entry (which holds it) by matching the message id
 *    on boot (see `useDraftOriginBootstrap`).
 *
 * What does NOT get saved:
 *  - Webhook URLs (those are credentials and live in `webhook/history.ts`,
 *    opt-in per entry).
 *  - Selection (transient editor state, not user content). Undo/redo history
 *    persists separately — see `historyStorage.ts`.
 *
 * The storage key carries a version suffix; a future schema bump can ignore
 * old drafts rather than trying to migrate them.
 */

import type { WebhookMessage } from "@/core/schema/types";
import { attachEditorFields, stripEditorFields } from "@/core/serialization/normalize";

const STORAGE_KEY = "dweeb.draft.v1";

/**
 * Non-credential pointer back to the posted message a draft is editing. Carries
 * only public identifiers — no webhook token — so persisting it adds no new
 * credential to the draft. On boot the token is recovered from the server
 * library's posted entry by matching {@link messageId}.
 */
export interface DraftOrigin {
  /** Discord message snowflake — the key used to recover the webhook token. */
  messageId: string;
  /** Thread the message lives in, when threaded. */
  threadId?: string;
  /** The message's home guild + name, for the origin-guild banner. */
  guildId?: string;
  guildName?: string;
}

export interface DraftRecord {
  /** Unix millis when the draft was last written. */
  savedAt: number;
  /** Wire-format message payload (no `_id` fields). */
  payload: unknown;
  /** Set when the draft is editing an already-posted message. */
  origin?: DraftOrigin;
}

/** Read the saved draft, if any. Never throws. */
export function loadDraft(): DraftRecord | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as DraftRecord).savedAt !== "number" ||
      !(parsed as DraftRecord).payload
    ) {
      return null;
    }
    return parsed as DraftRecord;
  } catch {
    return null;
  }
}

/**
 * Re-hydrate a saved draft into an editable message. Returns null if the
 * stored payload is malformed (e.g. saved by an older incompatible build).
 */
export function loadDraftMessage(): {
  message: WebhookMessage;
  savedAt: number;
  origin?: DraftOrigin;
} | null {
  const draft = loadDraft();
  if (!draft) return null;
  try {
    const message = attachEditorFields(draft.payload);
    // Only surface an origin that still carries the message id needed to recover
    // its webhook token — drop anything malformed rather than half-restoring.
    const origin =
      draft.origin && typeof draft.origin.messageId === "string" ? draft.origin : undefined;
    return { message, savedAt: draft.savedAt, origin };
  } catch {
    return null;
  }
}

/** Persist the current message as a draft. Silently no-ops on quota errors. */
export function saveDraft(message: WebhookMessage, origin?: DraftOrigin): void {
  if (typeof localStorage === "undefined") return;
  try {
    const record: DraftRecord = {
      savedAt: Date.now(),
      payload: stripEditorFields(message),
      ...(origin ? { origin } : {}),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Quota exceeded or storage disabled — losing the draft is preferable to
    // throwing inside the auto-save subscriber.
  }
}
