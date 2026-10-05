/**
 * Collab's side of "someone replaced the whole draft": over a fake room socket,
 * an incoming full draft that shares no node with ours is reported — naming the
 * sender when their connection has identified itself — while the room's
 * initial sync, ordinary structural edits, and a reconnect's answers never
 * misattribute it. The sending side announces who it is (a `focus` frame, the
 * existing identity carrier) right before a whole-draft replace, so nothing new
 * rides the wire.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";

vi.mock("./api", () => ({ mintRoomTicket: vi.fn(async () => "ticket") }));

import { useMessageStore } from "@/core/state/messageStore";
import { applyOps } from "./collabPatch";
import {
  broadcastTarget,
  isRoomSynced,
  startCollab,
  stopCollab,
  type CollabParticipant,
  type PeerReplace,
} from "./collab";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  /** The server accepted the connection. */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** A frame relayed from the room. */
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The connection dropped. */
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

const text = (id: string, content = "Hello") => ({
  _id: id,
  type: ComponentType.TextDisplay,
  content,
});
const doc = (...ids: string[]): WebhookMessage =>
  ({ components: ids.map((id) => text(id)) }) as unknown as WebhookMessage;

const ANA = { userId: "ana", name: "Ana" };

let onPeerReplace: Mock<(replace: PeerReplace) => void>;

/** Join a room holding `local`, and let a peer ("p1") answer our hello with
 *  the room's draft — the initial sync. Returns the live socket. */
async function joinRoom(local: WebhookMessage, room: WebhookMessage): Promise<FakeSocket> {
  useMessageStore.setState({ message: local, selectedId: null });
  startCollab({
    instanceId: "inst",
    guildId: "guild",
    self: { id: "me", name: "Faiz", avatar: null },
    targetChannelId: "chan",
    onRoster: () => {},
    onPeerReplace,
  });
  await vi.advanceTimersByTimeAsync(0); // the room ticket resolves
  const ws = FakeSocket.instances.at(-1)!;
  ws.open();
  ws.receive({ type: "draft", cid: "p1", message: room });
  return ws;
}

describe("collab: whole-draft replaces", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.instances = [];
    onPeerReplace = vi.fn<(replace: PeerReplace) => void>();
  });
  afterEach(() => {
    stopCollab();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("never reports the room's initial sync as a replace", async () => {
    await joinRoom(doc("mine-1", "mine-2"), doc("room-1"));
    expect(useMessageStore.getState().message.components.map((c) => c._id)).toEqual(["room-1"]);
    expect(onPeerReplace).not.toHaveBeenCalled();
  });

  it("treats a slow first answer — after the reveal grace — as the initial sync too", async () => {
    useMessageStore.setState({ message: doc("mine-1"), selectedId: null });
    startCollab({
      instanceId: "inst",
      guildId: "guild",
      self: { id: "me", name: "Faiz", avatar: null },
      targetChannelId: "chan",
      onRoster: () => {},
      onPeerReplace,
    });
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeSocket.instances.at(-1)!;
    ws.open();
    await vi.advanceTimersByTimeAsync(3_000); // the editor was revealed meanwhile
    ws.receive({ type: "draft", cid: "p1", message: doc("room-1") });
    expect(onPeerReplace).not.toHaveBeenCalled();
  });

  it("names the peer who replaced the draft, from their focus frame", async () => {
    const ws = await joinRoom(doc("x"), doc("room-1", "room-2"));
    ws.receive({ type: "focus", cid: "p1", ...ANA, avatar: null, nodeId: null });
    ws.receive({ type: "draft", cid: "p1", message: doc("new-1") });
    expect(onPeerReplace).toHaveBeenCalledTimes(1);
    expect(onPeerReplace).toHaveBeenCalledWith({ actor: ANA, cleared: false });
  });

  it("reports a cleared draft as cleared", async () => {
    const ws = await joinRoom(doc("x"), doc("room-1"));
    ws.receive({ type: "focus", cid: "p1", ...ANA, avatar: null, nodeId: null });
    ws.receive({ type: "draft", cid: "p1", message: { components: [] } });
    expect(onPeerReplace).toHaveBeenCalledWith({ actor: ANA, cleared: true });
  });

  it("leaves a replace unnamed when the sender never identified itself", async () => {
    const ws = await joinRoom(doc("x"), doc("room-1"));
    ws.receive({ type: "draft", cid: "p2", message: doc("new-1") });
    expect(onPeerReplace).toHaveBeenCalledWith({ actor: null, cleared: false });
  });

  it("ignores ordinary structural edits", async () => {
    const ws = await joinRoom(doc("x"), doc("room-1", "room-2"));
    ws.receive({ type: "focus", cid: "p1", ...ANA, avatar: null, nodeId: null });
    ws.receive({ type: "draft", cid: "p1", message: doc("room-2", "room-1") }); // reorder
    ws.receive({ type: "draft", cid: "p1", message: doc("room-2", "room-1", "room-3") }); // add
    ws.receive({ type: "draft", cid: "p1", message: doc("room-3") }); // remove
    expect(onPeerReplace).not.toHaveBeenCalled();
  });

  it("doesn't pin a replace that happened while we were away on whoever answers", async () => {
    const ws = await joinRoom(doc("x"), doc("room-1"));
    ws.receive({ type: "focus", cid: "p1", ...ANA, avatar: null, nodeId: null });
    ws.drop();
    await vi.advanceTimersByTimeAsync(20_000); // backoff, then a fresh ticket
    const again = FakeSocket.instances.at(-1)!;
    expect(again).not.toBe(ws);
    again.open();
    // Ana answers our hello with a draft someone replaced while we were gone.
    again.receive({ type: "draft", cid: "p1", message: doc("new-1") });
    expect(onPeerReplace).toHaveBeenCalledWith({ actor: null, cleared: false });
  });

  it("announces who we are right before sending a whole-draft replace", async () => {
    const ws = await joinRoom(doc("x"), doc("room-1"));
    ws.sent = [];
    useMessageStore.getState().replaceMessage(doc("template-1", "template-2"));
    await vi.advanceTimersByTimeAsync(500); // the send debounce
    const types = ws.sent.map((f) => f.type);
    const draftAt = types.indexOf("draft");
    expect(draftAt).toBeGreaterThan(0);
    expect(ws.sent[draftAt - 1]).toMatchObject({ type: "focus", userId: "me", name: "Faiz" });
  });

  it("sends a structural edit without the extra identity frame", async () => {
    const ws = await joinRoom(doc("x"), doc("room-1"));
    ws.sent = [];
    const current = useMessageStore.getState().message;
    useMessageStore.setState({
      message: { ...current, components: [...current.components, text("added")] },
    } as never);
    await vi.advanceTimersByTimeAsync(500);
    // (A persistence `snapshot` may follow; it never reaches peers.)
    expect(ws.sent.map((f) => f.type).filter((t) => t !== "snapshot")).toEqual(["draft"]);
  });
});

