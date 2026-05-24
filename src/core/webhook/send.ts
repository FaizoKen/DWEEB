/**
 * Webhook execution.
 *
 * Posts the current message directly to Discord from the browser. The webhook
 * execute endpoint accepts cross-origin requests, so no proxy is needed — and
 * by keeping the call client-side the webhook URL never leaves the user's
 * machine.
 *
 * The body Discord receives is the wire-format payload (from
 * `serialization/normalize.ts`) plus the `IS_COMPONENTS_V2` flag. With that
 * flag set Discord rejects any payload that also includes `content` or
 * `embeds`, so the message-level fields we attach (`username`, `avatar_url`,
 * `tts`) are the only extras allowed.
 */

import {
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  type WebhookMessage,
} from "@/core/schema/types";
import { attachEditorFields, stripEditorFields } from "@/core/serialization/normalize";

/** Discord limits us to webhooks under one of these origins. */
const WEBHOOK_HOST_RE =
  /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord(?:app)?)\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)\/?$/i;

export interface ParsedWebhookUrl {
  /** Webhook snowflake. Useful for de-duping history entries. */
  id: string;
  /**
   * The canonical execute URL — origin + path with any trailing slash
   * removed. Query/fragment from the user's paste are dropped so we don't
   * accidentally inherit someone else's `?thread_id=` etc.
   */
  url: string;
}

export function parseWebhookUrl(input: string): ParsedWebhookUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Strip any query/fragment the user may have pasted.
  const noQuery = trimmed.split(/[?#]/, 1)[0]!;
  const m = WEBHOOK_HOST_RE.exec(noQuery);
  if (!m) return null;
  return { id: m[1]!, url: noQuery.replace(/\/$/, "") };
}

/**
 * Extract a message snowflake from either:
 *  - a raw numeric ID (`1185234567890123456`), or
 *  - a Discord client/web URL of the form
 *    `https://discord.com/channels/{guild_id}/{channel_id}/{message_id}`.
 *
 * The guild/channel parts are discarded — webhook GET/PATCH only need the
 * message id (the webhook URL itself proves authorization).
 */
export function parseMessageIdInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d{15,25}$/.test(trimmed)) return trimmed;
  const linkMatch =
    /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/\d+\/(\d{15,25})/i.exec(trimmed);
  return linkMatch?.[1] ?? null;
}

export interface SendOptions {
  /** Optional thread id to post into (forum/thread channels). */
  threadId?: string;
  /** If true, Discord echoes the created message in the response. */
  wait?: boolean;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface SendOk {
  ok: true;
  /** 204 when wait=false, 200 when wait=true. */
  status: number;
  /** Returned message JSON when wait=true; null otherwise. */
  body: unknown;
}

export interface SendErr {
  ok: false;
  status: number;
  /**
   * User-facing message. For Discord-side errors we use their `message` field;
   * for network/CORS failures we explain what happened in plain terms.
   */
  error: string;
  /**
   * Number of seconds Discord asked us to wait, when rate-limited. The UI
   * uses this to render a countdown rather than just "try again later".
   */
  retryAfter?: number;
  /** Raw response body for advanced debugging. */
  body?: unknown;
}

export type SendResult = SendOk | SendErr;

/** Build the JSON payload Discord expects on a Components V2 webhook execute. */
export function buildWirePayload(message: WebhookMessage): Record<string, unknown> {
  const stripped = stripEditorFields(message) as Record<string, unknown>;
  return { ...stripped, flags: MESSAGE_FLAG_IS_COMPONENTS_V2 };
}

export async function sendToWebhook(
  parsed: ParsedWebhookUrl,
  message: WebhookMessage,
  options: SendOptions = {},
): Promise<SendResult> {
  const url = new URL(parsed.url);
  if (options.threadId) url.searchParams.set("thread_id", options.threadId);
  if (options.wait) url.searchParams.set("wait", "true");
  // `with_components=true` is required on the execute endpoint so Discord
  // does not silently downgrade the message when V2 components are present.
  url.searchParams.set("with_components", "true");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWirePayload(message)),
      signal: options.signal,
    });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") {
      return { ok: false, status: 0, error: "Send was cancelled." };
    }
    // CORS/offline/DNS land here. We can't see the underlying status.
    return {
      ok: false,
      status: 0,
      error:
        "Network request failed. Check the URL, your connection, or any browser extensions blocking requests to discord.com.",
    };
  }

  // No-body responses (the default `wait=false` path).
  if (res.status === 204) return { ok: true, status: 204, body: null };

  // Try to parse the body — Discord returns JSON for both success (wait=true)
  // and structured error responses.
  let body: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (res.ok) return { ok: true, status: res.status, body };

  if (res.status === 429) {
    const retryHeader = res.headers.get("retry-after");
    const retryFromHeader = retryHeader ? Number.parseFloat(retryHeader) : NaN;
    const retryFromBody =
      body && typeof body === "object" && "retry_after" in body
        ? Number((body as { retry_after: unknown }).retry_after)
        : NaN;
    const retryAfter = Number.isFinite(retryFromHeader)
      ? retryFromHeader
      : Number.isFinite(retryFromBody)
        ? retryFromBody
        : undefined;
    return {
      ok: false,
      status: 429,
      error: "Rate limited by Discord. Try again shortly.",
      retryAfter,
      body,
    };
  }

  const errorMessage = describeError(res.status, body);
  return { ok: false, status: res.status, error: errorMessage, body };
}

