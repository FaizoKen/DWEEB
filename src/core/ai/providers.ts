/**
 * Provider adapters.
 *
 * Each call is made directly from the browser to the chosen provider — exactly
 * like the webhook send path, the API key never leaves the user's machine via
 * our code. All three major providers (and OpenAI-compatible gateways) support
 * cross-origin browser requests; for Anthropic we opt in with the documented
 * `anthropic-dangerous-direct-browser-access` header.
 *
 * Calls are non-streaming: a single request returns the whole reply. That keeps
 * the adapter logic small and uniform across providers, which matters far more
 * here than token-by-token rendering.
 */

import type { AiProvider, AiSettings, ChatMessage } from "./types";

export interface ProviderMeta {
  label: string;
  /** Default model id, editable by the user. */
  defaultModel: string;
  /** Canonical API origin (no trailing slash). */
  defaultBaseUrl: string;
  /** Whether the user must supply their own base URL (no sensible default). */
  requiresBaseUrl: boolean;
  /** Where to get a key. */
  keysUrl: string;
  keyPlaceholder: string;
}

export const PROVIDERS: Record<AiProvider, ProviderMeta> = {
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresBaseUrl: false,
    keysUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    defaultModel: "claude-3-5-sonnet-latest",
    defaultBaseUrl: "https://api.anthropic.com",
    requiresBaseUrl: false,
    keysUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
  },
  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-2.0-flash",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    requiresBaseUrl: false,
    keysUrl: "https://aistudio.google.com/app/apikey",
    keyPlaceholder: "AIza…",
  },
  groq: {
    label: "Groq (free)",
    defaultModel: "llama-3.3-70b-versatile",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    requiresBaseUrl: false,
    keysUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_…",
  },
  openrouter: {
    label: "OpenRouter (free models)",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresBaseUrl: false,
    keysUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-…",
  },
};

export interface AiTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AiCallResult {
  ok: boolean;
  /** Assistant reply text on success. */
  text?: string;
  /** User-facing error on failure. */
  error?: string;
}

/** Strip a trailing slash so we can append paths predictably. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function resolvedBaseUrl(settings: AiSettings): string {
  const meta = PROVIDERS[settings.provider];
  const chosen = settings.baseUrl.trim() || meta.defaultBaseUrl;
  return trimSlash(chosen);
}

/** Turn the in-panel transcript into provider-neutral turns. */
export function toTurns(messages: ChatMessage[]): AiTurn[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Make one completion request. `system` is the schema/instruction prompt,
 * `turns` is the running conversation (oldest first, ending with the latest
 * user turn).
 */
export async function callAI(
  settings: AiSettings,
  system: string,
  turns: AiTurn[],
  signal?: AbortSignal,
): Promise<AiCallResult> {
  try {
    switch (settings.provider) {
      case "anthropic":
        return await callAnthropic(settings, system, turns, signal);
      case "gemini":
        return await callGemini(settings, system, turns, signal);
      case "openai":
      default:
        return await callOpenAiCompatible(settings, system, turns, signal);
    }
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") {
      return { ok: false, error: "Request cancelled." };
    }
    return { ok: false, error: networkErrorMessage(settings.provider) };
  }
}

/**
 * `fetch` only throws (vs. returning an error response) when the request never
 * completes — a CORS rejection, a DNS/connection failure, or a content blocker.
 * Since the cause is provider-dependent, tailor the guidance per provider.
 */
function networkErrorMessage(provider: AiProvider): string {
  const base =
    "Couldn't reach the provider — the request was blocked before any response came back. " +
    "This is usually a CORS restriction, a network/DNS problem, or a browser ad-block/privacy extension.";
  switch (provider) {
    case "openai":
      return `${base}\n\nTips: make sure the key is an OpenAI key (sk-…) and that no extension is blocking api.openai.com. If your provider doesn't allow browser calls, set the Base URL to a proxy you control.`;
    case "anthropic":
      return `${base}\n\nTips: confirm the key (sk-ant-…) and model id are correct. The browser-access header is already sent; a corporate network or extension may still be blocking the request.`;
    case "gemini":
      return `${base}\n\nTips: confirm the API key and model id (e.g. gemini-2.0-flash) are correct, and that nothing is blocking generativelanguage.googleapis.com.`;
    default:
      return `${base}\n\nTips: confirm the API key and model id are correct, and that the endpoint allows the request.`;
  }
}

/** Pull the human-readable message out of a provider's JSON error body. */
function extractProviderMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  if (typeof err === "string") return err;
  const msg = (body as { message?: unknown }).message;
  if (typeof msg === "string") return msg;
  return null;
}

