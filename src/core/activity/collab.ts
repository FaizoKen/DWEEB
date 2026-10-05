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
 *  - A peer's full `draft` that shares no node with what we had is someone
 *    replacing the whole message (a template, "Start from scratch", Restore, an
 *    import) — `onPeerReplace` tells the shell so it can say who did it. Nothing
 *    on the wire marks it: every replace re-ids the whole tree, so no id
 *    surviving *is* the signal (`isWholeDocumentReplace`), and who sent it comes
 *    from the identity each connection already stamps on its `focus` frames — a
 *    replacer sends one just before its draft.
 *
 *  - **Nothing goes out until we know what the room holds** (`synced`). A
 *    joiner's editor starts on the fresh-open default, not the room's work, and
 *    peers adopt a full draft wholesale — so an unsynced connection never answers
 *    a `hello`, never sends a patch, draft or snapshot, and doesn't reveal the
 *    editor on the connect grace while others are present. It becomes synced by
 *    adopting a peer draft, by the server's `resume` (sent only to the room's
 *    first member), or by finding nobody else in the room. A connection that has
 *    never synced adopts the room's draft verbatim: edits made on the default
 *    were never the room's, and merging them in is how a default once wiped
 *    everyone's work. A reconnect is unsynced again until it hears back, and its
 *    held offline edits are merged on top of what it hears (or, alone, sent).
 *  - **Frames apply in the server's relay order** — our own included. The
 *    server echoes every relayed frame to its sender, so a peer frame that
 *    arrives before the echo of one of ours was relayed *before* ours: everyone
 *    else applies it first and ours on top. So we re-apply our in-flight
 *    patches over it (and an in-flight full draft supersedes it outright),
 *    rebasing any newer unsent typing on top. Without this, two people typing in
 *    one block each ended on the *other's* text, permanently.
 *  - A `hello` answer is addressed (`to`) — a synced peer ignores answers meant
 *    for someone else, which carry nothing new and could only revert edits still
 *    in flight. Older clients ignore the field and behave as before.
 *
 * The server relays every frame opaquely, so this protocol is entirely
 * client-side. It's intentionally not a CRDT: concurrent edits to the *same*
 * node resolve to whichever reached the server last — the honest, robust
 * tradeoff for a small group co-writing one announcement. One corollary worth
 * knowing (pinned by `messageStore.test.ts`): remote frames bypass the local
 * undo history, so an undo restores the whole pre-edit snapshot — including
 * nodes a peer has since edited — and re-broadcasts it. Same rule, applied to
 * time travel.
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
import { applyOps, diffMessage, isWholeDocumentReplace, type CollabOp } from "./collabPatch";
import { usePresenceStore } from "./presence";
import type { ReplaceActor } from "./roomReplace";

/** One participant, as the server's `roster` frame lists them. */
export interface CollabParticipant {
  id: string;
  name: string;
  avatar: string | null;
}

