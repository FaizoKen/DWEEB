/**
 * "Replace the draft for everyone?" — the one confirm every whole-draft action
 * in the Activity goes through: the Message directory's "Start from scratch"
 * and its template / library / scheduled picks, Restore, and JSON import.
 *
 * `requestRoomReplace` runs the action straight away whenever nothing would be
 * lost for anyone else (see `needsRoomReplaceConfirm`), so solo use never gains
 * a step; otherwise it parks the action until the single `RoomReplaceConfirm`
 * dialog the Activity shell mounts confirms or cancels it. The replace itself is
 * untouched — it still runs through the message store and collab broadcasts it
 * as before; this only asks first.
 */

import { create } from "zustand";
import { useMessageStore } from "@/core/state/messageStore";
import { useActivityStore } from "./activityStore";
import { needsRoomReplaceConfirm } from "./roomReplace";

export interface RoomReplaceRequest {
  /** What's about to happen, phrased as a sentence's subject — "Starting from
   *  scratch", "Loading the “Welcome” template", "Restoring this message". */
  action: string;
  /** The confirm button's label; "Replace for everyone" when omitted. */
  confirmLabel?: string;
  /** The replace itself — run at once, or once the user confirms. */
  run: () => void;
}

interface RoomReplaceState {
  /** The replace waiting on the confirm dialog, or null when none is. */
  pending: RoomReplaceRequest | null;
}

export const useRoomReplaceStore = create<RoomReplaceState>(() => ({ pending: null }));

/** Replace the shared draft — asking first when others are editing it. */
export function requestRoomReplace(request: RoomReplaceRequest): void {
  const { participants, user } = useActivityStore.getState();
  const message = useMessageStore.getState().message;
  if (!needsRoomReplaceConfirm(message, participants, user?.id)) {
    request.run();
    return;
  }
  useRoomReplaceStore.setState({ pending: request });
}

/** The user confirmed: run the parked replace. */
export function confirmRoomReplace(): void {
  const pending = useRoomReplaceStore.getState().pending;
  if (!pending) return;
  // Clear first, so a replace that itself asks again (it never should) can't be
  // swallowed by this one's teardown.
  useRoomReplaceStore.setState({ pending: null });
  pending.run();
}

/** The user backed out: drop the parked replace without running it. */
export function cancelRoomReplace(): void {
  if (useRoomReplaceStore.getState().pending) useRoomReplaceStore.setState({ pending: null });
}
