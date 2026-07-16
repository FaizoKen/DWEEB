/**
 * Behavioral contract for the AI assistant's send orchestration.
 *
 * These tests drive the real store (real system prompt, reply parsing,
 * normalization, and validation) with only the network adapter mocked. They
 * pin the fixes for the "assistant says it changed the message but nothing
 * happened" class of failure:
 *
 *  - provider history carries the RAW replies (JSON fences included), so
 *    follow-ups like "do it" can see what the model previously produced;
 *  - a reply that ANNOUNCES an edit without a payload triggers one recovery
 *    turn (with a NO_CHANGE escape), and an unrecovered announcement is
 *    surfaced honestly as `failedEdit` instead of masquerading as applied;
 *  - the validation self-repair turn adopts fixed payloads.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return { ...actual, callAI: vi.fn() };
});

import { callAI, type AiTurn } from "./providers";
import { useAiStore } from "./aiStore";
import { useMessageStore } from "@/core/state/messageStore";

const mockedCallAI = vi.mocked(callAI);

const FENCE = (json: string) => "```json\n" + json + "\n```";
const PAYLOAD = (marker: string) => `{"components":[{"type":10,"content":"${marker}"}]}`;

/** Queue one reply; streams the whole text as a single token when asked to. */
function queueReply(text: string) {
  mockedCallAI.mockImplementationOnce(async (_settings, _system, _turns, _signal, onToken) => {
    onToken?.(text);
    return { ok: true, text };
  });
}

function lastAssistantBubble() {
  const messages = useAiStore.getState().messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") throw new Error("no assistant bubble");
  return last;
}

function editorText(): string {
  return JSON.stringify(useMessageStore.getState().message);
}

/** The turns array handed to the Nth (1-indexed) callAI invocation. */
function turnsOfCall(n: number): AiTurn[] {
  const call = mockedCallAI.mock.calls[n - 1];
  if (!call) throw new Error(`callAI was not called ${n} times`);
  return call[2];
}

beforeEach(() => {
  mockedCallAI.mockReset();
  // Configures a key (send() refuses without one) and clears the transcript.
  useAiStore.getState().setSettings({
    provider: "openai",
    apiKey: "sk-test",
    model: "test-model",
    baseUrl: "",
  });
});

describe("aiStore.send — applying edits", () => {
  it("applies a fenced payload and keeps the raw reply as provider history", async () => {
    queueReply(`Sure!\n${FENCE(PAYLOAD("AI EDIT ONE"))}`);
    await useAiStore.getState().send("make it simpler");

    expect(editorText()).toContain("AI EDIT ONE");
    const bubble = lastAssistantBubble();
    expect(bubble.appliedMessage).toBe(true);
    expect(bubble.failedEdit).toBeFalsy();
    expect(bubble.content).toBe("Sure!");
    // Display prose is stripped, but the raw reply keeps the fence…
    expect(bubble.raw).toContain('"AI EDIT ONE"');

    // …and the NEXT turn sends that raw reply back to the provider, so the
    // model can still see the JSON it produced.
    queueReply("It now has a single text block.");
    await useAiStore.getState().send("what did you change?");
    const turns = turnsOfCall(2);
    const assistantTurn = turns.find((t) => t.role === "assistant");
    expect(assistantTurn?.content).toContain('"AI EDIT ONE"');
  });
});

describe("aiStore.send — announced edit without a payload", () => {
  it("recovers via one nudge turn and applies the late payload", async () => {
    queueReply("Sure thing! Here's a streamlined version with just the essentials.");
    queueReply(FENCE(PAYLOAD("AI EDIT TWO")));
    await useAiStore.getState().send("make current message more simple");

    expect(mockedCallAI).toHaveBeenCalledTimes(2);
    // The recovery turn shows the model its own paylodless reply + the demand.
    const nudgeTurns = turnsOfCall(2);
    expect(nudgeTurns[nudgeTurns.length - 1]?.content).toContain("did not include");

    expect(editorText()).toContain("AI EDIT TWO");
    const bubble = lastAssistantBubble();
    expect(bubble.appliedMessage).toBe(true);
    expect(bubble.failedEdit).toBeFalsy();
    // The user still sees the original conversational prose, not the nudge.
    expect(bubble.content).toContain("streamlined version");
    // History carries the reply that actually held the payload.
    expect(bubble.raw).toContain('"AI EDIT TWO"');
  });

  it("accepts NO_CHANGE from the nudge without flagging a failure", async () => {
    const before = editorText();
    queueReply("Here's a pared-down version that keeps the key info.");
    queueReply("NO_CHANGE");
    await useAiStore.getState().send("hmm");

    expect(editorText()).toBe(before);
    const bubble = lastAssistantBubble();
    expect(bubble.appliedMessage).toBeFalsy();
    expect(bubble.failedEdit).toBeFalsy();
  });

  it("flags failedEdit when the nudge still produces no payload", async () => {
    const before = editorText();
    queueReply("Sure! Here's a streamlined version with just the essentials.");
    queueReply("Sure! Here's a pared-down version that keeps the key info.");
    await useAiStore.getState().send("make current message more simple");

    expect(editorText()).toBe(before);
    const bubble = lastAssistantBubble();
    expect(bubble.appliedMessage).toBeFalsy();
    expect(bubble.failedEdit).toBe(true);
  });

  it("does not nudge plain Q&A replies", async () => {
    queueReply("A container groups children behind a colored accent stripe.");
    await useAiStore.getState().send("what is a container?");

    expect(mockedCallAI).toHaveBeenCalledTimes(1);
    const bubble = lastAssistantBubble();
    expect(bubble.appliedMessage).toBeFalsy();
    expect(bubble.failedEdit).toBeFalsy();
    expect(bubble.content).toContain("accent stripe");
  });
});

describe("aiStore.send — validation self-repair", () => {
  it("adopts the repaired payload when the first one fails validation", async () => {
    // `components: []` imports fine but validates with an EMPTY_MESSAGE error.
    queueReply(`Updated!\n${FENCE('{"components":[]}')}`);
    queueReply(FENCE(PAYLOAD("AI EDIT THREE")));
    await useAiStore.getState().send("rebuild it");

    expect(mockedCallAI).toHaveBeenCalledTimes(2);
    const repairTurns = turnsOfCall(2);
    expect(repairTurns[repairTurns.length - 1]?.content).toContain("Discord reject");

    expect(editorText()).toContain("AI EDIT THREE");
    const bubble = lastAssistantBubble();
    expect(bubble.appliedMessage).toBe(true);
    expect(bubble.failedEdit).toBeFalsy();
    expect(bubble.raw).toContain('"AI EDIT THREE"');
  });
});
