/**
 * Webhook execution.
 *
 * Posts the current message directly to Discord from the browser. The webhook
 * execute endpoint accepts cross-origin requests, so no proxy is needed — the
 * call stays client-side and the webhook URL goes straight to Discord, never
 * through a DWEEB backend.
 *
 * The body Discord receives is the wire-format payload (from
 * `serialization/normalize.ts`) plus a `flags` integer combining
 * `IS_COMPONENTS_V2` and optionally `SUPPRESS_NOTIFICATIONS`. With the V2
 * flag set Discord rejects any payload that also includes `content` or
 * `embeds`, so the message-level fields we attach (`username`, `avatar_url`,
 * `tts`, `allowed_mentions`, `message_reference`, `thread_name`,
 * `applied_tags`) are the only extras allowed.
 */

import { type WebhookMessage } from "@/core/schema/types";
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
  const linkMatch = /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/\d+\/(\d{15,25})/i.exec(trimmed);
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
 * Build the JSON payload Discord expects on a Components V2 webhook execute.
 * `stripEditorFields` already emits the computed `flags` (always
 * `IS_COMPONENTS_V2`, plus `SUPPRESS_NOTIFICATIONS` when silent send is on),
 * so this is just the wire shape with editor ids dropped.
 */
export function buildWirePayload(message: WebhookMessage): Record<string, unknown> {
  return stripEditorFields(message) as Record<string, unknown>;
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
  // `payload` already carries the computed `flags` — collectSessionAttachments
  // builds it via stripEditorFields, which emits them.
  const enriched = payload;

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

  // Discord returns JSON for both success (wait=true) and structured errors.
  const body = await readBody(res);
  if (res.ok) return { ok: true, status: res.status, body };
  if (res.status === 429) {
    return {
      ok: false,
      status: 429,
      error: "Rate limited by Discord. Try again shortly.",
      retryAfter: retryAfterFrom(res, body),
      body,
    };
  }
  return { ok: false, status: res.status, error: describeError(res.status, body), body };
}

/**
 * Read and JSON-parse a response body, tolerating an empty body or a non-JSON
 * payload (returned as the raw string). Discord answers with JSON for both
 * success and structured errors, but an edge/proxy can occasionally hand back
 * plain text.
 */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Seconds Discord wants us to wait after a 429, preferring the `Retry-After`
 * header and falling back to the body's `retry_after`. Undefined when neither
 * is a finite number.
 */
function retryAfterFrom(res: Response, body: unknown): number | undefined {
  const header = res.headers.get("retry-after");
  const fromHeader = header ? Number.parseFloat(header) : NaN;
  const fromBody =
    body && typeof body === "object" && "retry_after" in body
      ? Number((body as { retry_after: unknown }).retry_after)
      : NaN;
  return Number.isFinite(fromHeader)
    ? fromHeader
    : Number.isFinite(fromBody)
      ? fromBody
      : undefined;
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
            item &&
            typeof item === "object" &&
            typeof (item as { message?: unknown }).message === "string"
              ? (item as { message: string }).message
              : String(item);
          out.push(path ? `${path}: ${msg}` : msg);
        }
      }
      continue;
    }
    // Numeric keys are array indices; everything else is an object field.
    const nextPath = /^\d+$/.test(key) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
    out.push(...flattenDiscordErrors(value, nextPath));
  }
  return out;
}

/* ─── Verify (GET webhook) ───────────────────────────────────────────── */

export interface VerifyOk {
  ok: true;
  status: number;
  /** The webhook object Discord returned (includes `name`, `channel_id`, …). */
  webhook: Record<string, unknown>;
}
export interface VerifyErr {
  ok: false;
  status: number;
  error: string;
  body?: unknown;
}
export type VerifyResult = VerifyOk | VerifyErr;

/**
 * Confirm a webhook actually exists before we store it. A GET on the execute
 * URL returns the webhook object when the id+token are valid, and 401/404 when
 * the token is wrong or the webhook was deleted — so it doubles as a "is this
 * URL real?" check without posting anything to the channel.
 */
