/**
 * Webhook execution.
 *
 * Posts the current message directly to Discord from the browser. The webhook
 * execute endpoint accepts cross-origin requests, so no proxy is needed — and
 * by keeping the call client-side the webhook URL never leaves the user's
 * machine.
 *
 * The body Discord receives is the wire-format payload (from
 * `serialization/normalize.ts`) plus a `flags` integer combining
 * `IS_COMPONENTS_V2` and optionally `SUPPRESS_NOTIFICATIONS`. With the V2
 * flag set Discord rejects any payload that also includes `content` or
 * `embeds`, so the message-level fields we attach (`username`, `avatar_url`,
 * `tts`, `allowed_mentions`, `message_reference`, `thread_name`,
 * `applied_tags`) are the only extras allowed.
 */

import {
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS,
  type WebhookMessage,
} from "@/core/schema/types";
import { attachEditorFields, stripEditorFields } from "@/core/serialization/normalize";
import { collectSessionAttachments } from "@/core/serialization/attachments";

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

/**
 * Combine `IS_COMPONENTS_V2` with any opt-in message-level flags the editor
 * exposes (currently `SUPPRESS_NOTIFICATIONS`). Always returns the V2 bit
 * because we never post without Components V2.
 */
function flagsFor(message: WebhookMessage): number {
  let f = MESSAGE_FLAG_IS_COMPONENTS_V2;
  if (message.suppress_notifications) f |= MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS;
  return f;
}

/** Build the JSON payload Discord expects on a Components V2 webhook execute. */
export function buildWirePayload(message: WebhookMessage): Record<string, unknown> {
  const stripped = stripEditorFields(message) as Record<string, unknown>;
  return { ...stripped, flags: flagsFor(message) };
}

/**
 * Wrap a payload + its attachments into a Discord-compatible request body.
 *
 * When the message references no session blobs we keep posting JSON — that
 * path stays free of any multipart bookkeeping. Once at least one blob is
 * referenced we switch to `multipart/form-data` with:
 *   - `payload_json`: the JSON body (Discord parses it identically),
 *   - `files[i]`: the actual file bytes for each attachment index `i`,
 *   - an `attachments` array in the payload that maps each `files[i]` to its
 *     descriptive filename so `attachment://<filename>` references resolve.
 */
interface PreparedBody {
  body: BodyInit;
  headers?: Record<string, string>;
}

function prepareBody(message: WebhookMessage): PreparedBody {
  const { payload, files } = collectSessionAttachments(message);
  const enriched = { ...payload, flags: flagsFor(message) };

  if (files.length === 0) {
    return {
      body: JSON.stringify(enriched),
      headers: { "Content-Type": "application/json" },
    };
  }

  // Discord wants an `attachments` entry for every uploaded file so it can
  // map `attachment://<filename>` references to the right multipart part.
  const finalPayload = {
    ...enriched,
    attachments: files.map((f, i) => ({ id: i, filename: f.filename })),
  };

  const form = new FormData();
  form.append("payload_json", JSON.stringify(finalPayload));
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    form.append(`files[${i}]`, f.file, f.filename);
  }
  // Let the browser pick the multipart boundary by NOT setting Content-Type.
  return { body: form };
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

  const prepared = prepareBody(message);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: prepared.headers,
      body: prepared.body,
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
    const obj = body as { message?: unknown; code?: unknown; errors?: unknown };
    const head =
      typeof obj.message === "string" && obj.message.length > 0
        ? `Discord (${status}, code ${obj.code ?? "?"}): ${obj.message}`
        : null;

    // For "Invalid Form Body" (and similar) the actionable info lives in the
    // nested `errors` tree, not the top-level message. Flatten it into
    // field-pathed lines so the user knows exactly what to fix.
    const details = flattenDiscordErrors(obj.errors);
    if (head && details.length > 0) {
      return `${head}\n${details.map((d) => `• ${d}`).join("\n")}`;
    }
    if (head) return head;
    if (details.length > 0) {
      return `Discord rejected the payload (${status}):\n${details
        .map((d) => `• ${d}`)
        .join("\n")}`;
    }
  }

  // The body didn't match Discord's `{ message, errors }` shape (e.g. a plain
  // string, an empty body, or an unfamiliar structure). We don't inline the
  // raw body here — it's returned separately on `SendErr.body` so the UI can
  // offer a "show raw response" toggle without duplicating it in the message.
  const hasBody = body != null && (typeof body !== "string" || body.trim().length > 0);
  if (status === 401) return "Discord rejected the webhook token (401 Unauthorized).";
  if (status === 404) return "Discord could not find that webhook (404). It may have been deleted.";
  if (status === 400) {
    return hasBody
      ? "Discord rejected the payload (400) with a non-standard error."
      : "Discord rejected the payload (400) with an empty response body.";
  }
  return `Discord returned an unexpected ${status} response.`;
}

/**
 * Walk Discord's nested validation-error tree and produce flat, human-readable
 * lines. The wire shape interleaves object keys and array indices with
 * `_errors` arrays at the leaves, e.g.
 *
 *   { components: { 0: { components: { 1: { custom_id: {
 *       _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }]
 *   } } } } } }
 *
 * becomes `components[0].components[1].custom_id: This field is required`.
 */
function flattenDiscordErrors(errors: unknown, path = ""): string[] {
  if (!errors || typeof errors !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
    if (key === "_errors") {
      if (Array.isArray(value)) {
        for (const item of value) {
          const msg =
            item && typeof item === "object" && typeof (item as { message?: unknown }).message === "string"
              ? (item as { message: string }).message
              : String(item);
          out.push(path ? `${path}: ${msg}` : msg);
        }
      }
      continue;
    }
    // Numeric keys are array indices; everything else is an object field.
    const nextPath = /^\d+$/.test(key)
      ? `${path}[${key}]`
      : path
        ? `${path}.${key}`
        : key;
    out.push(...flattenDiscordErrors(value, nextPath));
  }
  return out;
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
 *
 * Discord's response includes a numeric `flags`; if `SUPPRESS_NOTIFICATIONS`
 * is on we lift it back to the editor's `suppress_notifications` boolean so
 * the toggle reflects the live state.
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
    // Lift the suppress_notifications bit out of the response's flags so the
    // restored message preserves the silent-send state.
    if (body && typeof body === "object" && "flags" in body) {
      const flags = Number((body as { flags?: unknown }).flags);
      if (Number.isFinite(flags) && (flags & MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS) !== 0) {
        message.suppress_notifications = true;
      }
    }
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

  const prepared = prepareBody(message);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "PATCH",
      headers: prepared.headers,
      body: prepared.body,
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
