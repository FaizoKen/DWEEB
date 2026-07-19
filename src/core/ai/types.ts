/**
 * AI assistant — shared types.
 *
 * The assistant lets a user bring their own API key for any of the supported
 * providers and chat their way to a finished Components V2 message. Everything
 * here is provider-agnostic; the concrete request/response shapes live in
 * `providers.ts`.
 */

/**
 * Supported provider families. `dweeb` is the built-in, no-key mode: the DWEEB
 * proxy holds a server-side Groq key and relays the completion (sign-in +
 * daily quotas apply — see `server/src/ai.rs`). Groq, OpenRouter, and Ollama
 * all speak the OpenAI API; Ollama is a self-hosted local server (no key
 * required).
 */
export type AiProvider =
  | "dweeb"
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "openrouter"
  | "ollama";

/**
 * Persisted assistant configuration. The API key is a credential — it lives in
 * the browser's localStorage and is never sent anywhere except directly to the
 * chosen provider from the user's own machine.
 */
export interface AiSettings {
  provider: AiProvider;
  apiKey: string;
  model: string;
  /**
   * Override the provider's API origin (e.g. a proxy). Empty string means
   * "use the provider default".
   */
  baseUrl: string;
}

/** A single turn in the conversation, as shown in the panel. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Conversational text, with any message-payload JSON block stripped out. */
  content: string;
  /**
   * The assistant's full raw reply, INCLUDING the JSON payload fence that is
   * stripped from `content` for display. This is what goes back to the provider
   * as conversation history — without it the model never sees the JSON it
   * previously produced, so follow-ups like "do it" or "make the button red
   * instead" degrade into vague re-answers.
   */
  raw?: string;
  /**
   * Set on assistant turns that produced a message edit. Drives the inline
   * "updated the message" affordance without re-parsing the content.
   */
  appliedMessage?: boolean;
  /**
   * Set when the turn clearly intended an edit (the reply announced one, or
   * carried a payload) but nothing importable made it into the editor even
   * after the automatic recovery turns. Drives an honest "message not changed"
   * affordance so prose like "Here's a streamlined version!" can't silently
   * masquerade as an applied edit.
   */
  failedEdit?: boolean;
  /** Validation issue count when an edit was applied with warnings/errors. */
  issueCount?: number;
  /**
   * True while this assistant turn is still streaming in. Drives the live caret
   * / typing dots; cleared once the reply is finalized.
   */
  streaming?: boolean;
}

/** What the model returned, after we split prose from any message payload. */
export interface ParsedAssistantReply {
  /** Human-readable prose with the JSON block removed. */
  text: string;
  /** The raw message payload object, when the reply carried one. */
  payload: unknown | null;
}
