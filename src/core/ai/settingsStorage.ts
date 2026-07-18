/**
 * AI settings persistence.
 *
 * The API key is a credential, so this mirrors the same conservative pattern
 * the rest of the app uses for localStorage (versioned key, safe parse, never
 * throws). The key lives only in this browser; it is sent solely to the
 * provider the user selected, directly from their machine.
 */

import type { AiProvider, AiSettings } from "./types";
import { DEFAULT_PROVIDER, defaultSettingsFor } from "./providerMeta";

const STORAGE_KEY = "dweeb.ai.v1";

const PROVIDERS: AiProvider[] = ["openai", "anthropic", "gemini", "groq", "openrouter", "ollama"];

export function loadAiSettings(): AiSettings {
  const fallback = defaultSettingsFor(DEFAULT_PROVIDER);
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    const known =
      typeof parsed.provider === "string" && PROVIDERS.includes(parsed.provider as AiProvider);
    const provider = known ? (parsed.provider as AiProvider) : DEFAULT_PROVIDER;
    const seed = defaultSettingsFor(provider);
    // When the stored provider is no longer supported (e.g. the retired "local"
    // provider) we fall back to the default; the persisted model/base URL belong
    // to the old provider, so seed fresh defaults rather than carry them over.
    if (!known) return seed;
    const model = typeof parsed.model === "string" && parsed.model ? parsed.model : seed.model;
    return {
      provider,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : seed.baseUrl,
    };
  } catch {
    return fallback;
  }
}

export function saveAiSettings(settings: AiSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota / disabled storage — losing the setting is preferable to throwing.
  }
}

export function clearAiSettings(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
