/**
 * AI assistant store.
 *
 * Owns the chat panel's open state, the persisted provider settings, the in
 * memory transcript, and the send orchestration. Edits the model proposes are
 * funneled through the same import path as everything else
 * (`attachEditorFields` → validate → `replaceMessage`) so a generated message
 * is indistinguishable from a pasted one.
 *
 * The transcript is intentionally NOT persisted — it can grow large and may
 * contain content the user would not expect to survive a reload. Settings
 * (including the API key) persist via `settingsStorage`.
 */

import { create } from "zustand";
import { newId } from "@/lib/id";
import { useMessageStore } from "@/core/state/messageStore";
import { attachEditorFields } from "@/core/serialization/normalize";
import { validateMessage } from "@/core/schema/validation";
import type { AiSettings, ChatMessage } from "./types";
import { callAI, toTurns } from "./providers";
import { buildSystemPrompt } from "./systemPrompt";
import { extractReply } from "./extractReply";
import { loadAiSettings, saveAiSettings } from "./settingsStorage";

interface AiState {
  open: boolean;
  settings: AiSettings;
  messages: ChatMessage[];
  /** True while a provider request is in flight. */
  thinking: boolean;
  /** Last error surfaced to the user (cleared on the next send). */
  error: string | null;

  openPanel(): void;
  closePanel(): void;
  togglePanel(): void;

  setSettings(next: AiSettings): void;
  /** True once a key is present — gates the composer behind the settings form. */
  isConfigured(): boolean;

  send(prompt: string): Promise<void>;
  cancel(): void;
  clearChat(): void;
}

let inflight: AbortController | null = null;

function appendMessage(messages: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  return [...messages, msg];
}

export const useAiStore = create<AiState>((set, get) => ({
  open: false,
  settings: loadAiSettings(),
  messages: [],
  thinking: false,
  error: null,

  openPanel() {
    set({ open: true });
  },
  closePanel() {
    set({ open: false });
  },
  togglePanel() {
    set((s) => ({ open: !s.open }));
  },

  setSettings(next) {
    saveAiSettings(next);
    set({ settings: next });
  },

  isConfigured() {
    return get().settings.apiKey.trim().length > 0;
  },

  async send(prompt) {
    const text = prompt.trim();
    if (!text || get().thinking) return;
    if (!get().isConfigured()) {
      set({ error: "Add your AI provider API key first." });
      return;
    }

    const userMsg: ChatMessage = { id: newId(), role: "user", content: text };
    set((s) => ({ messages: appendMessage(s.messages, userMsg), thinking: true, error: null }));

    const { settings, messages } = get();
    const current = useMessageStore.getState().message;
    const system = buildSystemPrompt(current);

    inflight = new AbortController();
    const result = await callAI(settings, system, toTurns(messages), inflight.signal);
    inflight = null;

    if (!result.ok) {
      set({ thinking: false, error: result.error ?? "Request failed." });
      return;
    }

    const { text: prose, payload } = extractReply(result.text ?? "");

    let appliedMessage = false;
    let issueCount: number | undefined;
    if (payload !== null) {
      try {
        const message = attachEditorFields(payload);
        const validation = validateMessage(message);
        useMessageStore.getState().replaceMessage(message);
        appliedMessage = true;
        issueCount = validation.ok ? undefined : validation.issues.length;
      } catch {
        // The model produced something we can't import; fall back to prose only
        // so the user still sees the reply rather than a silent failure.
        appliedMessage = false;
      }
    }

    const assistantMsg: ChatMessage = {
      id: newId(),
      role: "assistant",
      content:
        prose ||
        (appliedMessage
          ? "Done — I updated the message in the editor."
          : "I wasn't sure how to change the message. Could you give me more detail?"),
      appliedMessage,
      issueCount,
    };
    set((s) => ({ messages: appendMessage(s.messages, assistantMsg), thinking: false }));
  },

  cancel() {
    inflight?.abort();
    inflight = null;
    set({ thinking: false });
  },

  clearChat() {
    inflight?.abort();
    inflight = null;
    set({ messages: [], thinking: false, error: null });
  },
}));
