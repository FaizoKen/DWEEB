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
import { stripEditorFields } from "@/core/serialization/normalize";

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