// ── Syncing before speaking, relay order, and coming back ─────────────────────

const node = (id: string, content: string) => ({
  _id: id,
  type: ComponentType.TextDisplay,
  content,
});
const docOf = (...nodes: Array<ReturnType<typeof node>>): WebhookMessage =>
  ({ components: nodes }) as unknown as WebhookMessage;
/** The message as content, so copies that crossed the JSON boundary compare equal. */
const content = (m: WebhookMessage) => JSON.stringify(m);

const ME: CollabParticipant = { id: "me", name: "Faiz", avatar: null };
const ANA_P: CollabParticipant = { id: "ana", name: "Ana", avatar: null };

let onHydrated: Mock<() => void>;
let onTarget: Mock<(channelId: string) => void>;

/** Open a room socket holding `local`, without any room traffic yet. */
async function connectTo(local: WebhookMessage): Promise<FakeSocket> {
  useMessageStore.setState({ message: local, selectedId: null });
  startCollab({
    instanceId: "inst",
    guildId: "guild",
    self: { id: "me", name: "Faiz", avatar: null },
    targetChannelId: "chan-1",
    onRoster: () => {},
    onHydrated,
    onTarget,
    onPeerReplace,
  });
  await vi.advanceTimersByTimeAsync(0); // the room ticket resolves
  const ws = FakeSocket.instances.at(-1)!;
  ws.open();
  return ws;
}

/** Our connection id, read off the `hello` we open with. */
const ourCid = (ws: FakeSocket) => ws.sent.find((f) => f.type === "hello")!.cid as string;
const contentFrames = (ws: FakeSocket) =>
  ws.sent.filter((f) => f.type === "draft" || f.type === "patch" || f.type === "snapshot");
const mentions = (ws: FakeSocket, needle: string) =>
  ws.sent.filter((f) => JSON.stringify(f).includes(needle));

