/**
 * The scheduled post the editor's message was loaded from.
 *
 * The Message directory's Scheduled cards promised "load it back to edit or
 * reschedule", but loading one only replaced the editor's message — so the Send
 * panel's Schedule button created a *second* post beside the first. This
 * remembers which schedule the document came from, so the Send panel can save
 * changes into it instead (`updateSchedule`, a PATCH) and say so while it does.
 *
 * The safety rule: an origin belongs to exactly one editor document. Any
 * whole-document replacement — a template, a JSON import, Clear, another
 * directory card, a Restore, a share link, an AI rewrite — starts a new
 * document (`getMessageDocumentGeneration`), and so does undoing past the load
 * itself (the editor is then showing the message that was there before). Either
 * drops the origin on the spot, so a replacement message can never be saved
 * over the scheduled one. The same guard the draft-origin recovery uses.
 *
 * Memory only: a reload forgets it, and the Send panel then offers to schedule
 * a new post (which it says, rather than claiming to edit). Account-scoped:
 * signing out drops it. It carries no credential — saving uses the same access
 * the directory's Cancel does (this browser's saved management key, else the
 * signed-in owner's or a server manager's session), looked up at save time.
 */

import { create } from "zustand";
import { registerAccountStateReset } from "@/core/auth/accountScopedState";
import { getMessageDocumentGeneration, useMessageStore } from "@/core/state/messageStore";
import type { WebhookMessage } from "@/core/schema/types";
import type { ScheduleView } from "./api";

export interface ScheduleOrigin {
  scheduleId: string;
  /** The server it posts in, when the schedule recorded one. */
  guildId: string | null;
  /** The webhook it posts through (masked server-side; the id is public). */
  webhookId: string;
  /** When it posts, unix seconds. */
  runAt: number;
  /** The schedule's own timezone — the directory formats `runAt` in it. */
  tz: string;
  /** Display-only destination, e.g. `#general · My Server`. */
  destLabel: string | null;
  status: ScheduleView["status"];
}

/** An origin plus the document it belongs to. */
interface ArmedOrigin extends ScheduleOrigin {
  /** The editor document generation the scheduled message was loaded as. */
  generation: number;
  /** The message the load replaced — seeing it again means the load was undone. */
  replaced: WebhookMessage;
}

interface ScheduleOriginState {
  armed: ArmedOrigin | null;
}

const useScheduleOriginStore = create<ScheduleOriginState>(() => ({ armed: null }));

/** Statuses whose post is still waiting to go out, so an edit can still land. */
const EDITABLE: ReadonlySet<ScheduleView["status"]> = new Set(["active", "paused", "suspended"]);

/** Whether a directory schedule can take edits (it hasn't started posting). */
export function isScheduleEditable(view: Pick<ScheduleView, "status">): boolean {
  return EDITABLE.has(view.status);
}

/** The origin a directory card's schedule becomes once loaded. */
export function scheduleOriginFromView(view: ScheduleView): ScheduleOrigin {
  return {
    scheduleId: view.id,
    guildId: view.guild_id ?? null,
    webhookId: view.webhook_id,
    runAt: view.next_run_at,
    tz: view.tz,
    destLabel: view.dest_label?.trim() || null,
    status: view.status,
  };
}

/**
 * Whether an armed origin still describes the editor's document: the same
 * generation, and not rolled back (by Undo) to the message the load replaced.
 */
export function isArmedOriginCurrent(
  armed: Pick<ArmedOrigin, "generation" | "replaced">,
  generation: number,
  message: WebhookMessage,
): boolean {
  return armed.generation === generation && message !== armed.replaced;
}

/**
 * Load a scheduled post's message into the editor as the document that edits
 * it. The replacement and the arming happen together, so the origin can only
 * ever describe the message this call put in the editor.
 */
export function loadScheduledPost(message: WebhookMessage, origin: ScheduleOrigin): void {
  const store = useMessageStore.getState();
  const replaced = store.message;
  store.replaceMessage(message);
  useScheduleOriginStore.setState({
    armed: { ...origin, generation: getMessageDocumentGeneration(), replaced },
  });
}

/** The live origin, re-checked against the editor right now. */
export function currentScheduleOrigin(): ScheduleOrigin | null {
  const armed = useScheduleOriginStore.getState().armed;
  if (!armed) return null;
  const { message } = useMessageStore.getState();
  if (isArmedOriginCurrent(armed, getMessageDocumentGeneration(), message)) return armed;
  useScheduleOriginStore.setState({ armed: null });
  return null;
}

/** React: the scheduled post the editor is editing, or null. */
export function useScheduleOrigin(): ScheduleOrigin | null {
  return useScheduleOriginStore((s) => s.armed);
}

/** Forget the origin — every one, or only the given schedule's. */
export function clearScheduleOrigin(scheduleId?: string): void {
  const armed = useScheduleOriginStore.getState().armed;
  if (!armed || (scheduleId !== undefined && armed.scheduleId !== scheduleId)) return;
  useScheduleOriginStore.setState({ armed: null });
}

/** A save landed: carry the schedule's new time/status forward. */
export function noteScheduleSaved(view: ScheduleView): void {
  const armed = useScheduleOriginStore.getState().armed;
  if (!armed || armed.scheduleId !== view.id) return;
  useScheduleOriginStore.setState({
    armed: { ...armed, runAt: view.next_run_at, tz: view.tz, status: view.status },
  });
}

// Drop the origin the moment its document is gone — synchronously, inside the
// replacing action, so nothing can render (or save) in between.
useMessageStore.subscribe((state) => {
  const armed = useScheduleOriginStore.getState().armed;
  if (armed && !isArmedOriginCurrent(armed, getMessageDocumentGeneration(), state.message)) {
    useScheduleOriginStore.setState({ armed: null });
  }
});

registerAccountStateReset(() => useScheduleOriginStore.setState({ armed: null }));