/** A peer's whole-message replace that just landed in our editor. */
export interface PeerReplace {
  /** Who sent it, when their connection has identified itself — null when it
   *  hasn't, or when the draft only arrived as a peer answering our own `hello`
   *  (a reconnect / resync), where the sender isn't necessarily who replaced it. */
  actor: ReplaceActor | null;
  /** The new draft is empty — someone cleared it rather than loading another. */
  cleared: boolean;
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
  /** A peer replaced the whole shared message and we just adopted it — a
   *  remote frame bypasses our undo history, so this is the only sign of what
   *  happened. Never fired for the room's initial sync or a `resume`. */
  onPeerReplace?: (replace: PeerReplace) => void;
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
 *  reveal the fresh-open default before a draft has had a chance to arrive.
 *
 *  The same settle decides when a connection that found nobody else here may
 *  treat its own content as the room's (see `onConnectSettle`): the roster lists
 *  people, not connections, so "nobody else" can still be this user's other tab,
 *  which answers our `hello` well inside the grace. */
const HYDRATE_GRACE_MS = 700;
/** How long one of our relayed frames counts as in flight before we assume its
 *  echo was lost (an oversized frame the server dropped, a socket that lagged)
 *  and stop replaying it over peers' frames. Far above any real relay delay. */
const INFLIGHT_TTL_MS = 10_000;
/** The server's first frame to a new socket is always the roster. One that hasn't
 *  arrived by the settle means a slow link — wait for it rather than guess the
 *  room is empty, but not forever. */
const ROSTER_OVERDUE_MS = 5_000;

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
/**
 * Whether we've announced the room's initial-draft settle (see `onHydrated`).
 * Fired once per session, the first time we adopt a full-message draft from the
 * room, so the shell can reveal the builder with the real content already in
 * place. Reset on each `startCollab`.
 */
let hydratedFired = false;
/**
 * Who each peer connection is — its `cid` mapped to the identity it stamps on
 * every `focus` frame. Draft frames carry only the `cid`, so this is how a
 * replace gets a name. Pruned against the roster; cleared on teardown.
 */
const peers = new Map<string, ReplaceActor>();
/**
 * Set whenever we send `hello`: the next full draft is almost certainly a peer
 * *answering* it with the room's current state, not that peer replacing
 * anything. `afterHydration` tells a re-sync of a live session (a reconnect or
 * `resync` — worth a nameless notice if the draft changed wholesale meanwhile)
 * from the initial sync (never worth one). Consumed by the first draft, and
 * ignored once stale so a genuine replace much later isn't read as an answer.
 */
let pendingAnswer: { at: number; afterHydration: boolean } | null = null;
const ANSWER_WINDOW_MS = 10_000;
let opts: StartOptions | null = null;
/**
 * Whether this connection holds the room's current content — the gate on every
 * frame that carries content (see the module comment). Reset on each connect,
 * cleared by a drop or a `resync`; set by {@link markSynced}.
 */
let synced = false;
/** Whether any connection this session has synced. Until then our content is the
 *  fresh-open default, so the room's first draft is adopted verbatim. */
let everSynced = false;
/** This connection has seen a roster, and one that listed nobody but us; and
 *  whether the latest one lists anybody else. */
let rosterSeen = false;
let roomWasSolo = false;
let othersHere = false;
/** This connection's settle (see `HYDRATE_GRACE_MS`) has elapsed. */
let connectSettled = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
/** The connect grace has elapsed at least once this session — the reveal waits on
 *  it so this user's other tab can answer before we show our own content. */
let graceElapsed = false;
/** `hello`s that reached us while we couldn't answer truthfully, by sender —
 *  answered once synced unless some other answer reaches them first. */
const owedHellos = new Set<string>();
/** Our relayed content frames whose echo hasn't come back yet, oldest first. */
type InflightFrame =
  | { seq: number; at: number; kind: "patch"; ops: CollabOp[] }
  | { seq: number; at: number; kind: "draft" };
let inflight: InflightFrame[] = [];
/** Sequence stamped on our tracked frames, so one echo retires everything sent
 *  before it (the server relays a connection's frames in order). */
let nextSeq = 1;
/**
 * A shared-destination pick of ours that hasn't come back from the room yet.
 * Until it echoes, any `target` frame we receive was relayed before it (or never
 * saw it — a hello answer while we were offline), so it's stale and ignored
 * rather than silently moving the bar back. `sentAt` is null while it still has
 * to go out (picked while disconnected).
 */
let pendingTarget: { channelId: string; seq: number; sentAt: number | null } | null = null;
/** The exit-flush listeners (see `flushOnExit`), kept to remove them. */
let exitListeners: (() => void) | null = null;

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
  everSynced = false;
  graceElapsed = false;
  subscribeStore();
  subscribeSelection();
  listenForExit();
  connect();
}

