/**
 * The tools this server exposes, and everything they do.
 *
 * A tool definition carries its own JSON Schema, its own annotations, and its
 * own handler; the protocol layer (`protocol.ts`) knows nothing about any
 * individual tool, and the handlers know nothing about JSON-RPC. That split is
 * what lets the whole tool surface be tested directly — `tools.test.ts` calls
 * these handlers with plain objects, no transport involved.
 *
 * Three conventions hold across every tool:
 *
 *  1. **Arguments are validated against the published `inputSchema`** by the
 *     shared checker, so what a tool advertises and what it enforces cannot
 *     drift apart.
 *  2. **Every result carries `ok`.** Both success and failure conform to the
 *     declared `outputSchema`, so a client that validates structured output
 *     never chokes on an error result.
 *  3. **Failure is data, not an exception.** A Discord rejection, an invalid
 *     payload, or a missing destination comes back as `isError: true` with the
 *     reason in the text, because the model reading it is the one who can fix
 *     it. Only a bug throws.
 */

import { LIMITS } from "@/core/schema/limits";
import { collectSearchText } from "@/core/schema/traversal";
import { TEMPLATE_CATEGORIES, TEMPLATES, type MessageTemplate } from "@/data/presets";
import { encodeShare } from "@/core/serialization/encode";
import { attachEditorFields } from "@/core/serialization/normalize";
import { parseMessageIdInput, type ParsedWebhookUrl } from "@/core/webhook/send";
import type { WebhookMessage } from "@/core/schema/types";

import { findWebhook, type Config, type ConfiguredWebhook } from "./config";
import {
  deleteMessage,
  fetchMessage,
  messageLink,
  send,
  update,
  verify,
  describeWebhook,
  WebhookInfoCache,
} from "./discord";
import { authoringGuide, limitsTable } from "./guide";
import { validateAgainstSchema, withDefaults, type JsonSchema } from "./jsonschema";
import { redact } from "./redact";
import { renderOutline } from "./render";
import { reportMessage, resolveMessage, toWire, type MessageReport } from "./message";

export interface ToolContext {
  config: Config;
  webhookInfo: WebhookInfoCache;
  /** Injected so the tests can drive the non-Discord calls (short links)
   *  without touching the network. Discord itself goes through the app's own
   *  client, which uses the global `fetch`. */
  fetchImpl: typeof fetch;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: ToolAnnotations;
  /**
   * True when the tool changes something on Discord. These are withheld
   * entirely — not just refused — when the server runs read-only, so a model
   * cannot plan around a capability that is not there.
   */
  mutates?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/* ─── Result helpers ─────────────────────────────────────────────────── */

function result(text: string, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, ...structured },
  };
}

function failure(text: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: false, error: text, ...extra },
    isError: true,
  };
}

/** `ok` plus a free-text `error`, present on every tool's output schema so a
 *  failure result validates against it exactly as a success does. */
const ENVELOPE: Record<string, JsonSchema> = {
  ok: { type: "boolean", description: "False when the call failed; `error` then says why." },
  error: { type: "string", description: "Why the call failed. Absent on success." },
};

function output(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties: { ...ENVELOPE, ...properties }, required: ["ok"] };
}

/* ─── Shared argument fragments ──────────────────────────────────────── */

const MESSAGE_ARG: JsonSchema = {
  type: ["object", "string"],
  description:
    "The Components V2 message. Either the payload object itself, or a string holding its JSON, " +
    "a DWEEB share link (https://…/#s=<token> or https://…/s/<id>), or a bare share token.",
};

const WEBHOOK_ARG: JsonSchema = {
  type: "string",
  description:
    "Name of the configured destination to use (see `list_webhooks`). Optional when only one is configured.",
};

const THREAD_ARG: JsonSchema = {
  type: "string",
  description:
    "Snowflake of an existing thread to act in. Omit for the webhook's own channel. Not the same as a forum post title, which belongs on the message as `thread_name`.",
};

const MESSAGE_ID_ARG: JsonSchema = {
  type: "string",
  description:
    "The message: its snowflake, or a Discord message link (https://discord.com/channels/…). Only messages this webhook posted can be read, edited, or deleted.",
};

