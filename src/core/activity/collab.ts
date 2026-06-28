/**
 * Real-time collaboration over the Activity room WebSocket.
 *
 * Everyone in the same Activity instance shares one editor. Sync is **granular,
 * last-write-wins per node** (see `collabPatch.ts`):
 *
 *  - Local edits are debounced, then diffed against the last state we synced.
 *    The diff is broadcast as a `patch` frame (a handful of per-node ops) tagged
 *    with this connection's id (`cid`) — or, when the top-level component list
 *    changed shape, as a whole-message `draft` frame.
 *  - Incoming `patch`/`draft` frames from *other* connections are applied
 *    straight to the store (bypassing history/id-reassignment) so the tree stays
 *    identical across peers and the editor doesn't fight the typist. Applying a
 *    patch touches only the named nodes, so two people editing *different* parts
 *    no longer clobber each other.
 *  - A joiner announces itself with `hello`; existing peers reply with their
 *    full current draft, so a latecomer inherits the in-progress message without
 *    clobbering anyone (a newcomer never broadcasts its own default on open).
 *  - `roster` frames (server-authored) drive the presence list.
 *
 * The server relays every frame opaquely, so this protocol is entirely
 * client-side. It's intentionally not a CRDT: concurrent edits to the *same*
 * node resolve to whoever typed last — the honest, robust tradeoff for a small
 * group co-writing one announcement.
 */

import { useMessageStore } from "@/core/state/messageStore";
import type { WebhookMessage } from "@/core/schema/types";
import { PROXY_BASE_URL } from "@/core/guild/config";
import { applyOps, diffMessage, type CollabOp } from "./collabPatch";

/** One participant, as the server's `roster` frame lists them. */
export interface CollabParticipant {
  id: string;
  name: string;
  avatar: string | null;
}

interface StartOptions {
  instanceId: string;
  /** The launching guild, or null on a DM / group-DM launch (no guild to gate
   *  the room on — the unguessable instance id keys it instead). */
  guildId: string | null;
  token: string;
  onRoster: (participants: CollabParticipant[]) => void;
  onConnectedChange?: (connected: boolean) => void;
}

const SEND_DEBOUNCE_MS = 180;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 15000;

let socket: WebSocket | null = null;
let unsubStore: (() => void) | null = null;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let stopped = false;
/** Unique per connection so we can ignore the echo of our own frames. */
let cid = "";
/** Set while applying a remote frame, so the store subscription doesn't
 *  re-broadcast it back out as a "local" edit. */
let applyingRemote = false;
/**
 * The last message state we've synced with the room — the baseline every local
 * diff is computed against. It tracks *what peers know*, so it advances on each
 * send and, on receiving a remote patch, by replaying that patch (NOT by reading
 * the store, which may also hold our own not-yet-broadcast edits).
 */
let lastSent: WebhookMessage | null = null;
let opts: StartOptions | null = null;

/** Open the room socket and start syncing the message store. Idempotent-ish:
 *  calling it again tears down the previous session first. */
export function startCollab(options: StartOptions): void {
  stopCollab();
  stopped = false;
  opts = options;
  cid = randomId();
  // Baseline for the first diff — peers reconcile via the hello/draft exchange.
  lastSent = useMessageStore.getState().message;
  subscribeStore();
  connect();
}

