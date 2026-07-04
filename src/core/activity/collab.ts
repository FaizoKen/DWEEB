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
import type { EditorId } from "@/core/schema/types";
import { PROXY_BASE_URL } from "@/core/guild/config";
import { applyOps, diffMessage, type CollabOp } from "./collabPatch";
import { usePresenceStore } from "./presence";

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
  /** The signed-in editor, stamped onto every `focus` frame so peers can render
   *  per-node presence (avatar + ring) without waiting on the roster to resolve. */
  self: { id: string; name: string; avatar: string | null };
  /** The post destination chosen at start (a server launch's launching channel) —
   *  seeds the room's shared target so a latecomer inherits it. Ignored on a DM
   *  launch, where collaborators don't share a postable server. */
  targetChannelId: string | null;
  onRoster: (participants: CollabParticipant[]) => void;
  onConnectedChange?: (connected: boolean) => void;
  /** A peer moved the shared post destination (server launch only). */
  onTarget?: (channelId: string) => void;
  /** The host's plan caps concurrent co-editors and this room is full — the
   *  server refused the socket. `cap` is that limit. Editing continues solo, and
   *  we stop retrying (a reconnect would just be refused again). */
  onRoomFull?: (cap: number) => void;
}

const SEND_DEBOUNCE_MS = 180;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 15000;
/** How often, at most, we send a full-message `snapshot` frame for the server to
 *  persist (see `activity_draft.rs`) — so a reopened room resumes where it was
 *  left off. Throttled well above the edit-sync rate: it's a durability
 *  heartbeat, not a sync channel (peers already have the live state via patches),
 *  so a few seconds of lag on the stored copy is fine. */
const SNAPSHOT_THROTTLE_MS = 4000;

let socket: WebSocket | null = null;
let unsubStore: (() => void) | null = null;
let unsubSelection: (() => void) | null = null;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let lastSnapshotAt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let stopped = false;
/** The node this connection currently has selected (its editing focus), tracked
 *  so a joiner's `hello` can be answered with where we are and a reconnect can
 *  re-announce it. Null when nothing is selected. */
let currentFocus: EditorId | null = null;
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
/**
 * The room's agreed post destination, on a server launch (null on a DM launch,
 * which doesn't sync it). Tracks what peers know — it advances on a local
 * broadcast or an inbound `target` frame — so a joiner's `hello` can be answered
 * with the current channel and latecomers land on the same destination.
 */
let currentTarget: string | null = null;
/**
 * Whether our editor has moved off its fresh-open baseline this session — set the
 * first time we make a local edit or apply any peer state. It gates the server's
 * `resume` frame: a fresh reopen (nothing edited yet) loads the persisted draft,
 * but a reconnect (which already holds newer local/live state) ignores it, so a
 * brief drop can't revert the room to the ≤throttle-stale stored copy.
 */
let diverged = false;
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
  currentTarget = options.targetChannelId;
  currentFocus = useMessageStore.getState().selectedId;
  diverged = false;
  subscribeStore();
  subscribeSelection();
  connect();
}

/** Broadcast a new shared post destination to the room, so everyone's editor
 *  re-points to the same channel. No-op on a DM launch (collaborators don't share
 *  a postable server, so there's nothing to agree on) and when nothing changed. */
export function broadcastTarget(channelId: string): void {
  if (!opts?.guildId) return;
  if (currentTarget === channelId) return;
  currentTarget = channelId;
  send({ type: "target", cid, channelId });
}

