/**
 * Replacing the whole shared draft — when to ask first, and what to tell the
 * people it lands on.
 *
 * Everyone in an Activity room edits one message, and a handful of actions swap
 * that message out wholesale: "Start from scratch", picking a template or a
 * library / scheduled entry, Restore, and JSON import. Collab broadcasts the
 * swap as a full draft, and peers apply remote frames outside their own undo
 * history — so one tap used to wipe everyone's work with no warning, and the
 * people it landed on were left guessing what happened. These pure helpers
 * decide when a replace deserves a confirm (someone else is here *and* there's
 * work to lose — solo use never asks), phrase who's affected, and word the
 * notice a peer sees when someone else's replace arrives. The confirm flow
 * lives in `roomReplaceConfirm.ts`; spotting an incoming replace is collab's
 * job (`isWholeDocumentReplace`).
 */

import type { WebhookMessage } from "@/core/schema/types";
import { stripEditorFields } from "@/core/serialization/normalize";
import { DEFAULT_PRESET } from "@/data/showcase";
import type { CollabParticipant } from "./collab";

/** Who replaced the draft, as their connection announced itself in its `focus`
 *  frames (see `collab.ts`). */
export interface ReplaceActor {
  userId: string;
  name: string;
}

/**
 * Everyone in the room but you. The roster is keyed by Discord user id and
 * includes you; someone connected from two devices counts once.
 */
export function otherEditors(
  participants: readonly CollabParticipant[],
  selfId: string | null | undefined,
): CollabParticipant[] {
  const seen = new Set<string>();
  const others: CollabParticipant[] = [];
  for (const p of participants) {
    if (!p || p.id === selfId || seen.has(p.id)) continue;
    seen.add(p.id);
    others.push(p);
  }
  return others;
}

let pristineKeys: Set<string> | null = null;

/**
 * Whether the draft holds nothing anyone would miss: blank, or still exactly
 * the fresh-open default every new room starts from. Compared by content (the
 * wire form, key order ignored), so the editor ids a room re-assigns don't
 * matter — but any real edit, even to a message option like the username,
 * makes it worth keeping.
 */
export function isPristineDraft(message: WebhookMessage): boolean {
  pristineKeys ??= new Set([contentKey({ components: [] }), contentKey(DEFAULT_PRESET.message)]);
  return pristineKeys.has(contentKey(message));
}

/**
 * Whether replacing the whole shared draft should ask first: someone else is in
 * the room to have their view of it replaced, and it holds work worth keeping.
 * Solo use never asks — your own Undo covers you.
 */
export function needsRoomReplaceConfirm(
  message: WebhookMessage,
  participants: readonly CollabParticipant[],
  selfId: string | null | undefined,
): boolean {
  return otherEditors(participants, selfId).length > 0 && !isPristineDraft(message);
}

/** "You and Ana" / "You and 3 others" — who is editing the draft with you. */
export function editingTogetherPhrase(others: readonly CollabParticipant[]): string {
  if (others.length === 0) return "Only you";
  if (others.length === 1) return `You and ${others[0]!.name.trim() || "one other person"}`;
  return `You and ${others.length} others`;
}

/**
 * The name to show for whoever replaced the draft: the room roster's (server-
 * authored) name for their user id, else the name their connection announced.
 * Null when their connection never identified itself — the notice then says
 * "Someone" rather than guessing.
 */
export function actorDisplayName(
  actor: ReplaceActor | null,
  participants: readonly CollabParticipant[],
): string | null {
  if (!actor) return null;
  const listed = participants.find((p) => p.id === actor.userId)?.name?.trim();
  return listed || actor.name.trim() || null;
}

/** What a peer reads when someone else's whole-draft replace lands on them. */
export function peerReplaceNotice(name: string | null, cleared: boolean): string {
  const who = name ?? "Someone";
  return cleared ? `${who} cleared the draft.` : `${who} replaced the whole draft.`;
}

/** Order-insensitive JSON of a message's wire form (editor ids dropped). */
function contentKey(message: WebhookMessage): string {
  return stableStringify(stripEditorFields(message));
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}
