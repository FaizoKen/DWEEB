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
import { startCollab, stopCollab, type PeerReplace } from "./collab";

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