/** Tear everything down (socket, store subscription, timers). */
export function stopCollab(): void {
  stopped = true;
  // Best-effort final snapshot so the last few seconds of edits (still inside the
  // throttle window) aren't lost when the closer is the room's last member —
  // send it before we tear the socket down below.
  if (snapshotTimer && socket && socket.readyState === WebSocket.OPEN) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    sendPersistSnapshot();
  }
  if (sendTimer) clearTimeout(sendTimer);
  if (snapshotTimer) clearTimeout(snapshotTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  sendTimer = null;
  snapshotTimer = null;
  reconnectTimer = null;
  unsubStore?.();
  unsubStore = null;
  unsubSelection?.();
  unsubSelection = null;
  lastSnapshotAt = 0;
  lastSent = null;
  currentTarget = null;
  currentFocus = null;
  // Clear everyone's per-node presence rings — the room is gone.
  usePresenceStore.getState().reset();
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
    // Announce ourselves; existing peers answer with their current draft. We do
    // NOT flush pending offline edits here: the baseline (`lastSent`) stays at the
    // pre-drop state, so when a peer's answering draft lands, `applyFull` reapplies
    // our still-pending edits on top of it and then broadcasts them. Flushing a
    // patch here first would advance the baseline and let a peer's *stale* draft
    // (sent before our patch reached it) overwrite us — the race `applyFull` avoids
    // by reconciling against the un-advanced baseline instead.
    send({ type: "hello", cid });
    // Re-announce where we're editing so a reconnect restores our presence ring
    // for everyone (peers dropped it when our socket closed).
    if (currentFocus) sendFocus(currentFocus);
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
    // Drop per-node presence for anyone no longer in the room, so a peer who
    // left stops haunting the block they had open (their socket close doesn't
    // send a focus-clear; the roster is the authority on who's still here).
    usePresenceStore.getState().retain(participants.map((p) => p.id));
    return;
  }
  if (type === "room_full") {
    // The host's plan caps concurrent co-editors and this room is full. Stop
    // reconnecting (it would just be refused again) and let the app notify the
    // user; the Activity still works solo.
    stopped = true;
    opts?.onConnectedChange?.(false);
    opts?.onRoomFull?.(typeof frame.cap === "number" ? frame.cap : 0);
    return;
  }
  // Ignore the echo of our own frames.
  if (frame.cid === cid) return;
  if (type === "hello") {
    // A peer just joined — hand them our full current draft (a latecomer can't
    // replay patch history, so it needs the whole state) and, on a server launch,
    // the room's agreed destination so they don't land on a stale default.
    sendSnapshot(useMessageStore.getState().message);
    if (opts?.guildId && currentTarget) {
      send({ type: "target", cid, channelId: currentTarget });
    }
    // Also tell them where we're editing so our presence ring shows up for the
    // newcomer straight away, not only on our next selection change.
    if (currentFocus) sendFocus(currentFocus);
    return;
  }
  if (type === "focus") {
    // A peer moved (or cleared) their editing focus — repaint their presence
    // ring on the named node. `nodeId` null means they deselected. Identity
    // rides in the frame, so rendering doesn't depend on roster ordering.
    const userId = typeof frame.userId === "string" ? frame.userId : null;
    if (!userId) return;
    const nodeId = typeof frame.nodeId === "string" ? (frame.nodeId as EditorId) : null;
    const name = typeof frame.name === "string" ? frame.name : "Someone";
    const avatar = typeof frame.avatar === "string" ? frame.avatar : null;
    usePresenceStore.getState().setFocus({ userId, name, avatar }, nodeId);
    return;
  }
  if (type === "draft" && frame.message && typeof frame.message === "object") {
    applyFull(frame.message as WebhookMessage);
    return;
  }
  if (type === "resume" && frame.message && typeof frame.message === "object") {
    // The server replayed the persisted draft to us as the room's first member.
    // Load it only if we haven't diverged from our fresh-open baseline — a plain
    // reconnect already holds newer state and must ignore it. `applyFull` marks us
    // diverged, so a rapid second `resume` won't re-apply.
    if (!diverged) applyFull(frame.message as WebhookMessage);
    return;
  }
  if (type === "patch" && Array.isArray(frame.ops)) {
    applyPatch(frame.ops as CollabOp[]);
    return;
  }
  if (type === "target" && typeof frame.channelId === "string") {
    // A peer moved the shared post destination. Server launch only — a DM launch
    // never sends these (collaborators don't share a postable server), and the
    // guard keeps a stray frame from re-pointing a DM composer's local choice.
    if (opts?.guildId) {
      currentTarget = frame.channelId;
      opts.onTarget?.(frame.channelId);
    }
  }
}

/** Adopt a peer's full-message snapshot (latecomer sync, a top-level structural
 *  change, or a reconnect peer answering our `hello`) — but reconcile it with any
 *  local edits we haven't managed to broadcast yet, so an inbound full message
 *  never silently discards local work.
 *
 *  This is a three-way merge against our last synced baseline (`lastSent`):
 *  reapply our pending per-node ops on top of the incoming draft. Nodes only the
 *  peer touched come through; nodes we edited offline (or mid-keystroke, before a
 *  peer's structural `draft` landed) survive. Without it, a peer's reconnect
 *  snapshot overwrites edits made while our socket was down — the offline-edit
 *  data-loss bug. When nothing is pending this reduces to adopting the peer's
 *  state verbatim, exactly as before. */
