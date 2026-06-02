/**
 * Provider adapters.
 *
 * Each call is made directly from the browser to the chosen provider — exactly
 * like the webhook send path, the API key never leaves the user's machine via
 * our code. All three major providers (and OpenAI-compatible gateways) support
 * cross-origin browser requests; for Anthropic we opt in with the documented
 * `anthropic-dangerous-direct-browser-access` header.
 *
 * Calls stream by default: when the caller passes an `onToken` callback we ask
 * the provider for Server-Sent Events and forward each text delta as it lands,
 * so the chat renders token-by-token like other AI web apps. Each provider's
 * SSE event shape differs, so the adapters decode their own; a shared reader
 * (`readSse`) handles the transport. Without `onToken` (or if the provider
 * ignored the stream flag) we fall back to parsing the whole reply at once.
 */

import type { AiProvider, AiSettings, ChatMessage } from "./types";
import { PROVIDERS } from "./providerMeta";

/**
 * Sampling temperature for every provider. The assistant's job is to emit a
 * strict JSON schema, not creative prose, so determinism wins: cheap/free
 * models in particular adhere to the Components V2 shape far more reliably when
 * they sample narrowly. This is applied to ALL providers — previously only the
 * OpenAI-compatible path set a temperature, so Anthropic and Gemini ran at
 * their ~1.0 defaults, which measurably hurt schema accuracy on smaller models.
 */
const GENERATION_TEMPERATURE = 0.2;

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
 * user turn). When `onToken` is supplied the reply is streamed and each text
 * delta is delivered through it as it arrives; the resolved `text` is still the
 * full reply so callers don't have to reassemble it themselves.
 */