/** Broadcast a new shared post destination to the room, so everyone's editor
 *  re-points to the same channel. The frame carries a channel id and nothing else:
 *  every peer posts into the guild the Activity launched in, so that's all they
 *  need — and it must never widen to carry a guild (a peer outside it couldn't
 *  load its channels, and their post gate couldn't be resolved). No-op on a DM
 *  launch (collaborators don't share a postable server, so there's nothing to
 *  agree on) and when nothing changed. A pick made while disconnected is kept and
 *  sent on reconnect (see `pendingTarget`). */
export function broadcastTarget(channelId: string): void {
  if (!opts?.guildId) return;
  if (currentTarget === channelId) return;
  currentTarget = channelId;
  pendingTarget = { channelId, seq: 0, sentAt: null };
  flushTarget();
}

/** Whether a whole-draft replace can judge what it would replace from our own
 *  editor: true unless we're in a live session that hasn't synced with the room
 *  yet (a joiner still on its fresh-open default, or a reconnect that hasn't
 *  heard back). Outside a session — not started, room full, signed out — the
 *  editor is all there is. */
export function isRoomSynced(): boolean {
  return !opts || stopped || synced;
}

/** Tear everything down (socket, store subscription, timers). */
export function stopCollab(): void {
  stopped = true;
  // Best-effort final flush so the last few seconds of edits (still inside the
  // debounce / throttle windows) aren't lost when the closer is the room's last
  // member — send it before we tear the socket down below.
  flushOnExit();
  exitListeners?.();
  exitListeners = null;
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
  peers.clear();
  pendingAnswer = null;
  resetConnectionSync();
  pendingTarget = null;
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
    // A fresh connection knows nothing of what the room did meanwhile.
    resetConnectionSync();
    opts?.onConnectedChange?.(true);
    // Announce ourselves; existing peers answer with their current draft. We do
    // NOT flush pending offline edits here — nothing content-bearing goes out
    // until we've synced (see `synced`): the baseline (`lastSent`) stays at the
    // pre-drop state, so when a peer's answering draft lands, `applyFull` reapplies
    // our still-pending edits on top of it and then broadcasts them. Flushing a
    // patch here first would advance the baseline and let a peer's *stale* draft
    // (sent before our patch reached it) overwrite us — the race `applyFull` avoids
    // by reconciling against the un-advanced baseline instead.
    sendHello();
    // A destination picked while we were offline goes out now — it's newer than
    // whatever a peer's answer is about to say.
    flushTarget();
    // Re-announce where we're editing so a reconnect restores our presence ring
    // for everyone (peers dropped it when our socket closed).
    if (currentFocus) sendFocus(currentFocus);
    // Arm the settle: the fresh-room reveal fallback (no draft answered our
    // `hello` within the grace — nothing's coming) and, for a room we found
    // empty, the moment our own content counts as the room's. Started here, on
    // connect, so the wait is measured from when a draft could actually arrive.
    settleTimer = setTimeout(onConnectSettle, HYDRATE_GRACE_MS);
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
    // Out of the room: we can't know what it does now, and what we sent may or
    // may not have landed — a pick goes out again on reconnect.
    resetConnectionSync();
    if (pendingTarget) pendingTarget.sentAt = null;
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
    const present = new Set(participants.map((p) => p.id));
    usePresenceStore.getState().retain([...present]);
    for (const [peerCid, peer] of peers) if (!present.has(peer.userId)) peers.delete(peerCid);
    // Nobody else here: no one will answer our `hello`, so our content is the
    // room's. Taken at the settle, not now — see `onConnectSettle` — unless the
    // settle already passed (the others it waited on have since left).
    rosterSeen = true;
    const self = opts?.self.id;
    othersHere = participants.some((p) => p.id !== self);
    if (!othersHere) roomWasSolo = true;
    if (!synced && roomWasSolo && connectSettled) markSynced();
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
    //
    // Until that answer lands we may be stale, so nothing content-bearing goes
    // out (we'd revert what we missed) — unless nobody else is here to answer.
    // The lag may also have eaten our own echoes, so nothing of ours is still
    // known to be in flight.
    if (othersHere) synced = false;
    inflight = [];
    sendHello();
    if (currentFocus) sendFocus(currentFocus);
    return;
  }
  // Our own frame, relayed back: it — and everything we sent before it — has now
  // landed in the room's order, so it's no longer in flight.
  if (frame.cid === cid) {
    if (typeof frame.seq === "number") retireInflight(frame.seq);
    return;
  }
  if (type === "hello") {
    // A peer just joined — hand them our full current draft (a latecomer can't
    // replay patch history, so it needs the whole state). Not while we're unsynced
    // ourselves: we'd hand over the fresh-open default (or a stale copy), and every
    // peer adopts a full draft wholesale. Owe it instead — a synced peer answers
    // meanwhile, or we do once synced.
    const from = typeof frame.cid === "string" ? frame.cid : "";
    if (!synced) {
      if (from) owedHellos.add(from);
      return;
    }
    answerHello(from);
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
    // Remember who this connection is, so a whole-draft replace it sends later
    // can be attributed (draft frames carry only the `cid`).
    if (typeof frame.cid === "string") {
      peers.set(frame.cid, { userId, name: typeof frame.name === "string" ? frame.name : "" });
    }
    return;
  }
  // An answer addressed to another connection (`to`) carries the room's state for
  // a joiner. A synced peer already holds it, and adopting it could only revert
  // our edits still in flight — so it's for the addressee, or for us while we're
  // still syncing ourselves.
  const to = typeof frame.to === "string" ? frame.to : null;
  if (type === "draft" && frame.message && typeof frame.message === "object") {
    // A full draft reaches everyone it's broadcast to, so it answers every hello
    // still waiting on it — or just its addressee's.
    if (to) owedHellos.delete(to);
    else owedHellos.clear();
    if (to && to !== cid && synced) return;
    receiveDraft(
      frame.message as WebhookMessage,
      typeof frame.cid === "string" ? frame.cid : "",
      to,
    );
    return;
  }
  if (type === "resume" && frame.message && typeof frame.message === "object") {
    // The server replayed the persisted draft to us as the room's first member.
    // Load it only if we haven't diverged from our fresh-open baseline — a plain
    // reconnect already holds newer state and must ignore it. `applyFull` marks us
    // diverged, so a rapid second `resume` won't re-apply. Either way it means
    // nobody else is here to answer us: what we now hold is the room's, so held
    // offline edits go out (see `markSynced`).
    if (!diverged) applyFull(frame.message as WebhookMessage);
    markSynced();
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
    if (!opts?.guildId) return;
    if (to && to !== cid && synced) return;
    // Our own pick hasn't come back from the room yet, so this one was relayed
    // before it (or is a hello answer that never saw it) — already stale.
    if (pendingTarget && !targetGivenUp()) return;
    pendingTarget = null;
    currentTarget = frame.channelId;
    opts.onTarget?.(frame.channelId);
  }
}