const REPORT_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "What Discord would reject, what it would ignore, and what the destination must provide.",
  properties: {
    ok: { type: "boolean" },
    errors: { type: "array", items: { type: "object" } },
    warnings: { type: "array", items: { type: "object" } },
    requirements: { type: "array", items: { type: "object" } },
    stats: { type: "object" },
  },
};

/* ─── Shared handler steps ───────────────────────────────────────────── */

interface Destination {
  webhook: ConfiguredWebhook;
  parsed: ParsedWebhookUrl;
}

/**
 * Resolve the destination the caller named. Aliases exist so the webhook URL —
 * which is a bearer credential — never has to travel through the model's
 * context to reach us.
 */
function destination(ctx: ToolContext, alias: unknown): Destination | string {
  const config = ctx.config;
  if (config.webhooks.length === 0) {
    return (
      "No Discord destination is configured. Set DWEEB_WEBHOOK_URL (one webhook) or DWEEB_WEBHOOKS " +
      '(a JSON object of {"name": "url"} pairs) in this server\'s environment and restart it.'
    );
  }
  const name = typeof alias === "string" && alias.trim() ? alias.trim() : undefined;
  const found = findWebhook(config, name);
  if (found) return { webhook: found, parsed: { id: found.id, url: found.url } };
  const known = config.webhooks.map((w) => w.alias).join(", ");
  return name
    ? `No destination named ${JSON.stringify(name)}. Configured: ${known}.`
    : `Several destinations are configured — name one with \`webhook\`. Configured: ${known}.`;
}

/** Render a validation report as the lines a model can act on. */
function reportText(report: MessageReport): string {
  const lines: string[] = [];
  const { stats } = report;
  lines.push(
    `${report.ok ? "Valid" : "Invalid"} · ${stats.top_level_components}/${LIMITS.TOP_LEVEL_COMPONENTS} top-level · ` +
      `${stats.total_components}/${LIMITS.TOTAL_COMPONENTS} components · ` +
      `${stats.characters}/${LIMITS.TOTAL_CHARACTERS} characters`,
  );
  const list = (issues: MessageReport["errors"]): string[] =>
    issues.map((issue) => {
      const at = issue.path
        ? ` at ${issue.path}${issue.component ? ` (${issue.component})` : ""}`
        : "";
      return `  • [${issue.code}]${at}: ${issue.message}`;
    });
  if (report.errors.length > 0) {
    lines.push("", `Discord would reject this message (${report.errors.length}):`);
    lines.push(...list(report.errors));
  }
  if (report.warnings.length > 0) {
    lines.push("", `Accepted, but Discord ignores or degrades these (${report.warnings.length}):`);
    lines.push(...list(report.warnings));
  }
  if (report.requirements.length > 0) {
    lines.push("", "The destination has to provide:");
    for (const need of report.requirements) lines.push(`  • ${need.title} — ${need.detail}`);
  }
  return lines.join("\n");
}

function wireJson(message: WebhookMessage): string {
  return JSON.stringify(toWire(message), null, 2);
}

/** Pull the created/updated message's ids out of Discord's response body. */
function messageIds(body: unknown): { id: string | null; channelId: string | null } {
  if (!body || typeof body !== "object") return { id: null, channelId: null };
  const object = body as Record<string, unknown>;
  return {
    id: typeof object.id === "string" ? object.id : null,
    channelId: typeof object.channel_id === "string" ? object.channel_id : null,
  };
}

/* ─── Tools ──────────────────────────────────────────────────────────── */

