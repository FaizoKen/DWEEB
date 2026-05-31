/**
 * Ping analysis — works out *who actually gets pinged* when a message is sent.
 *
 * Two things decide whether a mention in the message turns into a real ping:
 *   1. The mention tokens present in TextDisplay content (`@everyone`, `@here`,
 *      `<@user>`, `<@&role>`). Mentions only resolve from text content — labels,
 *      placeholders, and the like never ping.
 *   2. The message's `allowed_mentions` policy, which whitelists which classes
 *      (or specific snowflakes) are allowed to resolve. When `allowed_mentions`
 *      is omitted entirely, Discord falls back to its permissive default: every
 *      mention in the content resolves. That default is exactly the footgun the
 *      pre-send confirmation exists to surface — an `@everyone` typed into a
 *      TextDisplay pings the whole channel unless mentions are restricted.
 *
 * This module only inspects the message; it sends nothing. The Send panel's
 * confirmation dialog renders the result so the user sees the blast radius
 * before the POST/PATCH fires.
 */

import { walk } from "./traversal";
import type { WebhookMessage } from "./types";

/** Mention tokens found verbatim in the message's text content. */
export interface MentionScan {
  /** `@everyone` appears in some TextDisplay. */
  everyone: boolean;
  /** `@here` appears in some TextDisplay. */
  here: boolean;
  /** Unique role snowflakes from `<@&id>` tokens, in first-seen order. */
  roleIds: string[];
  /** Unique user snowflakes from `<@id>` / `<@!id>` tokens, in first-seen order. */
  userIds: string[];
}

// `<@&123>` — role. Checked before the user pattern so the trailing-id forms
// never collide (the user pattern below can't match `&`, but keep them ordered
// for clarity).
const ROLE_RE = /<@&(\d+)>/g;
// `<@123>` or `<@!123>` — user. The optional `!` is Discord's legacy nickname
// form; `&` (role) is excluded because it is neither `!` nor a digit.
const USER_RE = /<@!?(\d+)>/g;

/** Collect every mention token across all TextDisplay content in the message. */
export function scanMentions(message: WebhookMessage): MentionScan {
  const roleIds: string[] = [];
  const userIds: string[] = [];
  const seenRole = new Set<string>();
  const seenUser = new Set<string>();
  let everyone = false;
  let here = false;

  for (const node of walk(message)) {
    if (!("content" in node) || typeof node.content !== "string") continue;
    const text = node.content;
    if (text.includes("@everyone")) everyone = true;
    if (text.includes("@here")) here = true;
    for (const m of text.matchAll(ROLE_RE)) {
      const id = m[1]!;
      if (!seenRole.has(id)) {
        seenRole.add(id);
        roleIds.push(id);
      }
    }
    for (const m of text.matchAll(USER_RE)) {
      const id = m[1]!;
      if (!seenUser.has(id)) {
        seenUser.add(id);
        userIds.push(id);
      }
    }
  }

  return { everyone, here, roleIds, userIds };
}

/** What the message will actually ping, after applying `allowed_mentions`. */
export interface PingSummary {
  /** Any mention at all resolves to a ping. */
  willPing: boolean;
  /** `@everyone`/`@here` is present *and* allowed — pings the whole channel. */
  everyone: boolean;
  /** Role snowflakes that will resolve to a ping. */
  roleIds: string[];
  /** User snowflakes that will resolve to a ping. */
  userIds: string[];
  /** Mentions present in the text but suppressed by `allowed_mentions`. */
  suppressed: {
    /** `@everyone` or `@here` is written but won't ping. */
    everyone: boolean;
    roleIds: string[];
    userIds: string[];
  };
  /** Any mention at all was written, regardless of whether it resolves. */
  hasMentions: boolean;
  /** Silent send: recipients are mentioned but get no push/notification. */
  suppressNotifications: boolean;
}

/**
 * Resolve the scanned mentions against the message's `allowed_mentions` policy.
 *
 * Resolution rules (mirroring Discord):
 *   - No `allowed_mentions` field → every mention resolves (permissive default).
 *   - `parse: ["everyone"]` lets `@everyone`/`@here` resolve.
 *   - `parse: ["roles"]` lets *all* role mentions resolve; otherwise only the
 *     snowflakes listed in `roles: [...]` do (the two are mutually exclusive on
 *     the wire, but we accept either here).
 *   - The same logic applies to users via `parse: ["users"]` / `users: [...]`.
 */
export function summarizePings(message: WebhookMessage): PingSummary {
  const scan = scanMentions(message);
  const am = message.allowed_mentions;

  // With no policy, Discord parses everything; with one, only what it whitelists.
  const everyoneAllowed = am ? (am.parse?.includes("everyone") ?? false) : true;
  const rolesParseAll = am ? (am.parse?.includes("roles") ?? false) : true;
  const usersParseAll = am ? (am.parse?.includes("users") ?? false) : true;
  const allowedRoleIds = new Set(am?.roles ?? []);
  const allowedUserIds = new Set(am?.users ?? []);

  const everyoneWritten = scan.everyone || scan.here;
  const everyonePings = everyoneWritten && everyoneAllowed;

  const roleIds: string[] = [];
  const roleSuppressed: string[] = [];
  for (const id of scan.roleIds) {
    if (rolesParseAll || allowedRoleIds.has(id)) roleIds.push(id);
    else roleSuppressed.push(id);
  }

  const userIds: string[] = [];
  const userSuppressed: string[] = [];
  for (const id of scan.userIds) {
    if (usersParseAll || allowedUserIds.has(id)) userIds.push(id);
    else userSuppressed.push(id);
  }

  const willPing = everyonePings || roleIds.length > 0 || userIds.length > 0;
  const hasMentions = everyoneWritten || scan.roleIds.length > 0 || scan.userIds.length > 0;

  return {
    willPing,
    everyone: everyonePings,
    roleIds,
    userIds,
    suppressed: {
      everyone: everyoneWritten && !everyoneAllowed,
      roleIds: roleSuppressed,
      userIds: userSuppressed,
    },
    hasMentions,
    suppressNotifications: message.suppress_notifications ?? false,
  };
}
