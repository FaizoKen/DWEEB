/**
 * Assistant UI state.
 *
 * Holds the chat transcript and engine lifecycle status. The actual engine
 * handle lives in `engine.ts` (module scope, non-serializable); this store only
 * mirrors its status for rendering and drives the load → generate → apply flow.
 *
 * Each request is sent stateless except for a fresh snapshot of the current
 * editor message. The live message is the single source of truth, so "make it
 * blue" always operates on what the user currently sees rather than a drifting
 * chat history — which also keeps the prompt small enough for tiny local models.
 */

import { create } from "zustand";
import { newId } from "@/lib/id";
import { encodeJson } from "@/core/serialization";
import { useMessageStore } from "@/core/state/messageStore";
import type { ValidationIssue } from "@/core/schema/validation";
import { buildExampleTurns, buildSystemPrompt, buildUserTurn, type ChatTurn } from "./prompt";
import { generate, isModelCached, isWebGpuAvailable, loadEngine } from "./engine";
import { applyAiResponse } from "./applyResult";
import { loadModelChoice, saveModelChoice } from "./models";

export type EngineStatus = "unloaded" | "loading" | "ready" | "error";

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Assistant-only: validation issues surfaced after applying. */
  issues?: ValidationIssue[];
  /** Marks an assistant turn that failed (parse/generation error). */
  failed?: boolean;
}

interface AiState {
  modelId: string;
  status: EngineStatus;
  progressRatio?: number;
  progressText: string;
  cached: boolean;
  error: string | null;
  generating: boolean;
  messages: AiMessage[];

  setModel(id: string): void;
  refreshCache(): Promise<void>;
  load(): Promise<void>;
  send(instruction: string): Promise<void>;
  clearChat(): void;
}

export const useAiStore = create<AiState>((set, get) => ({
  modelId: loadModelChoice(),
  status: "unloaded",
  progressText: "",
  cached: false,
  error: null,
  generating: false,
  messages: [],

  setModel(id) {
    saveModelChoice(id);
    // Changing the model invalidates the loaded engine; force a reload.
    set({
      modelId: id,
      status: "unloaded",
      error: null,
      progressRatio: undefined,
      progressText: "",
    });
    void get().refreshCache();
  },

  async refreshCache() {
    if (!isWebGpuAvailable()) return;
    const cached = await isModelCached(get().modelId);
    set({ cached });
  },

  async load() {
    if (get().status === "loading") return;
    set({ status: "loading", error: null, progressRatio: undefined, progressText: "Starting…" });
    try {
      await loadEngine(get().modelId, (p) => {
        set({ progressRatio: p.ratio, progressText: p.text });
      });
      set({ status: "ready", progressText: "", cached: true });
    } catch (e) {
      set({ status: "error", error: (e as Error).message });
    }
  },

  async send(instruction) {
    const text = instruction.trim();
    if (!text || get().generating) return;

    // Auto-load on first send so the user can just type and go.
    if (get().status !== "ready") {
      await get().load();
      if (get().status !== "ready") return;
    }

    const userMsg: AiMessage = { id: newId(), role: "user", text };
    set((s) => ({ messages: [...s.messages, userMsg], generating: true }));

    try {
      const currentJson = encodeJson(useMessageStore.getState().message);
      const turns: ChatTurn[] = [
        { role: "system", content: buildSystemPrompt() },
        ...buildExampleTurns(),
        { role: "user", content: buildUserTurn(currentJson, text) },
      ];

      const raw = await generate(turns);
      const result = applyAiResponse(raw);

      const reply: AiMessage = result.ok
        ? { id: newId(), role: "assistant", text: result.note, issues: result.issues }
        : { id: newId(), role: "assistant", text: result.error, failed: true };
      set((s) => ({ messages: [...s.messages, reply], generating: false }));
    } catch (e) {
      const reply: AiMessage = {
        id: newId(),
        role: "assistant",
        text: `Something went wrong: ${(e as Error).message}`,
        failed: true,
      };
      set((s) => ({ messages: [...s.messages, reply], generating: false }));
    }
  },

  clearChat() {
    set({ messages: [] });
  },
}));

export const isAiSupported = isWebGpuAvailable;