const describeSchemaTool: ToolDefinition = {
  name: "describe_schema",
  title: "Components V2 authoring guide",
  description:
    "The rules for building a Discord Components V2 message: every component type and its fields, " +
    "the hard limits, and the mistakes Discord rejects the whole message for. Read this before " +
    "writing a message by hand. Needs no network and no configuration.",
  inputSchema: {
    type: "object",
    properties: {
      section: {
        type: "string",
        enum: ["all", "guide", "limits"],
        default: "all",
        description: "`guide` for the prose, `limits` for just the numeric caps, `all` for both.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: output({
    guide: { type: "string" },
    limits: { type: "object" },
  }),
  annotations: {
    title: "Components V2 authoring guide",
    readOnlyHint: true,
    openWorldHint: false,
  },
  run: async (args) => {
    const section = args.section as string;
    const guide = authoringGuide();
    const limits = limitsTable();
    const limitLines = Object.entries(limits)
      .map(([key, value]) => `  ${key} = ${value}`)
      .join("\n");
    if (section === "guide") return result(guide, { guide });
    if (section === "limits") {
      return result(`Discord limits DWEEB enforces:\n${limitLines}`, { limits });
    }
    return result(`${guide}\n\n## Limits, as data\n${limitLines}`, { guide, limits });
  },
};

function templateSummary(template: MessageTemplate): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    emoji: template.emoji,
    category: template.category,
    tags: template.tags ?? [],
    interactive: template.requiresBot === true,
    pairs_with: template.pairsWith ?? null,
  };
}

const listTemplatesTool: ToolDefinition = {
  name: "list_templates",
  title: "List built-in templates",
  description:
    "DWEEB's built-in message templates — complete, valid Components V2 messages for common jobs " +
    "(welcome, announcement, rules, tickets, giveaway, role pickers…). Starting from one is faster " +
    "and safer than writing a message from scratch. Fetch the payload with `get_template`.",
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: [...TEMPLATE_CATEGORIES],
        description: "Restrict to one gallery section.",
      },
      search: {
        type: "string",
        description: "Match against name, description, tags, and the template's own message text.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: output({
    templates: { type: "array", items: { type: "object" } },
    count: { type: "integer" },
  }),
  annotations: { title: "List built-in templates", readOnlyHint: true, openWorldHint: false },
  run: async (args) => {
    const category = typeof args.category === "string" ? args.category : null;
    const search = typeof args.search === "string" ? args.search.trim().toLowerCase() : "";
    const matches = TEMPLATES.filter((template) => {
      if (category && template.category !== category) return false;
      if (!search) return true;
      const haystack = [
        template.id,
        template.name,
        template.description,
        template.category,
        ...(template.tags ?? []),
        collectSearchText(template.message),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });
    const templates = matches.map(templateSummary);
    const lines = matches.map(
      (t) =>
        `${t.emoji} ${t.id} — ${t.name} (${t.category})${t.requiresBot ? " · interactive" : ""}\n    ${t.description}`,
    );
    const head =
      matches.length === 0
        ? "No template matches."
        : `${matches.length} template${matches.length === 1 ? "" : "s"}:`;
    return result([head, ...lines].join("\n"), { templates, count: templates.length });
  },
};

const getTemplateTool: ToolDefinition = {
  name: "get_template",
  title: "Get a template's message",
  description:
    "The full Components V2 payload behind one template, ready to edit and send. Returns the JSON, " +
    "an outline of how it renders, and its validation report.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: 'Template id from `list_templates` (e.g. "welcome").' },
    },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: output({
    template: { type: "object" },
    message: { type: "object" },
    outline: { type: "string" },
    report: REPORT_SCHEMA,
  }),
  annotations: { title: "Get a template's message", readOnlyHint: true, openWorldHint: false },
  run: async (args) => {
    const id = String(args.id);
    const template = TEMPLATES.find((t) => t.id === id);
    if (!template) {
      const names = TEMPLATES.map((t) => t.id).join(", ");
      return failure(`No template with id ${JSON.stringify(id)}. Available: ${names}.`);
    }
    // Templates carry editor ids already; round-tripping through the wire form
    // hands back exactly what the tools accept, with fresh ids.
    const message = attachEditorFields(toWire(template.message));
    const report = reportMessage(message);
    const outline = renderOutline(message);
    const json = wireJson(message);
    return result(
      `${template.emoji} ${template.name} — ${template.description}\n\n${outline}\n\n${reportText(report)}\n\nPayload:\n${json}`,
      {
        template: templateSummary(template),
        message: toWire(message),
        outline,
        report: report as unknown as Record<string, unknown>,
      },
    );
  },
};

