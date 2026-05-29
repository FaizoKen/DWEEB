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
import { buildSystemPrompt, buildLocalSystemPrompt } from "./systemPrompt";
import { extractReply } from "./extractReply";
import { loadAiSettings, saveAiSettings } from "./settingsStorage";
import { isLikelyMobile, preloadLocalModel, type LocalLoadProgress } from "./localEngine";

interface AiState {
  open: boolean;
  settings: AiSettings;
  messages: ChatMessage[];
  /** True while a provider request is in flight. */
  thinking: boolean;
  /**
   * Set while the local provider is downloading or compiling a model.
   * `null` once the model is resident (or for any non-local provider).
   */
  loadProgress: LocalLoadProgress | null;
  /**
   * The partial assistant reply while a local model streams its answer, so the
   * panel can render it live (like chat.webllm.ai). `null` when not streaming.
   */
  streamingText: string | null;
  /** Last error surfaced to the user (cleared on the next send). */
  error: string | null;

  openPanel(): void;
  closePanel(): void;
  togglePanel(): void;

  setSettings(next: AiSettings): void;
  /**
   * True when the assistant is ready to chat — for cloud providers that means a
   * key is configured, for `local` it's always true (the model downloads on
   * first send).
   */
  isConfigured(): boolean;

  send(prompt: string): Promise<void>;
  cancel(): void;
  clearChat(): void;
  /**
   * Warm the local model in the background (compile + upload) so the first
   * message doesn't pay the one-time ~100% GPU compile mid-chat. No-op unless
   * the configured provider is `local`. Safe to call repeatedly.
   */
  preloadLocal(): void;
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
  loadProgress: null,
  streamingText: null,
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
    // Clear the transcript: prior turns were produced under the old provider/
    // model/key and shouldn't carry into a freshly configured assistant.
    inflight?.abort();
    inflight = null;
    set({
      settings: next,
      messages: [],
      thinking: false,
      loadProgress: null,
      streamingText: null,
      error: null,
    });
  },

  isConfigured() {
    const { settings } = get();
    if (settings.provider === "local") {
      // Mobile WebGPU can't host these models and mobile networks can't reliably
      // deliver the weights — treat saved local config as unconfigured so the
      // panel routes the user back through settings to a working provider.
      return !isLikelyMobile();
    }
    return settings.apiKey.trim().length > 0;
  },

  async send(prompt) {
    const text = prompt.trim();
    if (!text || get().thinking) return;
    if (!get().isConfigured()) {
      set({ error: "Add your AI provider API key first." });
      return;
    }

    const userMsg: ChatMessage = { id: newId(), role: "user", content: text };
    set((s) => ({
      messages: appendMessage(s.messages, userMsg),
      thinking: true,
      loadProgress: null,
      streamingText: null,
      error: null,
    }));

    const { settings, messages } = get();
    const current = useMessageStore.getState().message;
    // The local (WebGPU) provider gets a compact prompt to keep GPU memory
    // pressure down on integrated GPUs; cloud providers get the full schema.
    const system =
      settings.provider === "local" ? buildLocalSystemPrompt(current) : buildSystemPrompt(current);

    inflight = new AbortController();
    const result = await callAI(
      settings,
      system,
      toTurns(messages),
      inflight.signal,
      (p) => {
        // Only surface progress while we're still the in-flight request; a
        // finished load shouldn't redraw the spinner.
        if (get().thinking) set({ loadProgress: p.progress < 1 ? p : null });
      },
      (textSoFar) => {
        // Live partial reply from a streaming local model. The first token also
        // means loading is done, so clear the progress bar.
        if (get().thinking) set({ streamingText: textSoFar, loadProgress: null });
      },
    );
    inflight = null;

    if (!result.ok) {
      set({
        thinking: false,
        loadProgress: null,
        streamingText: null,
        error: result.error ?? "Request failed.",
      });
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
    set((s) => ({
      messages: appendMessage(s.messages, assistantMsg),
      thinking: false,
      loadProgress: null,
      streamingText: null,
    }));
  },

  cancel() {
    inflight?.abort();
    inflight = null;
    set({ thinking: false, loadProgress: null, streamingText: null });
  },

  clearChat() {
    inflight?.abort();
    inflight = null;
    set({ messages: [], thinking: false, loadProgress: null, streamingText: null, error: null });
  },

  preloadLocal() {
    const { settings } = get();
    if (settings.provider !== "local" || !get().isConfigured()) return;
    // Don't interfere with an in-flight send or a load already underway.
    if (get().thinking || get().loadProgress) return;
    void preloadLocalModel(settings, (p) => {
      // Surface the warm-up via the same loading bar, but never stomp on an
      // in-flight send that may have started meanwhile.
      if (!get().thinking) set({ loadProgress: p.progress < 1 ? p : null });
    }).finally(() => {
      if (!get().thinking) set({ loadProgress: null });
    });
  },
}));