function useFakeRoom() {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.instances = [];
    onHydrated = vi.fn<() => void>();
    onTarget = vi.fn<(channelId: string) => void>();
    onPeerReplace = vi.fn<(replace: PeerReplace) => void>();
  });
  afterEach(() => {
    stopCollab();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
}

describe("collab: nothing goes out before we know what the room holds", () => {
  useFakeRoom();

  it("a joiner doesn't answer another joiner's hello with its fresh-open default", async () => {
    const ws = await connectTo(docOf(node("d1", "FRESH-OPEN-DEFAULT")));
    ws.receive({ type: "roster", participants: [ME, ANA_P] });
    ws.receive({ type: "hello", cid: "joiner-2" });
    expect(contentFrames(ws)).toEqual([]);
    // Ana's answer reaches every joiner — so ours is no longer owed either.
    ws.receive({ type: "draft", cid: "ana", message: docOf(node("w1", "Room work")) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.sent.filter((f) => f.type === "draft")).toEqual([]);
  });

  it("answers a hello it owed once the room turns out to be its own — addressed to the joiner", async () => {
    const ws = await connectTo(docOf(node("a1", "Our draft")));
    ws.receive({ type: "roster", participants: [ME] });
    // Someone joins inside the settle, before we count our content as the room's.
    ws.receive({ type: "hello", cid: "joiner-2" });
    expect(contentFrames(ws)).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    const answers = ws.sent.filter((f) => f.type === "draft");
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ to: "joiner-2" });
    expect(content(answers[0]!.message as WebhookMessage)).toContain("Our draft");
  });

  it("doesn't reveal the default while others are here — their draft does", async () => {
    const ws = await connectTo(docOf(node("d1", "FRESH-OPEN-DEFAULT")));
    ws.receive({ type: "roster", participants: [ME, ANA_P] });
    await vi.advanceTimersByTimeAsync(1500);
    expect(onHydrated).not.toHaveBeenCalled();
    ws.receive({ type: "draft", cid: "ana", message: docOf(node("w1", "Room work")) });
    expect(onHydrated).toHaveBeenCalledTimes(1);
  });

  it("waits for a late roster instead of guessing the room is empty", async () => {
    const ws = await connectTo(docOf(node("d1", "FRESH-OPEN-DEFAULT")));
    // A slow link: the settle passes before the roster arrives.
    await vi.advanceTimersByTimeAsync(1000);
    expect(isRoomSynced()).toBe(false);
    ws.receive({ type: "roster", participants: [ME, ANA_P] });
    ws.receive({ type: "hello", cid: "joiner-2" });
    await vi.advanceTimersByTimeAsync(6000);
    expect(isRoomSynced()).toBe(false);
    expect(contentFrames(ws)).toEqual([]);
  });

  it("reveals a room it found empty at the grace", async () => {
    const ws = await connectTo(docOf(node("a1", "Our draft")));
    ws.receive({ type: "roster", participants: [ME] });
    await vi.advanceTimersByTimeAsync(800);
    expect(onHydrated).toHaveBeenCalledTimes(1);
    expect(isRoomSynced()).toBe(true);
  });

  it("never sends a never-synced joiner's edits, and adopts the room's draft over them", async () => {
    const ws = await connectTo(docOf(node("d1", "DEFAULT-1"), node("d2", "DEFAULT-2")));
    ws.receive({ type: "roster", participants: [ME, ANA_P] });
    expect(isRoomSynced()).toBe(false);
    // The shell's own cap reveals the editor; the joiner tidies the sample.
    await vi.advanceTimersByTimeAsync(4000);
    useMessageStore.setState({ message: docOf(node("d1", "DEFAULT-1")) });
    await vi.advanceTimersByTimeAsync(500);
    expect(contentFrames(ws)).toEqual([]);
    // The room's draft wins outright — the edit to the default is not kept and
    // re-broadcast over everyone's work.
    const room = docOf(node("w1", "Room work"), node("w2", "More work"));
    ws.receive({ type: "draft", cid: "ana", message: room });
    await vi.advanceTimersByTimeAsync(1000);
    expect(content(useMessageStore.getState().message)).toBe(content(room));
    expect(ws.sent.filter((f) => f.type === "draft" || f.type === "patch")).toEqual([]);
  });

  it("a synced peer ignores a hello answer meant for someone else", async () => {
    const ws = await connectTo(docOf(node("t1", "Hello")));
    ws.receive({ type: "draft", cid: "ana", message: docOf(node("t1", "Hello")) });
    ws.receive({ type: "draft", cid: "bo", to: "joiner-3", message: docOf(node("x1", "Other")) });
    expect(content(useMessageStore.getState().message)).toContain("Hello");
    expect(content(useMessageStore.getState().message)).not.toContain("Other");
  });

  it("takes an answer addressed to it as the initial sync — never a notice", async () => {
    const ws = await connectTo(docOf(node("d1", "DEFAULT")));
    ws.receive({ type: "roster", participants: [ME, ANA_P] });
    ws.receive({ type: "focus", cid: "ana", ...ANA, avatar: null, nodeId: null });
    ws.receive({
      type: "draft",
      cid: "ana",
      to: ourCid(ws),
      message: docOf(node("w1", "Room work")),
    });
    expect(content(useMessageStore.getState().message)).toContain("Room work");
    expect(onPeerReplace).not.toHaveBeenCalled();
    expect(isRoomSynced()).toBe(true);
  });
});