/** Mark this connection synced with the room: answer the hellos we owed, send
 *  the edits we held back while we couldn't tell what the room holds, and — if
 *  the connect grace has passed — reveal the editor. */
function markSynced(): void {
  if (synced) return;
  synced = true;
  everSynced = true;
  for (const to of owedHellos) answerHello(to);
  owedHellos.clear();
  scheduleSync();
  if (graceElapsed) signalHydrated();
}

/** The connect settle (see `HYDRATE_GRACE_MS`): reveal the editor if we're synced
 *  by now, and — when the room was empty when we joined — count our own content
 *  as the room's. A room with others in it waits for their answer instead: the
 *  shell's own cap reveals the editor if that answer is slow, but nothing we hold
 *  goes out before it. */
function onConnectSettle(): void {
  settleTimer = null;
  connectSettled = true;
  graceElapsed = true;
  if (!synced && roomWasSolo) markSynced();
  else if (synced) signalHydrated();
  // No roster yet: the link is slow (the roster is always first). Its arrival
  // decides (see the roster handler); only if it never comes do we go it alone.
  if (!synced && !rosterSeen) settleTimer = setTimeout(onRosterOverdue, ROSTER_OVERDUE_MS);
}

/** No roster arrived at all — treat the room as ours rather than hold every edit
 *  back forever. */