const validateMessageTool: ToolDefinition = {
  name: "validate_message",
  title: "Validate a message",
  description:
    "Run Discord's rules over a message before Discord does. Reports every problem that would make " +
    "Discord reject the whole message, every setting it would silently ignore, and what the " +
    "destination has to be for the message to work — each named by its path in the payload.",
  inputSchema: {
    type: "object",
    properties: { message: MESSAGE_ARG, thread_id: THREAD_ARG },
    required: ["message"],
    additionalProperties: false,
  },
  outputSchema: output({ report: REPORT_SCHEMA, source: { type: "string" } }),
  annotations: { title: "Validate a message", readOnlyHint: true, openWorldHint: false },
  run: async (args, ctx) => {
    const resolved = await resolveMessage(args.message, ctx.config, ctx.fetchImpl);
    if (!resolved.ok) return failure(resolved.error);
    const report = reportMessage(resolved.value.message, typeof args.thread_id === "string");
    return result(reportText(report), {
      report: report as unknown as Record<string, unknown>,
      source: resolved.value.source,
    });
  },
};

const previewMessageTool: ToolDefinition = {
  name: "preview_message",
  title: "Preview a message",
  description:
    "Re-state a message as the layout a reader sees: one line per component, indented by nesting, " +
    "with the text, media, and each button's target inline. The fastest way to catch a component " +
    "nested in the wrong place. For a real visual preview, use `create_share_link`.",
  inputSchema: {
    type: "object",
    properties: { message: MESSAGE_ARG },
    required: ["message"],
    additionalProperties: false,
  },
  outputSchema: output({ outline: { type: "string" }, stats: { type: "object" } }),
  annotations: { title: "Preview a message", readOnlyHint: true, openWorldHint: false },
  run: async (args, ctx) => {
    const resolved = await resolveMessage(args.message, ctx.config, ctx.fetchImpl);
    if (!resolved.ok) return failure(resolved.error);
    const report = reportMessage(resolved.value.message);
    const outline = renderOutline(resolved.value.message);
    return result(outline, { outline, stats: report.stats as unknown as Record<string, unknown> });
  },
};