describe("collab: frames apply in the room's relay order, ours included", () => {
  useFakeRoom();

  /** In sync with Ana on one block, then our edit's patch on the wire (no echo yet). */
  async function typedAndSent(text: string) {
    const ws = await connectTo(docOf(node("t1", "Hello")));
    ws.receive({ type: "draft", cid: "ana", message: docOf(node("t1", "Hello")) });
    await vi.advanceTimersByTimeAsync(1000);
    useMessageStore.setState({ message: docOf(node("t1", text)) });
    await vi.advanceTimersByTimeAsync(300);
    const ours = ws.sent.filter((f) => f.type === "patch").at(-1)!;
    return { ws, ours };
  }
  const anasPatch = (text: string) => ({
    type: "patch",
    cid: "ana",
    ops: [{ op: "node", id: "t1", data: node("t1", text) }],
  });

  it("two people typing in one block both end on the one the server relayed last", async () => {
    // Ana's patch reached us before our own echo, so it was relayed first: ours wins.
    const { ws, ours } = await typedAndSent("Hello from ME");
    ws.receive(anasPatch("Hello from ANA"));
    ws.receive({ ...ours });
    expect(content(useMessageStore.getState().message)).toContain("Hello from ME");
  });

  it("lets a peer patch relayed after our echo win", async () => {
    const { ws, ours } = await typedAndSent("Hello from ME");
    ws.receive({ ...ours });
    ws.receive(anasPatch("Hello from ANA"));
    expect(content(useMessageStore.getState().message)).toContain("Hello from ANA");
  });

  it("keeps our in-flight patch on top of a peer's full draft relayed before it", async () => {
    const { ws, ours } = await typedAndSent("Hello X");
    const anas = docOf(node("t1", "Hello"), node("t2", "New block"));
    ws.receive({ type: "draft", cid: "ana", message: anas });
    ws.receive({ ...ours });
    expect(content(useMessageStore.getState().message)).toBe(
      content(applyOps(anas, ours.ops as never)),
    );
  });

  it("keeps newer typing in a block whose earlier patch was overtaken", async () => {
    const { ws } = await typedAndSent("Hello from ME");
    // Still typing — not yet sent.
    useMessageStore.setState({ message: docOf(node("t1", "Hello from ME!!")) });
    ws.receive(anasPatch("Hello from ANA"));
    expect(content(useMessageStore.getState().message)).toContain("Hello from ME!!");
    await vi.advanceTimersByTimeAsync(300);
    const last = ws.sent.filter((f) => f.type === "patch").at(-1)!;
    expect(JSON.stringify(last.ops)).toContain("Hello from ME!!");
  });

  it("lets our in-flight full draft supersede a peer patch relayed before it", async () => {
    const ws = await connectTo(docOf(node("t1", "Hello")));
    ws.receive({ type: "draft", cid: "ana", message: docOf(node("t1", "Hello")) });
    await vi.advanceTimersByTimeAsync(1000);
    // A top-level change goes out as a full draft.
    useMessageStore.setState({ message: docOf(node("t1", "Hello"), node("t9", "Added")) });
    await vi.advanceTimersByTimeAsync(300);
    const ourDraft = ws.sent.filter((f) => f.type === "draft").at(-1)!;
    ws.receive(anasPatch("Hello from ANA"));
    ws.receive({ ...ourDraft });
    // Everyone else adopts our draft after Ana's patch — so do we.
    expect(content(useMessageStore.getState().message)).not.toContain("Hello from ANA");
  });

  it("stops replaying a frame whose echo never came back", async () => {
    const { ws } = await typedAndSent("Hello from ME");
    // The echo is lost (an oversized frame the server dropped, a lagged socket).
    await vi.advanceTimersByTimeAsync(11_000);
    ws.receive(anasPatch("Hello from ANA"));
    expect(content(useMessageStore.getState().message)).toContain("Hello from ANA");
  });
});

