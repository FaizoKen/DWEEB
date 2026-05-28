/**
 * AI settings persistence.
 *
 * The API key is a credential, so this mirrors the same conservative pattern
 * the rest of the app uses for localStorage (versioned key, safe parse, never
 * throws). The key lives only in this browser; it is sent solely to the
 * provider the user selected, directly from their machine.
 */

import type { AiProvider, AiSettings } from "./types";
import { DEFAULT_PROVIDER, defaultSettingsFor } from "./providers";

const STORAGE_KEY = "dwb.ai.v1";

const PROVIDERS: AiProvider[] = ["openai", "anthropic", "gemini", "groq", "openrouter", "local"];

export function loadAiSettings(): AiSettings {
  const fallback = defaultSettingsFor(DEFAULT_PROVIDER);
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    const provider =
      typeof parsed.provider === "string" && PROVIDERS.includes(parsed.provider as AiProvider)
        ? (parsed.provider as AiProvider)
        : DEFAULT_PROVIDER;
    const seed = defaultSettingsFor(provider);
    return {
      provider,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: typeof parsed.model === "string" && parsed.model ? parsed.model : seed.model,
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