function applyFull(message: WebhookMessage): void {
  const ours = useMessageStore.getState().message;
  const pending = lastSent ? diffMessage(lastSent, ours) : [];

  // A top-level structural change we haven't broadcast can't be merged per node.
  // Don't drop it: keep our version and let the next sync re-broadcast it as a
  // full draft (last-write-wins wholesale — the documented tradeoff for a
  // structural conflict). Adopt the peer's frame only as the new baseline so the
  // diff recomputes against it.
  if (pending === null) {
    lastSent = message;
    diverged = true;
    scheduleSync();
    return;
  }

  const next = pending.length > 0 ? applyOps(message, pending) : message;
  applyingRemote = true;
  try {
    useMessageStore.setState({ message: next });
  } finally {
    applyingRemote = false;
  }
  // Baseline is the peer's frame; any reapplied local ops remain a pending diff
  // against it, so the next sync re-broadcasts our surviving edits to the room.
  lastSent = message;
  // We now hold live room state; a later server `resume` must not revert us.
  diverged = true;
  if (pending.length > 0) scheduleSync();
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
  // A peer's edit means we're tracking live room state — don't let a later
  // server `resume` revert us.
  diverged = true;
}

function subscribeStore(): void {
  unsubStore = useMessageStore.subscribe((state, prev) => {
    if (applyingRemote) return;
    if (state.message === prev.message) return; // selection-only change, etc.
    // A genuine local edit — we've moved off the fresh-open baseline, so a later
    // server `resume` must not clobber us (see `diverged`).
    diverged = true;
    scheduleSync();
  });
}

/** Broadcast our editing focus whenever the local selection changes, so peers
 *  can paint a presence ring on the block we're in. Selection changes are
 *  click-rate, so there's nothing to debounce — we just skip no-op repeats. */
function subscribeSelection(): void {
  unsubSelection = useMessageStore.subscribe((state, prev) => {
    if (state.selectedId === prev.selectedId) return;
    // A remote patch can drop the selected node; that still counts as a move.
    currentFocus = state.selectedId;
    sendFocus(state.selectedId);
  });
}

/** Send a `focus` frame stamped with our identity so peers can render (or clear,
 *  when `nodeId` is null) our per-node presence without a roster lookup. */
function sendFocus(nodeId: EditorId | null): void {
  const self = opts?.self;
  if (!self) return;
  send({ type: "focus", cid, userId: self.id, name: self.name, avatar: self.avatar, nodeId });
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
  // The baseline only advances when the frame actually goes on the wire (see
  // `send`). If the socket is down, `current` stays a pending diff against the
  // old baseline, so a reconnect re-broadcasts the whole accumulated change
  // instead of silently swallowing edits made while disconnected.
  if (!base) {
    if (sendSnapshot(current)) {
      lastSent = current;
      schedulePersist();
    }
    return;
  }
  const ops = diffMessage(base, current);
  if (ops === null) {
    if (sendSnapshot(current)) {
      lastSent = current;
      schedulePersist();
    }
    return;
  }
  if (ops.length === 0) return; // nothing semantic changed
  if (send({ type: "patch", cid, ops })) {
    lastSent = current;
    schedulePersist();
  }
}

/** Broadcast the whole message as a `draft`; returns whether it was sent. */
function sendSnapshot(message: WebhookMessage): boolean {
  return send({ type: "draft", cid, message });
}

/**
 * Queue a throttled full-message `snapshot` frame for the server to persist, so
 * a reopened room resumes where it was left off. Trailing-edge throttled: the
 * first edit after a quiet spell schedules a snapshot ≤ SNAPSHOT_THROTTLE_MS out,
 * and further edits within that window fold into it. Distinct from the `draft`
 * frame — the server stores a `snapshot` but never relays it to peers, so it can
 * never trigger a full-message revert on someone mid-edit.
 */
function schedulePersist(): void {
  if (snapshotTimer) return;
  const elapsed = Date.now() - lastSnapshotAt;
  const delay = Math.max(0, SNAPSHOT_THROTTLE_MS - elapsed);
  snapshotTimer = setTimeout(sendPersistSnapshot, delay);
}

/** Emit the persistence snapshot now (reads the freshest message). */
function sendPersistSnapshot(): void {
  snapshotTimer = null;
  lastSnapshotAt = Date.now();
  send({ type: "snapshot", cid, message: useMessageStore.getState().message });
}

/** Put a frame on the wire, returning whether it actually went out. The caller
 *  uses this to decide whether to advance the sync baseline: a frame dropped
 *  because the socket is closed (an edit made while disconnected) must NOT
 *  advance `lastSent`, or the change is never a diff to re-broadcast on
 *  reconnect — the offline-edit data-loss bug. */
function send(frame: unknown): boolean {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false; // dropped — a later sync (or reconnect) supersedes it
    }
  }
  return false;
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