function describeError(status: number, body: unknown): string {
  // Discord shapes: { code, message, errors? }
  if (body && typeof body === "object") {
    const obj = body as { message?: unknown; code?: unknown };
    if (typeof obj.message === "string" && obj.message.length > 0) {
      return `Discord (${status}, code ${obj.code ?? "?"}): ${obj.message}`;
    }
  }
  if (status === 401) return "Discord rejected the webhook token (401 Unauthorized).";
  if (status === 404) return "Discord could not find that webhook (404). It may have been deleted.";
  if (status === 400) return "Discord rejected the payload (400). See the body for details.";
  return `Discord returned an unexpected ${status} response.`;
}

/* ─── Restore (GET) ──────────────────────────────────────────────────── */

export interface FetchOk {
  ok: true;
  status: number;
  message: WebhookMessage;
}
export interface FetchErr {
  ok: false;
  status: number;
  error: string;
  body?: unknown;
}
export type FetchResult = FetchOk | FetchErr;

export interface FetchOptions {
  threadId?: string;
  signal?: AbortSignal;
}

/**
 * Fetch a message that was previously posted by THIS webhook. The webhook
 * token authenticates the request — there's no way to fetch a message a
 * user/bot/other webhook posted, even in the same channel.
 *
 * The returned message goes through `attachEditorFields` so callers can drop
 * it straight into the editor. Unknown wire fields are ignored; the
 * validator will surface anything structurally wrong on the next render.
 */
export async function fetchWebhookMessage(
  parsed: ParsedWebhookUrl,
  messageId: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const url = new URL(`${parsed.url}/messages/${encodeURIComponent(messageId)}`);
  if (options.threadId) url.searchParams.set("thread_id", options.threadId);
  url.searchParams.set("with_components", "true");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") {
      return { ok: false, status: 0, error: "Fetch was cancelled." };
    }
    return {
      ok: false,
      status: 0,
      error:
        "Network request failed. Check the URL, your connection, or any browser extensions blocking requests to discord.com.",
    };
  }

  let body: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: describeError(res.status, body), body };
  }

  try {
    const message = attachEditorFields(body);
    return { ok: true, status: res.status, message };
  } catch (e) {
    return {
      ok: false,
      status: res.status,
      error: `Fetched message did not look like a Components V2 payload: ${(e as Error).message}`,
      body,
    };
  }
}

/* ─── Update (PATCH) ─────────────────────────────────────────────────── */

/**
 * Replace a previously-posted webhook message in place. Same authorization
 * rule as `fetchWebhookMessage`: only messages this webhook originally sent
 * are editable. Discord 404s otherwise.
 */
export async function updateWebhookMessage(
  parsed: ParsedWebhookUrl,
  messageId: string,
  message: WebhookMessage,
  options: SendOptions = {},
): Promise<SendResult> {
  const url = new URL(`${parsed.url}/messages/${encodeURIComponent(messageId)}`);
  if (options.threadId) url.searchParams.set("thread_id", options.threadId);
  url.searchParams.set("with_components", "true");

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWirePayload(message)),
      signal: options.signal,
    });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") {
      return { ok: false, status: 0, error: "Update was cancelled." };
    }
    return {
      ok: false,
      status: 0,
      error:
        "Network request failed. Check the URL, your connection, or any browser extensions blocking requests to discord.com.",
    };
  }

  let body: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (res.ok) return { ok: true, status: res.status, body };

  if (res.status === 429) {
    const retryHeader = res.headers.get("retry-after");
    const retryFromHeader = retryHeader ? Number.parseFloat(retryHeader) : NaN;
    const retryFromBody =
      body && typeof body === "object" && "retry_after" in body
        ? Number((body as { retry_after: unknown }).retry_after)
        : NaN;
    const retryAfter = Number.isFinite(retryFromHeader)
      ? retryFromHeader
      : Number.isFinite(retryFromBody)
        ? retryFromBody
        : undefined;
    return {
      ok: false,
      status: 429,
      error: "Rate limited by Discord. Try again shortly.",
      retryAfter,
      body,
    };
  }

  return { ok: false, status: res.status, error: describeError(res.status, body), body };
}