function describeHttpError(status: number, body: unknown): string {
  const providerText = extractProviderMessage(body);

  // Rate limits get a dedicated, actionable framing even when the provider
  // included its own (often terse) message — free models throttle hard.
  if (status === 429) {
    const detail = providerText ? `: ${providerText}` : "";
    return (
      `Rate limited (429)${detail}.\n\n` +
      "Free models can be busy — wait a few seconds and try again, pick a different " +
      "model, or switch provider (Groq's free tier is usually the most reliable)."
    );
  }

  if (providerText) return `Provider error (${status}): ${providerText}`;
  if (status === 401) return "Provider rejected the API key (401). Double-check the key.";
  if (status === 403) return "Provider denied the request (403). Check key permissions / billing.";
  if (status === 404) return "Endpoint not found (404). Check the model id and base URL.";
  return `Provider returned an unexpected ${status} response.`;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Same-origin Pages Function that forwards the provider request server-side. */
const PROXY_ENDPOINT = "/api/llm";

/**
 * Issue the provider request through our same-origin proxy first.
 *
 * The static site's CSP (`connect-src 'self'`) blocks direct calls to provider
 * hosts, and providers vary in whether they allow cross-origin browser calls.
 * Routing through `/api/llm` keeps the browser on its own origin and lets the
 * call happen server-side. If the proxy isn't deployed (e.g. local `vite dev`,
 * where the SPA catch-all serves index.html), we detect that and fall back to a
 * direct call so development still works.
 */
async function proxiedFetch(targetUrl: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetch(PROXY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetUrl,
        method: init.method ?? "POST",
        headers: init.headers ?? {},
        body: typeof init.body === "string" ? init.body : null,
      }),
      signal: init.signal ?? null,
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status !== 404 && !contentType.includes("text/html")) return res;
  } catch {
    // Couldn't reach our own origin — fall through to a direct request.
  }
  return fetch(targetUrl, init);
}

async function callOpenAiCompatible(
  settings: AiSettings,
  system: string,
  turns: AiTurn[],
  signal?: AbortSignal,
): Promise<AiCallResult> {
  const url = `${resolvedBaseUrl(settings)}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey}`,
  };
  // OpenRouter recommends identifying the calling app. These are set on the
  // server-side proxy request, so the browser's forbidden-header rules (Referer)
  // don't apply.
  if (settings.provider === "openrouter") {
    if (typeof location !== "undefined") headers["HTTP-Referer"] = location.origin;
    headers["X-Title"] = "Discord Webhook Builder";
  }
  const res = await proxiedFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.4,
      messages: [{ role: "system", content: system }, ...turns],
    }),
    signal,
  });
  const body = await readJson(res);
  if (!res.ok) return { ok: false, error: describeHttpError(res.status, body) };

  const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content;
  if (typeof content !== "string") {
    return { ok: false, error: "Provider returned an unexpected response shape." };
  }
  return { ok: true, text: content };
}

async function callAnthropic(
  settings: AiSettings,
  system: string,
  turns: AiTurn[],
  signal?: AbortSignal,
): Promise<AiCallResult> {
  const url = `${resolvedBaseUrl(settings)}/v1/messages`;
  const res = await proxiedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 4096,
      system,
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
    }),
    signal,
  });
  const body = await readJson(res);
  if (!res.ok) return { ok: false, error: describeHttpError(res.status, body) };

  const blocks = (body as { content?: Array<{ type?: string; text?: unknown }> })?.content;
  const text = Array.isArray(blocks)
    ? blocks
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("")
    : "";
  if (!text) return { ok: false, error: "Provider returned an empty response." };
  return { ok: true, text };
}

async function callGemini(
  settings: AiSettings,
  system: string,
  turns: AiTurn[],
  signal?: AbortSignal,
): Promise<AiCallResult> {
  const base = resolvedBaseUrl(settings);
  const url =
    `${base}/v1beta/models/${encodeURIComponent(settings.model)}:generateContent` +
    `?key=${encodeURIComponent(settings.apiKey)}`;
  const res = await proxiedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: turns.map((t) => ({
        role: t.role === "assistant" ? "model" : "user",
        parts: [{ text: t.content }],
      })),
    }),
    signal,
  });
  const body = await readJson(res);
  if (!res.ok) return { ok: false, error: describeHttpError(res.status, body) };

  const parts = (
    body as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }
  )?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
    : "";
  if (!text) return { ok: false, error: "Provider returned an empty response." };
  return { ok: true, text };
}

/** Provider key the settings form starts on. */
export const DEFAULT_PROVIDER: AiProvider = "openai";

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