describe("collab: leaving and coming back", () => {
  useFakeRoom();

  async function droppedAfterEditing(edit: string) {
    const ws = await connectTo(docOf(node("a", "v1")));
    ws.receive({ type: "roster", participants: [ME] });
    await vi.advanceTimersByTimeAsync(1000);
    ws.drop();
    useMessageStore.setState({ message: docOf(node("a", edit)) });
    await vi.advanceTimersByTimeAsync(500); // the send fails against the dead socket
    await vi.advanceTimersByTimeAsync(20_000); // backoff → fresh ticket → new socket
    const again = FakeSocket.instances.at(-1)!;
    expect(again).not.toBe(ws);
    again.open();
    return again;
  }

  it("sends offline edits once a solo reconnect learns it's the room's first member", async () => {
    const again = await droppedAfterEditing("OFFLINE-EDIT");
    // We ignore the stale persisted copy (we've diverged) — but it tells us
    // nobody else is here, so what we hold goes out.
    again.receive({ type: "resume", message: docOf(node("a", "v1")) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mentions(again, "OFFLINE-EDIT").some((f) => f.type === "patch")).toBe(true);
    expect(mentions(again, "OFFLINE-EDIT").some((f) => f.type === "snapshot")).toBe(true);
  });

  it("sends them too without a persisted copy, once the room turns out empty", async () => {
    const again = await droppedAfterEditing("OFFLINE-EDIT");
    again.receive({ type: "roster", participants: [ME] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mentions(again, "OFFLINE-EDIT").some((f) => f.type === "patch")).toBe(true);
  });

  it("merges offline edits over a peer's answer instead of sending them blind", async () => {
    const again = await droppedAfterEditing("OFFLINE-EDIT");
    again.receive({ type: "roster", participants: [ME, ANA_P] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mentions(again, "OFFLINE-EDIT")).toEqual([]);
    again.receive({
      type: "draft",
      cid: "ana",
      to: ourCid(again),
      message: docOf(node("a", "v1"), node("b", "Ana's block")),
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(content(useMessageStore.getState().message)).toContain("Ana's block");
    expect(content(useMessageStore.getState().message)).toContain("OFFLINE-EDIT");
    expect(mentions(again, "OFFLINE-EDIT").some((f) => f.type === "patch")).toBe(true);
  });

  it("flushes the pending sync and snapshot when the Activity is closed", async () => {
    const win = new EventTarget();
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", page);
    const ws = await connectTo(docOf(node("a", "v1")));
    ws.receive({ type: "roster", participants: [ME] });
    await vi.advanceTimersByTimeAsync(10_000);
    useMessageStore.setState({ message: docOf(node("a", "typing…")) });
    await vi.advanceTimersByTimeAsync(300); // persisted at once (a quiet spell)
    useMessageStore.setState({ message: docOf(node("a", "FINAL-WORDS")) });
    // Inside both the send debounce and the snapshot throttle window.
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(mentions(ws, "FINAL-WORDS").map((f) => f.type)).toEqual(["patch", "snapshot"]);
    // The listeners go with the session.
    stopCollab();
    const before = ws.sent.length;
    win.dispatchEvent(new Event("pagehide"));
    expect(ws.sent.length).toBe(before);
  });

  it("sends a channel picked while offline on reconnect, and a stale answer doesn't move it back", async () => {
    const ws = await connectTo(docOf(node("t1", "Hi")));
    ws.receive({ type: "draft", cid: "ana", message: docOf(node("t1", "Hi")) });
    ws.drop();
    broadcastTarget("chan-2");
    await vi.advanceTimersByTimeAsync(20_000);
    const again = FakeSocket.instances.at(-1)!;
    again.open();
    const pick = again.sent.find((f) => f.type === "target");
    expect(pick).toMatchObject({ channelId: "chan-2" });
    // Ana's answer still names the old channel — relayed before our pick.
    again.receive({ type: "target", cid: "ana", channelId: "chan-1" });
    expect(onTarget).not.toHaveBeenCalled();
    // Once our pick comes back from the room, peers' picks apply again.
    again.receive({ ...pick });
    again.receive({ type: "target", cid: "ana", channelId: "chan-3" });
    expect(onTarget).toHaveBeenCalledWith("chan-3");
  });

  it("reports an unsynced session to the replace confirm, and none outside a session", async () => {
    expect(isRoomSynced()).toBe(true); // not started
    const ws = await connectTo(docOf(node("t1", "Hi")));
    ws.receive({ type: "roster", participants: [ME, ANA_P] });
    expect(isRoomSynced()).toBe(false);
    ws.receive({ type: "draft", cid: "ana", message: docOf(node("t1", "Hi")) });
    expect(isRoomSynced()).toBe(true);
    ws.drop();
    expect(isRoomSynced()).toBe(false);
  });
});