function onRosterOverdue(): void {
  settleTimer = null;
  if (!synced && !rosterSeen) markSynced();
}

/** Forget everything this connection knew about the room — on connect, on a
 *  drop, and on teardown. */
function resetConnectionSync(): void {
  synced = false;
  rosterSeen = false;
  roomWasSolo = false;
  othersHere = false;
  connectSettled = false;
  owedHellos.clear();
  inflight = [];
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

/** Hand a joiner the room's state: our full draft, addressed to them, plus (on a
 *  server launch) the agreed destination and where we're editing, so our presence
 *  ring shows up for the newcomer straight away. */
function answerHello(to: string): void {
  send({ type: "draft", cid, message: useMessageStore.getState().message, ...(to ? { to } : {}) });
  if (opts?.guildId && currentTarget) {
    send({ type: "target", cid, channelId: currentTarget, ...(to ? { to } : {}) });
  }
  if (currentFocus) sendFocus(currentFocus);
}

/** Our frames still in flight, minus any whose echo we've given up on. */
function liveInflight(): InflightFrame[] {
  const now = Date.now();
  if (inflight.some((f) => now - f.at >= INFLIGHT_TTL_MS)) {
    inflight = inflight.filter((f) => now - f.at < INFLIGHT_TTL_MS);
  }
  return inflight;
}

/** Our frame `seq` echoed back: it and everything sent before it have landed. */
function retireInflight(seq: number): void {
  if (inflight.length) inflight = inflight.filter((f) => f.seq > seq);
  if (pendingTarget && pendingTarget.sentAt !== null && pendingTarget.seq <= seq) {
    pendingTarget = null;
  }
}

/** The ops of our in-flight patches, in the order we sent them. */
function inflightOps(frames: readonly InflightFrame[]): CollabOp[] {
  return frames.flatMap((f) => (f.kind === "patch" ? f.ops : []));
}

/** Put a pending destination pick on the wire, if one is waiting to go. */
function flushTarget(): void {
  if (!pendingTarget || pendingTarget.sentAt !== null) return;
  const seq = nextSeq++;
  if (send({ type: "target", cid, channelId: pendingTarget.channelId, seq })) {
    pendingTarget.seq = seq;
    pendingTarget.sentAt = Date.now();
  }
}

/** A sent pick whose echo never came back (a dropped frame) stops shielding us
 *  from peers' picks, or we'd never follow the room again. */
function targetGivenUp(): boolean {
  return (
    pendingTarget !== null &&
    pendingTarget.sentAt !== null &&
    Date.now() - pendingTarget.sentAt >= INFLIGHT_TTL_MS
  );
}

/** Tell the shell the room's initial content has settled, exactly once — the
 *  first time we take in a full draft (from `applyFull`) or, for a fresh room,
 *  when the connect settle finds nothing coming (and nobody else here). The
 *  one-shot latch keeps the paths from double-firing. */
function signalHydrated(): void {
  if (hydratedFired) return;
  hydratedFired = true;
  opts?.onHydrated?.();
}

/**
 * Take in a peer's full `draft`, and tell the shell when it replaced the whole
 * message out from under us (see `onPeerReplace`). The room's initial sync
 * never counts — a latecomer adopting the room's draft over its fresh-open
 * default replaced nothing anyone made — and neither does a draft we kept our
 * own structure over (`applyFull` adopted nothing). `to` is the connection the
 * draft answers, when its sender addressed it.
 */
function receiveDraft(message: WebhookMessage, senderCid: string, to: string | null): void {
  // A full draft of ours is still in flight: in the room's order it lands after
  // this one and replaces it wholesale for everyone — so for us too.
  if (liveInflight().some((f) => f.kind === "draft")) return;
  const fresh =
    pendingAnswer && Date.now() - pendingAnswer.at < ANSWER_WINDOW_MS ? pendingAnswer : null;
  // An addressed draft is an answer to a hello by definition (ours, or — taken
  // while we're still syncing — another joiner's, carrying the same room state);
  // an unaddressed one (an older client) only reads as one inside the window
  // after our own hello.
  const answer = to !== null ? (fresh ?? { at: Date.now(), afterHydration: hydratedFired }) : fresh;
  pendingAnswer = null;
  const wasHydrated = hydratedFired;
  const before = useMessageStore.getState().message;
  if (!applyFull(message)) return;
  if (answer ? !answer.afterHydration : !wasHydrated) return;
  const after = useMessageStore.getState().message;
  if (!isWholeDocumentReplace(before, after)) return;
  opts?.onPeerReplace?.({
    // An answer to our own `hello` comes from whichever peer replied first —
    // not necessarily whoever replaced the draft while we were away — so it's
    // left unnamed rather than pinned on the wrong person.
    actor: answer ? null : (peers.get(senderCid) ?? null),
    cleared: Array.isArray(after.components) && after.components.length === 0,
  });
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
 *  state verbatim, exactly as before. Returns whether the peer's message was
 *  written to the store (false when our own unbroadcast structure was kept).
 *
 *  Two refinements. Our in-flight patches were relayed after this draft (it
 *  arrived before their echo), so everyone else applies them on top of it — the
 *  baseline does too. And a connection that has never synced has no local work to
 *  keep: its edits were made on the fresh-open default, so the room's draft is
 *  adopted verbatim — merging them in (above all, keeping a "structural" change
 *  to the default) is how a joiner once wiped everyone's draft. */
function applyFull(message: WebhookMessage): boolean {
  const ours = useMessageStore.getState().message;
  const pending = !everSynced ? [] : lastSent ? diffMessage(lastSent, ours) : [];
  const base = applyOps(message, inflightOps(liveInflight()));

  // A top-level structural change we haven't broadcast can't be merged per node.
  // Don't drop it: keep our version and let the next sync re-broadcast it as a
  // full draft (last-write-wins wholesale — the documented tradeoff for a
  // structural conflict). Adopt the peer's frame only as the new baseline so the
  // diff recomputes against it.
  if (pending === null) {
    lastSent = base;
    diverged = true;
    markSynced();
    scheduleSync();
    // We received the room's draft (kept ours for a structural conflict, but the
    // initial sync is settled) — safe to reveal.
    signalHydrated();
    return false;
  }

  const next = pending.length > 0 ? applyOps(base, pending) : base;
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
  // Baseline is the room's state; any reapplied local ops remain a pending diff
  // against it, so the next sync re-broadcasts our surviving edits to the room.
  lastSent = base;
  // We now hold live room state; a later server `resume` must not revert us.
  diverged = true;
  markSynced();
  if (pending.length > 0) scheduleSync();
  return true;
}

/** Apply a peer's per-node ops, touching only the named nodes so a concurrent
 *  local edit elsewhere is preserved — in the room's relay order: a patch that
 *  arrives before the echo of one of ours was relayed before it, so ours applies
 *  on top (and an in-flight full draft of ours replaces it outright). */
function applyPatch(ops: CollabOp[]): void {
  const flight = liveInflight();
  // Our in-flight full draft lands after this patch and replaces the whole
  // message for everyone — so for us too.
  if (flight.some((f) => f.kind === "draft")) return;
  const replay = inflightOps(flight);
  const store = useMessageStore.getState().message;
  // Advance the baseline by the SAME ops (then ours, in relay order) rather than
  // reading the store: the store may also hold our own not-yet-broadcast edits,
  // which must remain a diff to send on the next sync.
  const base = lastSent ? applyOps(applyOps(lastSent, ops), replay) : null;
  const pending = lastSent ? diffMessage(lastSent, store) : null;
  // Rebase our unsent edits onto the new baseline, so newer typing in a node we
  // also had in flight is kept. A pending top-level change can't be rebased per
  // node; it goes out as a full draft on the next sync and settles everyone then.
  const next =
    base && pending !== null
      ? pending.length > 0
        ? applyOps(base, pending)
        : base
      : applyOps(store, ops);
  applyingRemote = true;
  try {
    useMessageStore.setState({ message: next });
  } finally {
    applyingRemote = false;
  }
  if (base) lastSent = base;
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
  // Until we know what the room holds, nothing goes out — a joiner's default, or a
  // reconnect's stale copy, would land on peers as their state. Held edits stay a
  // pending diff and go out when we sync (see `markSynced`).
  if (!synced) return;
  const current = useMessageStore.getState().message;
  const base = lastSent;
  // The baseline only advances when the frame actually goes on the wire (see
  // `send`). If the socket is down, `current` stays a pending diff against the
  // old baseline, so a reconnect re-broadcasts the whole accumulated change
  // instead of silently swallowing edits made while disconnected.
  if (!base) {
    if (sendDraft(current)) {
      lastSent = current;
      schedulePersist();
    }
    return;
  }
  const ops = diffMessage(base, current);
  if (ops === null) {
    // Replacing the whole message lands on everyone here, and peers name who did
    // it from the identity on `focus` frames — so send ours first. An existing
    // frame with its usual meaning (our selection, which the replace just
    // cleared), so peers on an older build handle it exactly as before.
    if (isWholeDocumentReplace(base, current)) sendFocus(currentFocus);
    if (sendDraft(current)) {
      lastSent = current;
      schedulePersist();
    }
    return;
  }
  if (ops.length === 0) return; // nothing semantic changed
  const seq = nextSeq++;
  if (send({ type: "patch", cid, ops, seq })) {
    inflight.push({ seq, at: Date.now(), kind: "patch", ops });
    lastSent = current;
    schedulePersist();
  }
}

/** Ask the room for its current draft (connect, reconnect, `resync`), noting
 *  that the next draft to arrive is most likely an answer (`pendingAnswer`). */
function sendHello(): void {
  if (send({ type: "hello", cid })) {
    pendingAnswer = { at: Date.now(), afterHydration: hydratedFired };
  }
}

/** Broadcast the whole message as a `draft` (tracked as in flight until its echo);
 *  returns whether it was sent. */
function sendDraft(message: WebhookMessage): boolean {
  const seq = nextSeq++;
  if (!send({ type: "draft", cid, message, seq })) return false;
  inflight.push({ seq, at: Date.now(), kind: "draft" });
  return true;
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

/** Emit the persistence snapshot now (reads the freshest message). Skipped while
 *  unsynced: what we hold then isn't known to be the room's, and the stored copy
 *  is what a relaunch resumes. The next sync after we re-sync schedules another. */
function sendPersistSnapshot(): void {
  snapshotTimer = null;
  if (!synced) return;
  lastSnapshotAt = Date.now();
  send({ type: "snapshot", cid, message: useMessageStore.getState().message });
}

/**
 * Flush what's still waiting on a timer — the debounced sync, then the throttled
 * persistence snapshot (which the sync may just have queued). The Activity is
 * closed by tearing its frame down, with no teardown call of ours, so without
 * this the last member's final few seconds of edits never reach the stored draft
 * a relaunch resumes.
 */
function flushOnExit(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (sendTimer) {
    clearTimeout(sendTimer);
    sendTimer = null;
    syncNow();
  }
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    sendPersistSnapshot();
  }
}

/** Flush on `pagehide`, and whenever the page is hidden — the last signals a
 *  closing (or backgrounded) Activity frame reliably gets. */
function listenForExit(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const win = window;
  const doc = document;
  if (typeof win.addEventListener !== "function" || typeof doc.addEventListener !== "function")
    return;
  const onPageHide = () => flushOnExit();
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") flushOnExit();
  };
  win.addEventListener("pagehide", onPageHide);
  doc.addEventListener("visibilitychange", onVisibility);
  exitListeners = () => {
    win.removeEventListener("pagehide", onPageHide);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
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