export async function verifyWebhook(
  parsed: ParsedWebhookUrl,
  options: { signal?: AbortSignal } = {},
): Promise<VerifyResult> {
  let res: Response;
  try {
    res = await fetch(parsed.url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") {
      return { ok: false, status: 0, error: "Check was cancelled." };
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

  if (res.ok) {
    return {
      ok: true,
      status: res.status,
      webhook: body && typeof body === "object" ? (body as Record<string, unknown>) : {},
    };
  }
  return { ok: false, status: res.status, error: describeError(res.status, body), body };
}

/* ─── Owner classification ───────────────────────────────────────────── */

export type WebhookOwnerKind = "bot" | "user" | "follower" | "unknown";

export interface WebhookOwner {
  /** bot/app · person · channel-follower · couldn't tell. */
  kind: WebhookOwnerKind;
  /** The bot/OAuth2 application id when an app created it; null otherwise. */
  applicationId: string | null;
  /** Raw webhook `type` — 1 Incoming · 2 Channel Follower · 3 Application. */
  type: number | null;
  /** Short chip text, e.g. "Bot". */
  badge: string;
  /** One-line explanation for under the webhook name. */
  label: string;
}

export const OWNER_COPY: Record<WebhookOwnerKind, { badge: string; label: string }> = {
  bot: { badge: "Bot", label: "Created by a bot / app." },
  user: { badge: "User", label: "Created by a user in Server Settings." },
  follower: { badge: "Follower", label: "Channel-follower webhook (Channel Following)." },
  unknown: { badge: "?", label: "Couldn't determine who created this webhook." },
};

/**
 * Work out who owns a webhook from the object `verifyWebhook` returns — no
 * message is sent.
 *
 * Discord omits the `user` object on the token endpoint, so we can't name the
 * exact creator, but `application_id` reliably tells a bot from a human:
 *   - non-null → a bot/OAuth2 app created it
 *   - null     → a person made it in Server Settings (or it's a follower)
 */
export function classifyWebhookOwner(webhook: Record<string, unknown>): WebhookOwner {
  const applicationId =
    typeof webhook.application_id === "string" && webhook.application_id.length > 0
      ? webhook.application_id
      : null;
  const type = typeof webhook.type === "number" ? webhook.type : null;

  let kind: WebhookOwnerKind;
  if (applicationId) kind = "bot";
  else if (type === 1) kind = "user";
  else if (type === 2) kind = "follower";
  else kind = "unknown";

  return { kind, applicationId, type, ...OWNER_COPY[kind] };
}

/* ─── Component routing (which app receives the clicks) ──────────────── */

/**
 * Who receives the interactions fired by components on a message this webhook
 * posts. Discord delivers component clicks to the application that OWNS the
 * webhook, so components bound to DWEEB plugins (custom_ids the dispatcher
 * routes) only ever respond when that app is DWEEB itself, or a custom bot
 * whose interactions endpoint was pointed at the dispatcher when it was
 * registered. Only meaningful for bot-owned webhooks — person/follower
 * webhooks can't send interactive components at all (the ownership block).
 */
export type ComponentRouting =
  /** Owned by the DWEEB app itself — clicks reach the dispatcher. */
  | "dweeb"
  /** Owned by one of the guild's registered custom bots — clicks reach the
   *  dispatcher through the registrant's interactions endpoint. */
  | "custom-bot"
  /** Owned by an unrelated app — Discord delivers every click THERE, so
   *  plugin-bound components post fine but never respond. */
  | "foreign"
  /** Bot-owned, but the custom-bot registration couldn't be checked (signed
   *  out, no proxy, guild unknown, or the fetch failed). */
  | "unverified";

/**
 * Classify where a bot-owned webhook's component clicks end up. Pure — the
 * caller supplies the deployment's own app id and the guild's registered
 * custom-bot app ids (pass `null` when that list couldn't be fetched, which
 * degrades the verdict to "unverified" rather than guessing).
 */
export function classifyComponentRouting(opts: {
  /** The webhook's owning app (`classifyWebhookOwner(...).applicationId`). */
  applicationId: string;
  /** This deployment's own application id (`DISCORD_CLIENT_ID`). */
  dweebApplicationId: string;
  /** App ids registered as custom bots for the webhook's guild; null = unknown. */
  customBotIds: readonly string[] | null;
}): ComponentRouting {
  const { applicationId, dweebApplicationId, customBotIds } = opts;
  if (dweebApplicationId.length > 0 && applicationId === dweebApplicationId) return "dweeb";
  if (customBotIds === null) return "unverified";
  return customBotIds.includes(applicationId) ? "custom-bot" : "foreign";
}

/** Pull the avatar hash out of a webhook object; null when it has none. */
export function webhookAvatarHash(webhook: Record<string, unknown>): string | null {
  return typeof webhook.avatar === "string" && webhook.avatar.length > 0 ? webhook.avatar : null;
}

/**
 * Channel the webhook posts to, from a verified webhook object. Discord always
 * returns `channel_id` on the token GET; null only if the shape is unexpected.
 */
export function webhookChannelId(webhook: Record<string, unknown>): string | null {
  return typeof webhook.channel_id === "string" && webhook.channel_id.length > 0
    ? webhook.channel_id
    : null;
}

/**
 * Guild the webhook belongs to. Present for the usual incoming/app webhooks;
 * Discord may omit it for some webhook types, so this can legitimately be null.
 */
export function webhookGuildId(webhook: Record<string, unknown>): string | null {
  return typeof webhook.guild_id === "string" && webhook.guild_id.length > 0
    ? webhook.guild_id
    : null;
}

/**
 * CDN URL for a webhook's avatar. Discord serves webhook avatars under the
 * webhook id; a null hash means the webhook has no custom picture, so we fall
 * back to Discord's default avatar. Animated hashes (`a_…`) are served as gifs.
 */
export function webhookAvatarUrl(id: string, avatar: string | null | undefined, size = 64): string {
  if (!avatar) return "https://cdn.discordapp.com/embed/avatars/0.png";
  const ext = avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${id}/${avatar}.${ext}?size=${size}`;
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
    // attachEditorFields lifts the silent-send bit out of `flags` itself, so
    // the restored message preserves suppress_notifications.
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

  const body = await readBody(res);
  if (res.ok) return { ok: true, status: res.status, body };
  if (res.status === 429) {
    return {
      ok: false,
      status: 429,
      error: "Rate limited by Discord. Try again shortly.",
      retryAfter: retryAfterFrom(res, body),
      body,
    };
  }
  return { ok: false, status: res.status, error: describeError(res.status, body), body };
}

/* ─── Manage the webhook itself (token PATCH / DELETE) ───────────────── */

export interface ManageOk {
  ok: true;
  status: number;
  /** The webhook object Discord returns on a rename/avatar change; `{}` for a delete. */
  webhook: Record<string, unknown>;
}
export interface ManageErr {
  ok: false;
  status: number;
  error: string;
  /** Seconds to wait, when rate-limited (429). */
  retryAfter?: number;
  body?: unknown;
}
export type ManageResult = ManageOk | ManageErr;

/**
 * Rename a webhook and/or change its avatar on Discord. The token in the URL is
 * the credential, so this needs no Manage Webhooks permission and no bot in the
 * server — the same trust model as `verifyWebhook`.
 *
 * `name` (1–80 chars) renames it; `avatar` is an image data URI
 * (`data:image/png;base64,…`) to set a picture or `null` to clear it. Omit
 * either to leave it untouched. The token PATCH cannot move the webhook to a
 * different channel (`channel_id` is rejected) — that needs Manage Webhooks.
 */
export async function modifyWebhook(
  parsed: ParsedWebhookUrl,
  changes: { name?: string; avatar?: string | null },
  options: { signal?: AbortSignal } = {},
): Promise<ManageResult> {
  const payload: Record<string, unknown> = {};
  if (changes.name !== undefined) payload.name = changes.name;
  if (changes.avatar !== undefined) payload.avatar = changes.avatar;

  let res: Response;
  try {
    res = await fetch(parsed.url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

  const body = await readBody(res);
  if (res.ok) {
    return {
      ok: true,
      status: res.status,
      webhook: body && typeof body === "object" ? (body as Record<string, unknown>) : {},
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      status: 429,
      error: "Rate limited by Discord. Try again shortly.",
      retryAfter: retryAfterFrom(res, body),
      body,
    };
  }
  return { ok: false, status: res.status, error: describeError(res.status, body), body };
}

/**
 * Permanently delete a webhook on Discord via its token (no permission needed).
 * Discord answers 204; a 404/401 means it was already gone, which we still
 * report so the caller can drop its saved copy.
 */
export async function deleteWebhook(
  parsed: ParsedWebhookUrl,
  options: { signal?: AbortSignal } = {},
): Promise<ManageResult> {
  let res: Response;
  try {
    res = await fetch(parsed.url, { method: "DELETE", signal: options.signal });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") {
      return { ok: false, status: 0, error: "Delete was cancelled." };
    }
    return {
      ok: false,
      status: 0,
      error:
        "Network request failed. Check the URL, your connection, or any browser extensions blocking requests to discord.com.",
    };
  }

  if (res.status === 204) return { ok: true, status: 204, webhook: {} };

  const body = await readBody(res);
  if (res.status === 429) {
    return {
      ok: false,
      status: 429,
      error: "Rate limited by Discord. Try again shortly.",
      retryAfter: retryAfterFrom(res, body),
      body,
    };
  }
  return { ok: false, status: res.status, error: describeError(res.status, body), body };
}
