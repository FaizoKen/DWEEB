/**
 * Warm the Send/Update destination data *before* the dialog that shows it opens.
 *
 * The "Posting to" section is fed by two account-scoped fetches — the connected
 * guild's webhook list ({@link useGuildWebhooksStore}) and its registered custom
 * bots ({@link useGuildCustomBotsStore}) — and both used to start only when
 * `GuildWebhookPicker` mounted, i.e. once the dialog was already on screen. That
 * put a "Loading this server…" line in front of the destination on every open,
 * and held the bar-picked channel's auto-resolve (which waits for *both*) behind
 * it. Warming them from the builder shell means the dialog usually opens with
 * its destination already resolved.
 *
 * Cheap and idempotent by construction: both stores dedupe an in-flight request
 * and skip a round-trip while their data is inside the same short TTL, so a
 * warm-up costs at most one fetch each and the picker's own mount-time load then
 * lands as a cache hit. Callers must gate on the picker actually being usable
 * (signed in + Manage Webhooks in the connected guild) — this doesn't re-check,
 * and an unauthorized warm-up would just park the store at `denied`.
 */

import { useGuildCustomBotsStore } from "@/core/guild/useGuildCustomBots";
import { useGuildWebhooksStore } from "./guildWebhooks";

/** Kick off (or reuse) the destination fetches for a guild. Never throws — the
 *  stores absorb their own failures into a status the picker renders. */
export function prefetchSendDestination(guildId: string): void {
  if (!guildId) return;
  void useGuildWebhooksStore.getState().load(guildId);
  void useGuildCustomBotsStore.getState().load(guildId);
}