/** Tear everything down (socket, store subscription, timers). */
export function stopCollab(): void {
  stopped = true;
  if (sendTimer) clearTimeout(sendTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  sendTimer = null;
  reconnectTimer = null;
  unsubStore?.();
  unsubStore = null;
  lastSent = null;
  if (socket) {
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    socket = null;
  }
}

function roomUrl(o: StartOptions): string {
  const wsBase = PROXY_BASE_URL.replace(/^http/i, "ws");
  const q = new URLSearchParams({ token: o.token });
  // Sent only for a server launch — the proxy gates the room on guild membership
  // when present, and skips that gate for a DM launch (no guild).
  if (o.guildId) q.set("guild", o.guildId);
  return `${wsBase}/api/activity/room/${encodeURIComponent(o.instanceId)}?${q.toString()}`;
}

function connect(): void {
  if (stopped || !opts) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(roomUrl(opts));
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    reconnectAttempts = 0;
    opts?.onConnectedChange?.(true);
    // Announce ourselves; existing peers answer with their current draft.
    send({ type: "hello", cid });
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return;
    }
    handleFrame(frame);
  };

  ws.onclose = () => {
    opts?.onConnectedChange?.(false);
    socket = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    // `onclose` always follows, which owns the reconnect; nothing to do here.
  };
}

function handleFrame(frame: Record<string, unknown>): void {
  const type = frame.type;
  if (type === "roster") {
    const participants = Array.isArray(frame.participants)
      ? (frame.participants as CollabParticipant[])
      : [];
    opts?.onRoster(participants);
    return;
  }
  // Ignore the echo of our own frames.
  if (frame.cid === cid) return;
  if (type === "hello") {
    // A peer just joined — hand them our full current draft (a latecomer can't
    // replay patch history, so it needs the whole state).
    sendSnapshot(useMessageStore.getState().message);
    return;
  }
  if (type === "draft" && frame.message && typeof frame.message === "object") {
    applyFull(frame.message as WebhookMessage);
    return;
  }
  if (type === "patch" && Array.isArray(frame.ops)) {
    applyPatch(frame.ops as CollabOp[]);
  }
}

/** Replace the whole message with a peer's snapshot (latecomer sync or a
 *  top-level structural change). Bypasses history/id-reassignment so the tree
 *  stays identical across peers. */
function applyFull(message: WebhookMessage): void {
  applyingRemote = true;
  try {
    useMessageStore.setState({ message });
  } finally {
    applyingRemote = false;
  }
  // Our baseline is now exactly the peer's state. A full snapshot supersedes any
  // un-sent local edit — the accepted edge of last-write-wins, and only sent for
  // a latecomer or a top-level structural change.
  lastSent = message;
}

/** Apply a peer's per-node ops, touching only the named nodes so a concurrent
 *  local edit elsewhere is preserved. */
function applyPatch(ops: CollabOp[]): void {
  applyingRemote = true;
  try {
    useMessageStore.setState((s) => ({ message: applyOps(s.message, ops) }));
  } finally {
    applyingRemote = false;
  }
  // Advance the baseline by the SAME ops rather than reading the store: the
  // store may also hold our own not-yet-broadcast edits, which must remain a
  // diff to send on the next sync.
  if (lastSent) lastSent = applyOps(lastSent, ops);
}

function subscribeStore(): void {
  unsubStore = useMessageStore.subscribe((state, prev) => {
    if (applyingRemote) return;
    if (state.message === prev.message) return; // selection-only change, etc.
    scheduleSync();
  });
}

function scheduleSync(): void {
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    sendTimer = null;
    syncNow();
  }, SEND_DEBOUNCE_MS);
}

/** Diff the current message against our last synced baseline and broadcast the
 *  change — a granular `patch`, or a full `draft` when the diff isn't expressible
 *  in place (top-level structure changed, or there's no baseline yet). */
function syncNow(): void {
  const current = useMessageStore.getState().message;
  const base = lastSent;
  lastSent = current;
  if (!base) {
    sendSnapshot(current);
    return;
  }
  const ops = diffMessage(base, current);
  if (ops === null) {
    sendSnapshot(current);
    return;
  }
  if (ops.length === 0) return; // nothing semantic changed
  send({ type: "patch", cid, ops });
}

function sendSnapshot(message: WebhookMessage): void {
  send({ type: "draft", cid, message });
}

function send(frame: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      /* dropped frame — the next edit (or reconnect) supersedes it */
    }
  }
}

function scheduleReconnect(): void {
  if (stopped) return;
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}
