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
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { isProxyConfigured } from "@/core/guild/config";
import type { WebhookMessage } from "@/core/schema/types";
import type { AiSettings, ChatMessage } from "./types";
import type { AiPrompt, AiTurn } from "./providers";
import { useAiUsageStore } from "./usageStore";
import { loadAiSettings, saveAiSettings } from "./settingsStorage";
// `attachEditorFields` (normalize) and `validateMessage` (validation) are on the
// app's critical path already — the editor store, draft persistence, and live
// validation all import them — so they live in the main chunk regardless.
// Importing them statically here (rather than via `loadEngine`'s dynamic batch)
// avoids a Rollup "dynamic import won't move into another chunk" warning with no
// bundle cost.
import { attachEditorFields } from "@/core/serialization/normalize";
import { validateMessage } from "@/core/schema/validation";

/** How many automatic validation-repair turns to attempt after the first reply. */
const MAX_REPAIR_TURNS = 1;

// The chat engine (provider adapters, system prompt, reply parsing) is only
// exercised once the user actually sends a turn and is the largest AI-only code
// in the app. Loading it lazily keeps it out of the initial bundle — the store
// itself only carries the panel's open/settings/transcript state.
function loadEngine() {
  return Promise.all([import("./providers"), import("./systemPrompt"), import("./extractReply")]);
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
let sendSequence = 0;
let activeSendId = 0;
let latestSendId = 0;

/** Abort and permanently supersede the current send. Settings/chat resets use
 * this stronger form; ordinary Cancel keeps the send latest so its partial
 * assistant bubble may still settle, but must relinquish controller ownership. */
function supersedeActiveSend(): void {
  inflight?.abort();
  inflight = null;
  activeSendId = 0;
  latestSendId = ++sendSequence;
}

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
    supersedeActiveSend();
    set({
      settings: next,
      messages: [],
      thinking: false,
      error: null,
    });
  },

  isConfigured() {
    const settings = get().settings;
    // The built-in relay needs no key — only a configured proxy. Sign-in is
    // checked at send time (the auth state may still be resolving here).
    if (settings.provider === "dweeb") return isProxyConfigured();
    return settings.apiKey.trim().length > 0;
  },

  async send(prompt) {
    const text = prompt.trim();
    if (!text || get().thinking) return;
    if (!get().isConfigured()) {
      set({
        error:
          get().settings.provider === "dweeb"
            ? "Built-in AI isn't available in this build — add your own API key in AI settings."
            : "Add your AI provider API key first.",
      });
      return;
    }
    // The built-in relay requires a Discord session. Only a *known* signed-out
    // state blocks here — while auth is still resolving, the request proceeds
    // and a real 401 comes back with the same guidance.
    if (get().settings.provider === "dweeb" && useAuthStore.getState().status === "anon") {
      set({ error: "Sign in with Discord to use the built-in AI — it's free, no key needed." });
      return;
    }

    const sendId = ++sendSequence;
    activeSendId = sendId;
    latestSendId = sendId;
    const isActiveSend = () => activeSendId === sendId;
    const isLatestSend = () => latestSendId === sendId;
    const releaseSend = () => {
      if (activeSendId === sendId) activeSendId = 0;
    };

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
        ...(isLatestSend()
          ? {
              thinking: false,
              error: "Couldn't load the AI assistant. Check your connection and try again.",
            }
          : {}),
      }));
      releaseSend();
      return;
    }
    // Cancel/settings reset can happen while the lazy engine chunk loads. Do
    // not start a provider request after the user already stopped this turn.
    if (!isActiveSend()) {
      set((s) => ({ messages: s.messages.filter((m) => m.id !== assistantId) }));
      return;
    }
    const [
      { callAI, toTurns },
      { buildSystemPrompt, buildPromptContext, buildRepairPrompt, buildMissingPayloadPrompt },
      { extractReply, streamingProse, announcesEdit },
    ] = engine;

    const { settings } = get();
    // The connected server (if any) rides along so the built-in relay draws on
    // a paid server's pooled allowance; BYOK providers ignore it.
    const guildId = useGuildStore.getState().guildId.trim() || undefined;
    const makePrompt = (msg: WebhookMessage): AiPrompt => ({
      system: buildSystemPrompt(msg),
      context: buildPromptContext(msg),
      guildId,
    });
    const basePrompt = makePrompt(useMessageStore.getState().message);
    // Refresh the built-in usage meter once this send fully settles (success
    // or quota refusal both move it).
    const refreshUsage = () => {
      if (settings.provider === "dweeb") void useAiUsageStore.getState().load(guildId);
    };

    // Split a raw reply into prose + a validated, importable message (or null),
    // and collect the error-severity issues that would make Discord reject it.
    // Pure — no store/editor side effects, so it's safe to run on every pass.
    interface Analysis {
      prose: string;
      /** Whether the reply carried a JSON payload at all. */
      hasPayload: boolean;
      /** The importable message, or null when import/parse failed. */
      message: WebhookMessage | null;
      /** Error-severity problems, as human-readable strings for a repair turn. */
      errors: string[];
      /** Total issue count for the bubble badge (only shown when errors exist). */
      issueCount?: number;
    }
    const analyze = (raw: string): Analysis => {
      const { text: prose, payload } = extractReply(raw);
      if (payload === null) {
        return { prose, hasPayload: false, message: null, errors: [] };
      }
      try {
        const message = attachEditorFields(payload);
        const validation = validateMessage(message);
        const errors = validation.issues
          .filter((i) => i.severity === "error")
          .map((i) => i.message);
        return {
          prose,
          hasPayload: true,
          message,
          errors,
          issueCount: validation.ok ? undefined : validation.issues.length,
        };
      } catch (e) {
        // Parsed as JSON but not importable as a message — still repairable.
        return { prose, hasPayload: true, message: null, errors: [(e as Error).message] };
      }
    };

    // Update only the assistant bubble (no editor side effects). `partial`
    // reflects a stream cut short (Stop pressed) — its prose may carry a
    // half-written JSON fence, so we hide it the same way the live view does.
    // `streaming` keeps the caret alive while a repair pass is still running;
    // the "updated the message" affordance is withheld until the turn settles,
    // matching the convention that nothing is "applied" mid-stream (the editor
    // commit happens only once, after every pass resolves).
    const showBubble = (
      analysis: Analysis,
      {
        raw,
        partial,
        streaming,
        settledRaw,
        failedEdit = false,
      }: {
        raw: string;
        partial: boolean;
        streaming: boolean;
        /** Raw reply to persist as provider-facing history (settle only). */
        settledRaw?: string;
        /** Turn intended an edit but nothing importable arrived (settle only). */
        failedEdit?: boolean;
      },
    ) => {
      const settled = !streaming;
      const appliedMessage = settled && analysis.message !== null;
      const proseText = analysis.hasPayload || !partial ? analysis.prose : streamingProse(raw);
      const content = settled
        ? proseText ||
          (appliedMessage
            ? "Done — I updated the message in the editor."
            : "I wasn't sure how to change the message. Could you give me more detail?")
        : proseText;
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content,
                // The raw reply (incl. its JSON fence) is what future turns
                // send back to the provider — see `toTurns`.
                raw: settled ? (settledRaw ?? m.raw) : m.raw,
                appliedMessage,
                failedEdit: settled ? failedEdit : undefined,
                issueCount: appliedMessage ? analysis.issueCount : undefined,
                streaming,
              }
            : m,
        ),
      }));
    };

    // Push the message into the editor — at most ONCE per send, since each call
    // records an undo-history entry. Called after every pass (including repair)
    // has resolved, so the user gets the final, best message in a single undo.
    const commitMessage = (analysis: Analysis) => {
      if (analysis.message) useMessageStore.getState().replaceMessage(analysis.message);
    };

    // Stream one provider turn into the assistant bubble; returns the result and
    // the accumulated raw text (kept even on a mid-stream abort).
    const streamTurn = async (turnPrompt: AiPrompt, turns: AiTurn[]) => {
      let raw = "";
      let frameId: number | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const flushStream = () => {
        frameId = null;
        timeoutId = null;
        const display = streamingProse(raw);
        set((s) => ({
          messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: display } : m)),
        }));
      };
      const scheduleFlush = () => {
        if (frameId !== null || timeoutId !== null) return;
        // Providers may deliver many token events in one display frame. Fold
        // them into one array copy/store notification/render; the final raw
        // transcript still retains every byte for follow-up turns.
        if (typeof requestAnimationFrame === "function") {
          frameId = requestAnimationFrame(flushStream);
        } else {
          timeoutId = setTimeout(flushStream, 16);
        }
      };
      const controller = new AbortController();
      inflight = controller;
      const result = await callAI(settings, turnPrompt, turns, controller.signal, (delta) => {
        raw += delta;
        scheduleFlush();
      });
      if (frameId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frameId);
      }
      if (timeoutId !== null) clearTimeout(timeoutId);
      flushStream();
      // A cancelled turn may have already yielded to a new send. Never clear
      // that newer turn's controller when this older promise finally settles.
      if (inflight === controller) inflight = null;
      return { result, raw };
    };

    const { result, raw } = await streamTurn(basePrompt, toTurns(history));

    // Some adapters/upstreams may resolve successfully despite an AbortSignal.
    // Settle this turn's own bubble, but never apply it after Cancel or after a
    // newer send has taken ownership.
    if (!isActiveSend() && result.ok) {
      const stoppedRaw = result.text ?? raw;
      showBubble(analyze(stoppedRaw), {
        raw: stoppedRaw,
        partial: true,
        streaming: false,
        settledRaw: stoppedRaw,
      });
      return;
    }

    if (!result.ok) {
      // A cancelled request with partial text is kept (the user stopped it on
      // purpose); anything else drops the placeholder and surfaces the error.
      const cancelled = result.error === "Request cancelled.";
      if (cancelled && raw.trim()) {
        const partial = analyze(raw);
        if (isLatestSend()) commitMessage(partial);
        showBubble(partial, { raw, partial: true, streaming: false, settledRaw: raw });
        if (isLatestSend()) set({ thinking: false });
      } else {
        set((s) => ({
          messages: s.messages.filter((m) => m.id !== assistantId),
          ...(isLatestSend()
            ? {
                thinking: false,
                error: cancelled ? null : (result.error ?? "Request failed."),
              }
            : {}),
        }));
      }
      if (!cancelled) refreshUsage();
      releaseSend();
      return;
    }

    // `finalRaw` tracks the raw reply whose payload `analysis` currently
    // reflects — it becomes the assistant turn's provider-facing history.
    let finalRaw = result.text ?? raw;
    let analysis = analyze(finalRaw);
    // Did this turn mean to change the message? True when a payload arrived or
    // the prose announced an edit; drives the honest "not changed" state if the
    // turn still settles without an importable message.
    let editIntended = analysis.hasPayload;

    // Missing-payload recovery: the reply ANNOUNCED an edit ("Here's a
    // streamlined version!") but carried no JSON at all — the classic "the
    // assistant says it did something but nothing happened" failure. Send one
    // follow-up demanding the payload; NO_CHANGE lets the model decline, which
    // keeps a false-positive announcement detection harmless.
    if (!analysis.hasPayload && announcesEdit(analysis.prose)) {
      editIntended = true;
      // Keep the caret alive (with the first pass's prose) while we recover.
      showBubble(analysis, { raw, partial: false, streaming: true });
      const nudgeTurns: AiTurn[] = [
        ...toTurns(history),
        { role: "assistant", content: finalRaw },
        { role: "user", content: buildMissingPayloadPrompt() },
      ];
      const controller = new AbortController();
      inflight = controller;
      const nudge = await callAI(settings, basePrompt, nudgeTurns, controller.signal);
      if (inflight === controller) inflight = null;
      if (nudge.ok) {
        const next = analyze(nudge.text ?? "");
        if (next.hasPayload) {
          // Adopt the payload but keep the first pass's conversational prose —
          // the recovery is invisible polish, not a new chat turn.
          analysis = { ...next, prose: analysis.prose || next.prose };
          finalRaw = nudge.text ?? "";
        } else if (/^no[_\s-]?change\b/i.test(next.prose.trim())) {
          // The model says the announcement wasn't an edit after all — believe
          // it: no payload, but no false "not changed" badge either.
          editIntended = false;
        }
      }
    }

    // Self-repair: when the payload won't pass validation, hand the exact errors
    // back and let the model correct them. The validator's messages are precise,
    // so even a cheap model usually fixes them — turning "updated · N issues"
    // into a clean message. Bounded to MAX_REPAIR_TURNS. The editor isn't
    // touched until the loop settles, so a broken first pass never flashes into
    // the preview and the whole turn collapses to a single undo step.
    if (analysis.errors.length > 0) {
      // Keep the caret alive (with the first pass's prose) while we refine.
      showBubble(analysis, { raw, partial: false, streaming: true });
      let priorRaw = finalRaw;
      for (let attempt = 0; attempt < MAX_REPAIR_TURNS && analysis.errors.length > 0; attempt++) {
        // Show the model the payload it needs to fix as the CURRENT MESSAGE.
        const broken = analysis.message ?? useMessageStore.getState().message;
        const repairTurns: AiTurn[] = [
          ...toTurns(history),
          { role: "assistant", content: priorRaw },
          { role: "user", content: buildRepairPrompt(analysis.errors) },
        ];
        const controller = new AbortController();
        inflight = controller;
        const repair = await callAI(settings, makePrompt(broken), repairTurns, controller.signal);
        if (inflight === controller) inflight = null;
        if (!repair.ok) break; // cancelled or failed — keep the best-effort message
        const next = analyze(repair.text ?? "");
        priorRaw = repair.text ?? "";
        // Adopt only importable repairs — and an importable message always
        // beats an unimportable one, whatever the error counts say (the old
        // `>=` rule silently discarded a valid repair of an unparseable first
        // pass because both carried exactly one "error").
        if (!next.message) break;
        if (analysis.message !== null && next.errors.length >= analysis.errors.length) break;
        // Adopt the cleaner payload but keep the first pass's conversational
        // prose — the repair is invisible polish, not a new chat turn.
        finalRaw = priorRaw;
        analysis = { ...next, prose: analysis.prose };
      }
    }

    if (isLatestSend()) commitMessage(analysis);
    showBubble(analysis, {
      raw,
      partial: false,
      streaming: false,
      settledRaw: finalRaw,
      failedEdit: editIntended && analysis.message === null,
    });
    if (isLatestSend()) set({ thinking: false });
    refreshUsage();
    releaseSend();
  },

  cancel() {
    inflight?.abort();
    inflight = null;
    activeSendId = 0;
    set({ thinking: false });
  },

  clearChat() {
    supersedeActiveSend();
    set({ messages: [], thinking: false, error: null });
  },
}));