export async function callAI(
  settings: AiSettings,
  system: string,
  turns: AiTurn[],
  signal?: AbortSignal,
  onToken?: (delta: string) => void,
): Promise<AiCallResult> {
  try {
    switch (settings.provider) {
      case "anthropic":
        return await callAnthropic(settings, system, turns, signal, onToken);
      case "gemini":
        return await callGemini(settings, system, turns, signal, onToken);
      case "openai":
      default:
        return await callOpenAiCompatible(settings, system, turns, signal, onToken);
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
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  if (typeof err === "string") return err;
  const msg = (body as { message?: unknown }).message;
  if (typeof msg === "string") return msg;
  return null;
}

function describeHttpError(status: number, body: unknown, provider?: AiProvider): string {
  const providerText = extractProviderMessage(body);

  // Rate limits get a dedicated, actionable framing even when the provider
  // included its own (often terse) message — free models throttle hard.
  if (status === 429) {
    const detail = providerText ? `: ${providerText}` : "";

    // Not every 429 is throttling. Gemini returns one with `limit: 0` (and a
    // "check your plan and billing" message) when the account simply has no
    // free-tier allowance — typically because the free tier isn't offered in
    // the project's region, or billing isn't enabled. Those never clear on
    // retry, so the provider's own "please retry in Ns" is actively
    // misleading; detect them and steer the user somewhere that works.
    const raw = typeof body === "string" ? body : JSON.stringify(body ?? "");
    const noFreeQuota = /limit:\s*0(?![\d.])/.test(raw) || /check your plan and billing/i.test(raw);
    if (noFreeQuota) {
      return (
        "No free quota available (429).\n\n" +
        'The provider reports a free-tier limit of 0 for this model ("check your plan and ' +
        "billing\"). This is not a temporary throttle — retrying won't clear it. It usually " +
        "means the free tier isn't offered in your region, or billing isn't enabled on the " +
        "key. Switch to Groq's free tier, or enable billing for this provider."
      );
    }

    // OpenRouter routes `:free` models to shared upstream hosts, so its 429s
    // (often the terse "Provider returned error") are that upstream throttling —
    // and OpenRouter additionally caps free usage per day. The generic "wait a
    // few seconds" undersells the daily cap, so spell out the real fix.
    if (provider === "openrouter") {
      return (
        `Rate limited (429)${detail}.\n\n` +
        "OpenRouter's :free models share heavily-used upstream hosts and are capped per day " +
        "(currently ~50 requests/day until you've added $10 of credit once, then ~1000/day). " +
        "Try a different :free model, add credit, or switch to Groq's free tier — it's the " +
        "most reliable free option."
      );
    }

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

/** True when a response carries a Server-Sent Events stream we can read. */
function isEventStream(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/event-stream");
}

/**
 * Read a Server-Sent Events stream line by line, handing the payload of each
 * `data:` line to `onData` as it arrives. Returns once the stream ends. Every
 * provider's streaming mode rides on this; they differ only in the JSON shape
 * of each event, which the callers decode. Non-`data:` lines (SSE `event:`
 * names, OpenRouter keep-alive comments) are ignored.
 */
async function readSse(res: Response, onData: (data: string) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data) onData(data);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      flush(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  flush(buffer);
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
  onToken?: (delta: string) => void,
): Promise<AiCallResult> {
  const url = `${resolvedBaseUrl(settings)}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Keyless local servers (Ollama) need no auth; skip the empty bearer, which
  // some OpenAI-compatible servers reject.
  if (settings.apiKey.trim()) headers.Authorization = `Bearer ${settings.apiKey}`;
  // OpenRouter recommends identifying the calling app. These are set on the
  // server-side proxy request, so the browser's forbidden-header rules (Referer)
  // don't apply.
  if (settings.provider === "openrouter") {
    if (typeof location !== "undefined") headers["HTTP-Referer"] = location.origin;
    headers["X-Title"] = "DWEEB";
  }
  const res = await proxiedFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model,
      temperature: GENERATION_TEMPERATURE,
      stream: Boolean(onToken),
      messages: [{ role: "system", content: system }, ...turns],
    }),
    signal,
  });
  if (!res.ok)
    return {
      ok: false,
      error: describeHttpError(res.status, await readJson(res), settings.provider),
    };

  // Streaming chunks: `data: {choices:[{delta:{content}}]}`, ending in `[DONE]`.
  if (onToken && isEventStream(res)) {
    let full = "";
    await readSse(res, (data) => {
      if (data === "[DONE]") return;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const delta = (json as { choices?: Array<{ delta?: { content?: unknown } }> })?.choices?.[0]
        ?.delta?.content;
      if (typeof delta === "string" && delta) {
        full += delta;
        onToken(delta);
      }
    });
    return full
      ? { ok: true, text: full }
      : { ok: false, error: "Provider returned an empty response." };
  }

  // Non-streaming (or the server ignored `stream`): parse the whole reply.
  const body = await readJson(res);
  const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content;
  if (typeof content !== "string") {
    return { ok: false, error: "Provider returned an unexpected response shape." };
  }
  if (onToken) onToken(content);
  return { ok: true, text: content };
}

async function callAnthropic(
  settings: AiSettings,
  system: string,
  turns: AiTurn[],
  signal?: AbortSignal,
  onToken?: (delta: string) => void,
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
      temperature: GENERATION_TEMPERATURE,
      stream: Boolean(onToken),
      system,
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
    }),
    signal,
  });
  if (!res.ok)
    return {
      ok: false,
      error: describeHttpError(res.status, await readJson(res), settings.provider),
    };

  // Anthropic's stream is a sequence of typed events; text arrives as
  // `content_block_delta` with a `text_delta`. Errors come as `error` events.
  if (onToken && isEventStream(res)) {
    let full = "";
    let streamError: string | null = null;
    await readSse(res, (data) => {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const evt = json as {
        type?: string;
        delta?: { type?: string; text?: unknown };
        error?: { message?: unknown };
      };
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
        if (typeof evt.delta.text === "string" && evt.delta.text) {
          full += evt.delta.text;
          onToken(evt.delta.text);
        }
      } else if (evt.type === "error") {
        streamError =
          typeof evt.error?.message === "string" ? evt.error.message : "Provider streaming error.";
      }
    });
    if (streamError) return { ok: false, error: streamError };
    return full
      ? { ok: true, text: full }
      : { ok: false, error: "Provider returned an empty response." };
  }

  const body = await readJson(res);
  const blocks = (body as { content?: Array<{ type?: string; text?: unknown }> })?.content;
  const text = Array.isArray(blocks)
    ? blocks
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("")
    : "";
  if (!text) return { ok: false, error: "Provider returned an empty response." };
  if (onToken) onToken(text);
  return { ok: true, text };
}

async function callGemini(
  settings: AiSettings,
  system: string,
  turns: AiTurn[],
  signal?: AbortSignal,
  onToken?: (delta: string) => void,
): Promise<AiCallResult> {
  const base = resolvedBaseUrl(settings);
  // `streamGenerateContent?alt=sse` emits the same chunks as `generateContent`
  // but one Server-Sent Event at a time instead of one buffered JSON array.
  const endpoint = onToken ? "streamGenerateContent" : "generateContent";
  const sse = onToken ? "&alt=sse" : "";
  const url =
    `${base}/v1beta/models/${encodeURIComponent(settings.model)}:${endpoint}` +
    `?key=${encodeURIComponent(settings.apiKey)}${sse}`;
  const res = await proxiedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      generationConfig: { temperature: GENERATION_TEMPERATURE },
      contents: turns.map((t) => ({
        role: t.role === "assistant" ? "model" : "user",
        parts: [{ text: t.content }],
      })),
    }),
    signal,
  });
  if (!res.ok)
    return {
      ok: false,
      error: describeHttpError(res.status, await readJson(res), settings.provider),
    };

  const partsToText = (parts: unknown): string =>
    Array.isArray(parts)
      ? parts
          .map((p) =>
            typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "",
          )
          .join("")
      : "";

  if (onToken && isEventStream(res)) {
    let full = "";
    await readSse(res, (data) => {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const parts = (json as { candidates?: Array<{ content?: { parts?: unknown } }> })
        ?.candidates?.[0]?.content?.parts;
      const chunk = partsToText(parts);
      if (chunk) {
        full += chunk;
        onToken(chunk);
      }
    });
    return full
      ? { ok: true, text: full }
      : { ok: false, error: "Provider returned an empty response." };
  }

  const body = await readJson(res);
  const parts = (
    body as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }
  )?.candidates?.[0]?.content?.parts;
  const text = partsToText(parts);
  if (!text) return { ok: false, error: "Provider returned an empty response." };
  if (onToken) onToken(text);
  return { ok: true, text };
}
