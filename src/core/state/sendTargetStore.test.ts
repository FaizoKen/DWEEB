import { beforeEach, describe, expect, it } from "vitest";
import { useSendTargetStore } from "./sendTargetStore";

const G = "111111111111111111";
const A = "222222222222222222";
const B = "333333333333333333";
const POST = { id: "444444444444444444", name: "Bug reports" };

const state = () => useSendTargetStore.getState();

describe("sendTargetStore", () => {
  beforeEach(() => {
    useSendTargetStore.setState({ guildId: null, channelId: null, thread: null });
  });

  it("narrows the picked channel to a thread", () => {
    state().setSendTarget(G, A);
    state().setSendThread(POST);
    expect(state()).toMatchObject({ guildId: G, channelId: A, thread: POST });
  });

  it("keeps the thread while the channel is re-picked unchanged", () => {
    state().setSendTarget(G, A, POST);
    state().setSendTarget(G, A);
    expect(state().thread).toEqual(POST);
  });

  it("never carries a thread to another channel", () => {
    state().setSendTarget(G, A, POST);
    state().setSendTarget(G, B);
    expect(state()).toMatchObject({ channelId: B, thread: null });
  });

  it("an explicit null clears the thread on the same channel", () => {
    state().setSendTarget(G, A, POST);
    state().setSendTarget(G, A, null);
    expect(state().thread).toBeNull();
  });

  it("ignores a thread with no channel picked", () => {
    state().setSendThread(POST);
    expect(state().thread).toBeNull();
  });
});