const createShareLinkTool: ToolDefinition = {
  name: "create_share_link",
  title: "Create a DWEEB share link",
  description:
    "Turn a message into a link that opens it in DWEEB's visual editor. This is how a human reviews " +
    "what you built — prefer handing over the link to describing the message in prose. By default " +
    "the whole message is encoded into the URL fragment and nothing is uploaded anywhere; pass " +
    "`short: true` to store it on the DWEEB proxy for 7 days and get a short URL instead.",
  inputSchema: {
    type: "object",
    properties: {
      message: MESSAGE_ARG,
      short: {
        type: "boolean",
        default: false,
        description:
          "Upload the token to the DWEEB proxy and return a short `…/s/<id>` URL. The message leaves this machine; the default does not.",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
  outputSchema: output({
    url: { type: "string" },
    token: { type: "string" },
    token_length: { type: "integer" },
    short_url: { type: "string" },
  }),
  annotations: {
    // Not read-only, even though the default path uploads nothing: `short: true`
    // stores the message on the proxy, and an annotation a client uses to decide
    // what to auto-approve has to describe what the tool *can* do, not what it
    // usually does. It is still not `mutates` — nothing on Discord changes, and
    // read-only mode keeps the local half of the tool rather than withholding it.
    title: "Create a DWEEB share link",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  run: async (args, ctx) => {
    const resolved = await resolveMessage(args.message, ctx.config, ctx.fetchImpl);
    if (!resolved.ok) return failure(resolved.error);
    const token = encodeShare(resolved.value.message);
    const url = `${ctx.config.appUrl}/#s=${token}`;
    const wantsShort = args.short === true;

    if (!wantsShort) {
      const note =
        token.length > 8_000
          ? "\n\nThis link is long enough that some chat clients will break it — pass `short: true` for a compact one."
          : "";
      return result(
        `Open in DWEEB:\n${url}${note}\n\nThe message travels inside the URL fragment, so it is never sent to any server.`,
        { url, token, token_length: token.length },
      );
    }

    if (ctx.config.readOnly) {
      return failure(
        "This server runs read-only, so it will not upload the message anywhere. Drop `short` to get the local link, which encodes the message in the URL itself.",
      );
    }
    if (!ctx.config.proxyUrl) {
      return failure(
        "Short links need a DWEEB proxy — set DWEEB_PROXY_URL, or drop `short` to get the local link.",
      );
    }
    let res: Response;
    try {
      res = await ctx.fetchImpl(`${ctx.config.proxyUrl}/api/shortlink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(ctx.config.timeoutMs),
      });
    } catch (e) {
      return failure(`Couldn't reach the short-link service: ${(e as Error).message}`);
    }
    const data = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
    if (!res.ok || !data?.id) {
      return failure(data?.error ?? `The short-link service answered ${res.status}.`);
    }
    const shortUrl = `${ctx.config.appUrl}/s/${data.id}`;
    return result(
      `Open in DWEEB:\n${shortUrl}\n\nStored on the DWEEB proxy for 7 days, then deleted. The full link, which uploads nothing, is:\n${url}`,
      { url, token, token_length: token.length, short_url: shortUrl },
    );
  },
};

const readShareLinkTool: ToolDefinition = {
  name: "read_share_link",
  title: "Read a DWEEB share link",
  description:
    "Decode a DWEEB share link back into its message, so you can continue from something a human " +
    "built in the visual editor. Accepts a full link, a short `…/s/<id>` link, or a bare share token.",
  inputSchema: {
    type: "object",
    properties: {
      link: {
        type: "string",
        description: "The share link, short link, or token.",
      },
    },
    required: ["link"],
    additionalProperties: false,
  },
  outputSchema: output({
    message: { type: "object" },
    outline: { type: "string" },
    report: REPORT_SCHEMA,
    source: { type: "string" },
  }),
  annotations: { title: "Read a DWEEB share link", readOnlyHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const resolved = await resolveMessage(args.link, ctx.config, ctx.fetchImpl);
    if (!resolved.ok) return failure(resolved.error);
    const { message, source } = resolved.value;
    const report = reportMessage(message);
    const outline = renderOutline(message);
    return result(`${outline}\n\n${reportText(report)}\n\nPayload:\n${wireJson(message)}`, {
      message: toWire(message),
      outline,
      report: report as unknown as Record<string, unknown>,
      source,
    });
  },
};

const listWebhooksTool: ToolDefinition = {
  name: "list_webhooks",
  title: "List configured destinations",
  description:
    "The Discord destinations this server may post to, by name. The webhook URLs themselves are a " +
    "credential and are never returned — refer to a destination by its name in the other tools.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: output({
    webhooks: { type: "array", items: { type: "object" } },
    read_only: { type: "boolean" },
  }),
  annotations: { title: "List configured destinations", readOnlyHint: true, openWorldHint: false },
  run: async (_args, ctx) => {
    const webhooks = ctx.config.webhooks.map((w) => {
      const info = ctx.webhookInfo.get(w.id);
      return {
        name: w.alias,
        webhook_id: w.id,
        channel_id: info?.channel_id ?? null,
        guild_id: info?.guild_id ?? null,
        webhook_name: info?.name ?? null,
      };
    });
    const lines = webhooks.map(
      (w) => `  ${w.name} — webhook ${w.webhook_id}${w.webhook_name ? ` (${w.webhook_name})` : ""}`,
    );
    const head =
      webhooks.length === 0
        ? "No destination is configured. Set DWEEB_WEBHOOK_URL or DWEEB_WEBHOOKS and restart this server."
        : `${webhooks.length} destination${webhooks.length === 1 ? "" : "s"}:`;
    const mode = ctx.config.readOnly
      ? "\n\nThis server runs read-only: it can build, validate, and share messages, but not post them."
      : "";
    return result(`${head}\n${lines.join("\n")}${mode}`, {
      webhooks,
      read_only: ctx.config.readOnly,
    });
  },
};

const inspectWebhookTool: ToolDefinition = {
  name: "inspect_webhook",
  title: "Inspect a destination",
  description:
    "Ask Discord about a destination without posting anything: its name, channel, server, and — the " +
    "part that decides whether buttons work — who owns it. Interactive components only ever respond " +
    "when the webhook belongs to an application; on a webhook a person created in Server Settings, " +
    "buttons render but every click goes nowhere.",
  inputSchema: {
    type: "object",
    properties: { webhook: WEBHOOK_ARG },
    additionalProperties: false,
  },
  outputSchema: output({ webhook: { type: "object" } }),
  annotations: { title: "Inspect a destination", readOnlyHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const dest = destination(ctx, args.webhook);
    if (typeof dest === "string") return failure(dest);
    const verified = await verify(dest.parsed, { timeoutMs: ctx.config.timeoutMs });
    if (!verified.ok) return failure(`Discord refused the destination: ${verified.error}`);
    const info = describeWebhook(dest.parsed.id, verified.webhook);
    ctx.webhookInfo.set(info);
    const lines = [
      `${dest.webhook.alias} — ${info.name ?? "(unnamed webhook)"}`,
      `  webhook id: ${info.id}`,
      `  channel:    ${info.channel_id ?? "unknown"}`,
      `  server:     ${info.guild_id ?? "unknown"}`,
      `  owner:      ${info.owner.badge} — ${info.owner.label}`,
      info.owner.kind === "bot"
        ? "  Interactive buttons and menus can work here (an application owns this webhook)."
        : "  Interactive buttons and menus will NOT respond here — link buttons and static content only.",
    ];
    return result(lines.join("\n"), { webhook: info as unknown as Record<string, unknown> });
  },
};

const sendMessageTool: ToolDefinition = {
  name: "send_message",
  title: "Post a message to Discord",
  description:
    "Post a message to a configured Discord destination. It is validated first and refused outright " +
    "if Discord would reject it, so a failure here costs nothing. Returns the new message's id and a " +
    "link to it — keep the id to edit or delete the message later. This is visible to everyone in the " +
    "channel the moment it succeeds.",
  inputSchema: {
    type: "object",
    properties: { message: MESSAGE_ARG, webhook: WEBHOOK_ARG, thread_id: THREAD_ARG },
    required: ["message"],
    additionalProperties: false,
  },
  outputSchema: output({
    message_id: { type: "string" },
    channel_id: { type: "string" },
    link: { type: "string" },
    report: REPORT_SCHEMA,
  }),
  annotations: {
    title: "Post a message to Discord",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  mutates: true,
  run: async (args, ctx) => {
    const dest = destination(ctx, args.webhook);
    if (typeof dest === "string") return failure(dest);
    const resolved = await resolveMessage(args.message, ctx.config, ctx.fetchImpl);
    if (!resolved.ok) return failure(resolved.error);
    const message = resolved.value.message;
    const threadId = typeof args.thread_id === "string" ? args.thread_id : undefined;
    const report = reportMessage(message, Boolean(threadId));
    if (!report.ok) {
      return failure(`Not posted — Discord would reject this message.\n\n${reportText(report)}`, {
        report: report as unknown as Record<string, unknown>,
      });
    }

    const sent = await send(dest.parsed, message, {
      timeoutMs: ctx.config.timeoutMs,
      threadId,
    });
    if (!sent.ok) {
      return failure(`Discord refused the message (${sent.status}): ${sent.error}`);
    }

    const ids = messageIds(sent.body);
    // Best-effort: the jump link needs the webhook's guild, which costs one
    // cached lookup. A failure here must never turn a delivered message into a
    // reported failure.
    const info = await ctx.webhookInfo
      .resolve(dest.parsed, { timeoutMs: ctx.config.timeoutMs })
      .catch(() => null);
    const channelId = ids.channelId ?? info?.channel_id ?? null;
    const link = ids.id ? messageLink(info?.guild_id ?? null, channelId, ids.id) : null;

    const lines = [`Posted to ${dest.webhook.alias}.`];
    if (ids.id) lines.push(`  message id: ${ids.id}`);
    if (link) lines.push(`  link:       ${link}`);
    if (report.warnings.length > 0 || report.requirements.length > 0) {
      lines.push("", reportText(report));
    }
    const structured: Record<string, unknown> = {
      report: report as unknown as Record<string, unknown>,
    };
    if (ids.id) structured.message_id = ids.id;
    if (channelId) structured.channel_id = channelId;
    if (link) structured.link = link;
    return result(lines.join("\n"), structured);
  },
};

const fetchMessageTool: ToolDefinition = {
  name: "fetch_message",
  title: "Read a posted message",
  description:
    "Read back a message this destination posted, as an editable Components V2 payload. Use it to " +
    "change a live message: fetch, edit the payload, then `update_message`.",
  inputSchema: {
    type: "object",
    properties: { message_id: MESSAGE_ID_ARG, webhook: WEBHOOK_ARG, thread_id: THREAD_ARG },
    required: ["message_id"],
    additionalProperties: false,
  },
  outputSchema: output({
    message: { type: "object" },
    outline: { type: "string" },
    report: REPORT_SCHEMA,
    message_id: { type: "string" },
  }),
  annotations: { title: "Read a posted message", readOnlyHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const dest = destination(ctx, args.webhook);
    if (typeof dest === "string") return failure(dest);
    const messageId = parseMessageIdInput(String(args.message_id));
    if (!messageId) {
      return failure(
        "`message_id` must be a message snowflake or a Discord message link (https://discord.com/channels/…).",
      );
    }
    const fetched = await fetchMessage(dest.parsed, messageId, {
      timeoutMs: ctx.config.timeoutMs,
      threadId: typeof args.thread_id === "string" ? args.thread_id : undefined,
    });
    if (!fetched.ok)
      return failure(`Discord refused the read (${fetched.status}): ${fetched.error}`);
    const report = reportMessage(fetched.message);
    const outline = renderOutline(fetched.message);
    return result(`${outline}\n\nPayload:\n${wireJson(fetched.message)}`, {
      message: toWire(fetched.message),
      outline,
      report: report as unknown as Record<string, unknown>,
      message_id: messageId,
    });
  },
};

const updateMessageTool: ToolDefinition = {
  name: "update_message",
  title: "Replace a posted message",
  description:
    "Replace a message this destination posted with a new payload. The replacement is complete, not " +
    "merged: whatever you pass becomes the entire message, so fetch it first if you mean to keep part " +
    "of it. Validated before it is sent.",
  inputSchema: {
    type: "object",
    properties: {
      message_id: MESSAGE_ID_ARG,
      message: MESSAGE_ARG,
      webhook: WEBHOOK_ARG,
      thread_id: THREAD_ARG,
    },
    required: ["message_id", "message"],
    additionalProperties: false,
  },
  outputSchema: output({
    message_id: { type: "string" },
    link: { type: "string" },
    report: REPORT_SCHEMA,
  }),
  annotations: {
    title: "Replace a posted message",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  mutates: true,
  run: async (args, ctx) => {
    const dest = destination(ctx, args.webhook);
    if (typeof dest === "string") return failure(dest);
    const messageId = parseMessageIdInput(String(args.message_id));
    if (!messageId) {
      return failure(
        "`message_id` must be a message snowflake or a Discord message link (https://discord.com/channels/…).",
      );
    }
    const resolved = await resolveMessage(args.message, ctx.config, ctx.fetchImpl);
    if (!resolved.ok) return failure(resolved.error);
    const threadId = typeof args.thread_id === "string" ? args.thread_id : undefined;
    const report = reportMessage(resolved.value.message, Boolean(threadId));
    if (!report.ok) {
      return failure(`Not updated — Discord would reject this message.\n\n${reportText(report)}`, {
        report: report as unknown as Record<string, unknown>,
      });
    }
    const updated = await update(dest.parsed, messageId, resolved.value.message, {
      timeoutMs: ctx.config.timeoutMs,
      threadId,
    });
    if (!updated.ok) {
      return failure(`Discord refused the update (${updated.status}): ${updated.error}`);
    }
    const ids = messageIds(updated.body);
    const info = await ctx.webhookInfo
      .resolve(dest.parsed, { timeoutMs: ctx.config.timeoutMs })
      .catch(() => null);
    const link = messageLink(
      info?.guild_id ?? null,
      ids.channelId ?? info?.channel_id ?? null,
      messageId,
    );
    const lines = [`Updated message ${messageId} on ${dest.webhook.alias}.`];
    if (link) lines.push(`  link: ${link}`);
    if (report.warnings.length > 0 || report.requirements.length > 0) {
      lines.push("", reportText(report));
    }
    const structured: Record<string, unknown> = {
      message_id: messageId,
      report: report as unknown as Record<string, unknown>,
    };
    if (link) structured.link = link;
    return result(lines.join("\n"), structured);
  },
};

const deleteMessageTool: ToolDefinition = {
  name: "delete_message",
  title: "Delete a posted message",
  description:
    "Permanently delete a message this destination posted. There is no undo and no confirmation step — " +
    "ask the person you are working for before calling it.",
  inputSchema: {
    type: "object",
    properties: { message_id: MESSAGE_ID_ARG, webhook: WEBHOOK_ARG, thread_id: THREAD_ARG },
    required: ["message_id"],
    additionalProperties: false,
  },
  outputSchema: output({ message_id: { type: "string" } }),
  annotations: {
    title: "Delete a posted message",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  mutates: true,
  run: async (args, ctx) => {
    const dest = destination(ctx, args.webhook);
    if (typeof dest === "string") return failure(dest);
    const messageId = parseMessageIdInput(String(args.message_id));
    if (!messageId) {
      return failure(
        "`message_id` must be a message snowflake or a Discord message link (https://discord.com/channels/…).",
      );
    }
    const deleted = await deleteMessage(dest.parsed, messageId, {
      timeoutMs: ctx.config.timeoutMs,
      threadId: typeof args.thread_id === "string" ? args.thread_id : undefined,
    });
    if (!deleted.ok) {
      return failure(`Discord refused the delete (${deleted.status}): ${deleted.error}`);
    }
    return result(`Deleted message ${messageId} from ${dest.webhook.alias}.`, {
      message_id: messageId,
    });
  },
};

/** Every tool this server can offer, in the order they are listed. */
export const ALL_TOOLS: ToolDefinition[] = [
  describeSchemaTool,
  listTemplatesTool,
  getTemplateTool,
  validateMessageTool,
  previewMessageTool,
  createShareLinkTool,
  readShareLinkTool,
  listWebhooksTool,
  inspectWebhookTool,
  sendMessageTool,
  fetchMessageTool,
  updateMessageTool,
  deleteMessageTool,
];

/**
 * The tools available under a given config. Read-only mode withholds the
 * mutating ones entirely rather than refusing them at call time: a tool a
 * model can see is one it will plan around, and "I can post this for you"
 * followed by a refusal is a worse experience than never offering.
 */
export function availableTools(config: Config): ToolDefinition[] {
  return config.readOnly ? ALL_TOOLS.filter((tool) => !tool.mutates) : ALL_TOOLS;
}

/**
 * Validate arguments against a tool's published schema, run the tool, and scrub
 * the result.
 *
 * This is the single funnel every tool call passes through, which is exactly
 * why the credential scrub lives here rather than at the transport: a webhook
 * token can reach a result down dozens of paths — a URL the model put in a link
 * button, an error quoting the request — and a scrubber you have to remember to
 * call at each of them is one you will forget. See `redact.ts`.
 */
export async function callTool(
  tool: ToolDefinition,
  rawArgs: Record<string, unknown> | undefined,
  ctx: ToolContext,
): Promise<ToolResult> {
  const args = withDefaults(rawArgs ?? {}, tool.inputSchema);
  const errors = validateAgainstSchema(args, tool.inputSchema);
  if (errors.length > 0) {
    return scrubResult(
      failure(`Invalid arguments for ${tool.name}:\n${errors.map((e) => `  • ${e}`).join("\n")}`),
    );
  }
  try {
    return scrubResult(await tool.run(args, ctx));
  } catch (e) {
    // A throw here is a bug in this server, not a user error — say so plainly
    // rather than dressing it up as a Discord failure.
    return scrubResult(failure(`${tool.name} failed unexpectedly: ${(e as Error).message}`));
  }
}

function scrubResult(outcome: ToolResult): ToolResult {
  const scrubbed: ToolResult = {
    content: outcome.content.map((part) => ({ type: part.type, text: redact(part.text) })),
  };
  if (outcome.isError) scrubbed.isError = true;
  if (outcome.structuredContent) {
    scrubbed.structuredContent = scrubDeep(outcome.structuredContent) as Record<string, unknown>;
  }
  return scrubbed;
}

function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(child);
    }
    return out;
  }
  return value;
}
