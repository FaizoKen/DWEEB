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
 *  - A server-authored `resync` means our socket missed relayed frames (the
 *    room's broadcast backlog overflowed) — we re-send `hello` so peers hand us
 *    their full draft again, closing any silent divergence.
 *
 * The server relays every frame opaquely, so this protocol is entirely
 * client-side. It's intentionally not a CRDT: concurrent edits to the *same*
 * node resolve to whoever typed last — the honest, robust tradeoff for a small
 * group co-writing one announcement. One corollary worth knowing (pinned by
 * `messageStore.test.ts`): remote frames bypass the local undo history, so an
 * undo restores the whole pre-edit snapshot — including nodes a peer has since
 * edited — and re-broadcasts it. Same rule, applied to time travel.
 *
 * The socket authenticates with a single-use ticket minted over an
 * authenticated POST (`/api/activity/room-ticket`) right before each connect,
 * so the WS URL never carries the Discord access token.
 */

import { useMessageStore } from "@/core/state/messageStore";
import type { WebhookMessage } from "@/core/schema/types";
import type { EditorId } from "@/core/schema/types";
import { PROXY_BASE_URL } from "@/core/guild/config";
import { mintRoomTicket } from "./api";
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
  /** A custom bot's one-time connect flow just completed (server-authored push
   *  from the connect callback), so it's now ready to post as. Carries the
   *  application id. Delivered over the live socket, so it lands even while the
   *  Activity is backgrounded during the external-browser OAuth. */
  onBotConnected?: (applicationId: string) => void;
  /** The Activity's own sign-in is no longer valid: minting a room ticket was
   *  refused outright (401/403 — revoked/expired token, or membership lost).
   *  Reconnecting can only fail the same way, so collab stops for good and the
   *  shell tells the user to relaunch. Editing continues solo. */
  onAuthExpired?: () => void;
  /** The room's starting content has settled — fired once. Either we adopted a
   *  full-message draft from the room (a latecomer's `hello` reply, or the
   *  server's `resume` of a persisted draft) and it's now in the store, or — for a
   *  brand-new room where nothing's coming — a grace armed on socket connect
   *  elapsed. Lets the shell reveal the editor only once its real starting content
   *  is in place, never flashing the fresh-open default first. */
  onHydrated?: () => void;
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
/** How long after the socket CONNECTS we wait for the room's initial draft before
 *  revealing the editor anyway (see `onHydrated`). A room with a draft answers our
 *  `hello` well within this; a brand-new room sends nothing, so this bounds the
 *  wait for that case. Timed from connect — not launch — so a slow socket can't
 *  reveal the fresh-open default before a draft has had a chance to arrive. */
const HYDRATE_GRACE_MS = 700;

let socket: WebSocket | null = null;
let unsubStore: (() => void) | null = null;
let unsubSelection: (() => void) | null = null;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let hydrateGraceTimer: ReturnType<typeof setTimeout> | null = null;
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
/**
 * Whether we've announced the room's initial-draft settle (see `onHydrated`).
 * Fired once per session, the first time we adopt a full-message draft from the
 * room, so the shell can reveal the builder with the real content already in
 * place. Reset on each `startCollab`.
 */
let hydratedFired = false;
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
  hydratedFired = false;
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
  if (hydrateGraceTimer) clearTimeout(hydrateGraceTimer);
  sendTimer = null;
  snapshotTimer = null;
  reconnectTimer = null;
  hydrateGraceTimer = null;
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

function roomUrl(o: StartOptions, ticket: string): string {
  const wsBase = PROXY_BASE_URL.replace(/^http/i, "ws");
  // Only the single-use ticket rides the URL. Identity — and the guild
  // membership gate, on a server launch — were established when it was minted
  // (`POST /api/activity/room-ticket`, a normal bearer call), so no long-lived
  // credential can end up in an access log via this URL.
  const q = new URLSearchParams({ ticket });
  return `${wsBase}/api/activity/room/${encodeURIComponent(o.instanceId)}?${q.toString()}`;
}

function connect(): void {
  if (stopped || !opts) return;
  const o = opts;
  void (async () => {
    // Every (re)connect mints its own single-use ticket — the credential the
    // socket URL carries instead of the Discord access token.
    let ticket: string;
    try {
      ticket = await mintRoomTicket(o.instanceId, o.guildId);
    } catch (e) {
      // The session may have been torn down (or restarted) while we awaited.
      if (stopped || opts !== o) return;
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) {
        // Definitive: the Activity's sign-in itself is no longer valid
        // (revoked/expired token, or membership lost). Every retry would be
        // refused the same way — stop for good and let the shell say
        // "relaunch", instead of looping on the backoff forever.
        stopped = true;
        o.onConnectedChange?.(false);
        o.onAuthExpired?.();
        return;
      }
      // Transient (network, proxy restart) — keep the usual backoff.
      scheduleReconnect();
      return;
    }
    if (stopped || opts !== o) return;
    openSocket(o, ticket);
  })();
}

function openSocket(o: StartOptions, ticket: string): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(roomUrl(o, ticket));
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
    // Arm the fresh-room reveal fallback: if no draft answers our `hello` within
    // the grace, reveal the editor anyway (nothing's coming). Started here, on
    // connect, so the wait is measured from when a draft could actually arrive.
    // A draft landing first cancels it (see `signalHydrated`); on a reconnect
    // it's already fired, so the guard skips re-arming.
    if (!hydratedFired && !hydrateGraceTimer) {
      hydrateGraceTimer = setTimeout(signalHydrated, HYDRATE_GRACE_MS);
    }
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
  if (type === "bot_connected") {
    // Server-authored: a custom bot's connect flow finished, so it's ready to
    // post as. No `cid` (it's not a peer relay), so it's handled before the
    // echo guard below.
    const appId = typeof frame.application_id === "string" ? frame.application_id : "";
    if (appId) opts?.onBotConnected?.(appId);
    return;
  }
  if (type === "resync") {
    // Server-authored: our subscription outran the room's broadcast backlog and
    // frames were dropped — under per-node patch sync a missed patch is an op
    // we'll never see, so our tree may have silently diverged. Re-run the join
    // handshake: peers answer `hello` with their full current draft, which
    // `applyFull` reconciles against our un-broadcast local edits (nothing
    // pending is lost), and we re-announce our focus so our presence ring
    // survives the round trip. Handled before the echo guard (no `cid`).
    send({ type: "hello", cid });
    if (currentFocus) sendFocus(currentFocus);
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

/** Tell the shell the room's initial content has settled, exactly once — the
 *  first time we take in a full draft (from `applyFull`) or, for a fresh room,
 *  when the connect grace elapses with nothing received. Clears the grace timer
 *  so the two paths can't double-fire. */
function signalHydrated(): void {
  if (hydratedFired) return;
  hydratedFired = true;
  if (hydrateGraceTimer) {
    clearTimeout(hydrateGraceTimer);
    hydrateGraceTimer = null;
  }
  opts?.onHydrated?.();
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
    // We received the room's draft (kept ours for a structural conflict, but the
    // initial sync is settled) — safe to reveal.
    signalHydrated();
    return;
  }

  const next = pending.length > 0 ? applyOps(message, pending) : message;
  applyingRemote = true;
  try {
    useMessageStore.setState({ message: next });
  } finally {
    applyingRemote = false;
  }
  // The store now holds the room's draft — reveal the shell AFTER that write, not
  // before, so the component list appears with the real message already in place.
  // Flipping the reveal first (as an earlier version did) leaves one frame where
  // the tree is shown but still holds the fresh-open default — the flash we're
  // avoiding.
  signalHydrated();
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
