/**
 * Provider metadata — the lightweight, data-only half of the AI layer.
 *
 * This is deliberately separate from `providers.ts` (the network/streaming
 * engine). `settingsStorage` — which is pulled into the main bundle via the AI
 * store — only needs the defaults here, and the settings form/chat panel only
 * need the `PROVIDERS` table. Keeping that metadata out of `providers.ts` means
 * the ~500 lines of provider request/SSE code never reach the initial bundle;
 * it loads lazily on the first AI send instead.
 */

import type { AiProvider, AiSettings } from "./types";

export interface ProviderMeta {
  label: string;
  /** Default model id, editable by the user. */
  defaultModel: string;
  /** Canonical API origin (no trailing slash). */
  defaultBaseUrl: string;
  /** Whether the user must supply their own base URL (no sensible default). */
  requiresBaseUrl: boolean;
  /** Whether the provider needs an API key (local servers like Ollama don't). */
  requiresKey: boolean;
  /**
   * True when there's a no-cost path: a free cloud tier (Groq, Gemini,
   * OpenRouter `:free` models) or a self-hosted server (Ollama). Drives the
   * "Free" marker in the picker so users can avoid the pay-per-token providers.
   */
  freeTier: boolean;
  /**
   * Optional override for the "Free" badge text. Gemini's free tier is real but
   * region-locked (some accounts get `limit: 0`), so it gets a qualified label
   * instead of the unconditional "no credit card needed".
   */
  freeTierNote?: string;
  /** Where to get a key. Empty for keyless providers. */
  keysUrl: string;
  keyPlaceholder: string;
}

// Ordered so the free providers come first — that's what the dropdown shows,
// and the default lands on a free tier so a new user can get going at no cost.
export const PROVIDERS: Record<AiProvider, ProviderMeta> = {
  groq: {
    label: "Groq (LPU Cloud)",
    defaultModel: "openai/gpt-oss-120b",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    requiresBaseUrl: false,
    requiresKey: true,
    freeTier: true,
    keysUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_…",
  },
  openrouter: {
    label: "OpenRouter (Models API)",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresBaseUrl: false,
    requiresKey: true,
    freeTier: true,
    keysUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-…",
  },
  gemini: {
    label: "Google (Gemini)",
    defaultModel: "gemini-2.0-flash",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    requiresBaseUrl: false,
    requiresKey: true,
    freeTier: true,
    freeTierNote: "Free tier (region-limited)",
    keysUrl: "https://aistudio.google.com/app/apikey",
    keyPlaceholder: "AIza…",
  },
  openai: {
    label: "OpenAI (ChatGPT)",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresBaseUrl: false,
    requiresKey: true,
    freeTier: false,
    keysUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    // Keep this a currently-served model id: the previous default
    // ("claude-3-5-sonnet-latest") pointed at a model retired in Oct 2025, so
    // every new Anthropic user got a 404 out of the box.
    defaultModel: "claude-opus-4-8",
    defaultBaseUrl: "https://api.anthropic.com",
    requiresBaseUrl: false,
    requiresKey: true,
    freeTier: false,
    keysUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
  },
  // Self-hosted Ollama. Speaks the OpenAI API at /v1 and needs no key. Requests
  // go directly from the browser, so a deployed HTTPS page needs a reachable
  // HTTPS endpoint with suitable CORS headers; it cannot call an HTTP/private
  // endpoint as though the app were running on the same machine. There is no
  // usable default, hence requiresBaseUrl.
  ollama: {
    label: "Ollama (self-hosted)",
    defaultModel: "llama3.2",
    defaultBaseUrl: "",
    requiresBaseUrl: true,
    requiresKey: false,
    freeTier: true,
    keysUrl: "",
    keyPlaceholder: "(no key needed)",
  },
};

/** Provider key the settings form starts on — a free tier by default. */
export const DEFAULT_PROVIDER: AiProvider = "groq";

/** Build a fresh settings object for a provider, seeding sensible defaults. */
export function defaultSettingsFor(provider: AiProvider): AiSettings {
  const meta = PROVIDERS[provider];
  return {
    provider,
    apiKey: "",
    model: meta.defaultModel,
    baseUrl: meta.defaultBaseUrl,
  };
}
