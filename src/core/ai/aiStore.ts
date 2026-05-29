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
import type { AiSettings, ChatMessage } from "./types";
import { loadAiSettings, saveAiSettings } from "./settingsStorage";

// The chat engine (providers, system prompt, reply parsing, schema validation)
// is only exercised once the user actually sends a turn, and it pulls in the
// largest non-vendor modules in the app (the provider adapters and the
// validator). Loading it lazily keeps all of that out of the initial bundle —
// the store itself only carries the panel's open/settings/transcript state.
function loadEngine() {
  return Promise.all([
    import("./providers"),
    import("./systemPrompt"),
    import("./extractReply"),
    import("@/core/serialization/normalize"),
    import("@/core/schema/validation"),
  ]);
}

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
  /** True when the assistant is ready to chat — a provider API key is configured. */
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
    // Clear the transcript: prior turns were produced under the old provider/
    // model/key and shouldn't carry into a freshly configured assistant.
    inflight?.abort();
    inflight = null;
    set({
      settings: next,
      messages: [],
      thinking: false,
      error: null,
    });
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

    // Append the user turn plus an empty assistant placeholder we stream into.
    // `thinking` stays true for the whole request so the composer keeps showing
    // Stop; the placeholder's empty content drives the typing dots until the
    // first token lands. This happens before the (lazy) engine resolves so the
    // user's message and typing indicator appear instantly on first send.
    const userMsg: ChatMessage = { id: newId(), role: "user", content: text };
    const assistantId = newId();
    const history = appendMessage(get().messages, userMsg);
    set({
      messages: appendMessage(history, {
        id: assistantId,
        role: "assistant",
        content: "",
        streaming: true,
      }),
      thinking: true,
      error: null,
    });

    // Pull in the chat engine on first send (cached for subsequent turns).
    let engine: Awaited<ReturnType<typeof loadEngine>>;
    try {
      engine = await loadEngine();
    } catch {
      set((s) => ({
        messages: s.messages.filter((m) => m.id !== assistantId),
        thinking: false,
        error: "Couldn't load the AI assistant. Check your connection and try again.",
      }));
      return;
    }
    const [
      { callAI, toTurns },
      { buildSystemPrompt },
      { extractReply, streamingProse },
      { attachEditorFields },
      { validateMessage },
    ] = engine;

    const { settings } = get();
    const current = useMessageStore.getState().message;
    const system = buildSystemPrompt(current);

    // Resolve the streamed reply into the placeholder: apply any message payload
    // and replace the bubble text with the finished prose. `partial` reflects a
    // stream cut short (Stop pressed) — its prose may carry a half-written JSON
    // fence, so we hide it the same way the live view does.
    const finalize = (raw: string, partial: boolean) => {
      const { text: prose, payload } = extractReply(raw);
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
          // The model produced something we can't import; fall back to prose
          // only so the user still sees the reply rather than a silent failure.
          appliedMessage = false;
        }
      }
      const proseText = payload !== null || !partial ? prose : streamingProse(raw);
      const content =
        proseText ||
        (appliedMessage
          ? "Done — I updated the message in the editor."
          : "I wasn't sure how to change the message. Could you give me more detail?");
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId
            ? { ...m, content, appliedMessage, issueCount, streaming: false }
            : m,
        ),
      }));
    };

    let raw = "";
    inflight = new AbortController();
    const result = await callAI(settings, system, toTurns(history), inflight.signal, (delta) => {
      raw += delta;
      const display = streamingProse(raw);
      set((s) => ({
        messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: display } : m)),
      }));
    });
    inflight = null;

    if (!result.ok) {
      // A cancelled request with partial text is kept (the user stopped it on
      // purpose); anything else drops the placeholder and surfaces the error.
      const cancelled = result.error === "Request cancelled.";
      if (cancelled && raw.trim()) {
        finalize(raw, true);
        set({ thinking: false });
      } else {
        set((s) => ({
          messages: s.messages.filter((m) => m.id !== assistantId),
          thinking: false,
          error: cancelled ? null : (result.error ?? "Request failed."),
        }));
      }
      return;
    }

    finalize(result.text ?? raw, false);
    set({ thinking: false });
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
