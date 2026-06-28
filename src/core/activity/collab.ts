/**
 * Real-time collaboration over the Activity room WebSocket.
 *
 * Everyone in the same Activity instance shares one editor. The model is
 * deliberately simple — **last-write-wins on the whole message**:
 *
 *  - Local edits to the message store are debounced and broadcast as a `draft`
 *    frame tagged with this connection's id (`cid`).
 *  - Incoming `draft` frames from *other* connections are applied straight to the
 *    store (bypassing history/id-reassignment) so the tree stays identical across
 *    peers and the editor doesn't fight the typist.
 *  - A joiner announces itself with `hello`; existing peers reply with their
 *    current draft, so a latecomer inherits the in-progress message without
 *    clobbering anyone (a newcomer never broadcasts its own default on open).
 *  - `roster` frames (server-authored) drive the presence list.
 *
 * It's intentionally not a CRDT: concurrent edits to the same field resolve to
 * whoever typed last. That's the honest, robust v1 for a small group co-writing
 * one announcement.
 */

import { useMessageStore } from "@/core/state/messageStore";
import type { WebhookMessage } from "@/core/schema/types";
import { PROXY_BASE_URL } from "@/core/guild/config";

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
/** Set while applying a remote draft, so the store subscription doesn't
 *  re-broadcast it back out as a "local" edit. */
let applyingRemote = false;
let opts: StartOptions | null = null;

/** Open the room socket and start syncing the message store. Idempotent-ish:
 *  calling it again tears down the previous session first. */
export function startCollab(options: StartOptions): void {
  stopCollab();
  stopped = false;
  opts = options;
  cid = randomId();
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
    // A peer just joined — hand them our current draft.
    sendDraft(useMessageStore.getState().message);
    return;
  }
  if (type === "draft" && frame.message && typeof frame.message === "object") {
    applyRemote(frame.message as WebhookMessage);
  }
}

/** Apply a peer's draft without pushing history or reassigning editor ids, so
 *  the component tree (and thus selection by id) stays consistent across peers
 *  and the apply doesn't echo back out as a local edit. */
function applyRemote(message: WebhookMessage): void {
  applyingRemote = true;
  try {
    useMessageStore.setState({ message });
  } finally {
    applyingRemote = false;
  }
}

function subscribeStore(): void {
  unsubStore = useMessageStore.subscribe((state, prev) => {
    if (applyingRemote) return;
    if (state.message === prev.message) return; // selection-only change, etc.
    scheduleSend(state.message);
  });
}

function scheduleSend(message: WebhookMessage): void {
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    sendTimer = null;
    sendDraft(message);
  }, SEND_DEBOUNCE_MS);
}

function sendDraft(message: WebhookMessage): void {
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
