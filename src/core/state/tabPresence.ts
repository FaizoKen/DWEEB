/**
 * "Is another DWEEB tab open right now?" — asked before deleting persisted
 * uploads.
 *
 * Every tab shares one IndexedDB of upload bytes, but each tab decides what is
 * an orphan from its *own* view: its editor, undo stack and saved-message list.
 * A tab that had loaded a saved message could lose that message's uploads the
 * moment another tab deleted the save (that tab's cleanup evicted the bytes),
 * and a new tab booting over a shared draft another tab had moved on from
 * pruned uploads a third tab still showed — both surfaced only on the next
 * reload, as "attachment missing". So bytes are deleted only when no other tab
 * answers; memory is still freed at once, and a tab that finds itself alone
 * prunes whatever the others left behind.
 *
 * Best-effort by design: without BroadcastChannel a tab can't hear the others,
 * and behaves as it always did.
 */

const CHANNEL = "dweeb-tab-presence";

interface PresenceMessage {
  type: "ping" | "pong";
  id: string;
}

let channel: BroadcastChannel | null = null;
const waiting = new Map<string, () => void>();

function ensureChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
  channel.onmessage = (event: MessageEvent<PresenceMessage>) => {
    const msg = event.data;
    if (!msg || typeof msg.id !== "string") return;
    if (msg.type === "ping") channel?.postMessage({ type: "pong", id: msg.id });
    else if (msg.type === "pong") waiting.get(msg.id)?.();
  };
  // Node (tests) keeps the process alive for an open channel; browsers have no
  // such method and need none.
  (channel as unknown as { unref?: () => void }).unref?.();
  return channel;
}

/** Answer other tabs' pings from now on. Idempotent. */
export function startTabPresence(): void {
  ensureChannel();
}

/**
 * Whether another tab answers within `waitMs`. A tab never hears its own
 * messages on a BroadcastChannel, so a reply always comes from somebody else.
 */
export function otherTabsOpen(waitMs = 250): Promise<boolean> {
  const ch = ensureChannel();
  if (!ch) return Promise.resolve(false);
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return new Promise<boolean>((resolve) => {
    const done = (answer: boolean) => {
      waiting.delete(id);
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), waitMs);
    waiting.set(id, () => done(true));
    try {
      ch.postMessage({ type: "ping", id } satisfies PresenceMessage);
    } catch {
      done(false);
    }
  });
}
