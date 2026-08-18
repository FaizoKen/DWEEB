/**
 * MCP server configuration, read once from the process environment.
 *
 * Everything the server needs to reach the outside world is declared here:
 * which webhooks it may post through, which DWEEB deployment its share links
 * point at, and whether outward-mutating tools are available at all.
 *
 * Two rules, both borrowed from the proxy's `config.rs` because they were
 * learned the hard way there:
 *
 *  1. **Every value is trimmed.** An untrimmed `DWEEB_MCP_READ_ONLY=true ` that
 *     silently parsed as `false` would switch off the one guard standing
 *     between a model and a live Discord channel.
 *  2. **A present-but-unparseable value is a boot error, never a fall back to
 *     the default.** `parseBool` accepts only the eight documented spellings;
 *     anything else throws. A misconfigured server must refuse to start rather
 *     than start with permissions the operator did not grant.
 *
 * `loadConfig` is pure — it takes the environment as an argument — so the tests
 * exercise every branch without touching `process.env`.
 */

import { parseWebhookUrl } from "@/core/webhook/send";

/** Default DWEEB deployment share links are built against. */
export const DEFAULT_APP_URL = "https://dweeb.faizo.net";

/** Default proxy origin used for short links (`…/s/<id>`). */
export const DEFAULT_PROXY_URL = "https://api.dweeb.faizo.net";

/** Alias given to `DWEEB_WEBHOOK_URL`, the single-webhook shorthand. */
export const DEFAULT_WEBHOOK_ALIAS = "default";

/** Per-request deadline for every outbound HTTP call the tools make. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface ConfiguredWebhook {
  /** Name the model refers to this destination by. Never the token. */
  alias: string;
  /** Canonical execute URL (query/fragment stripped by `parseWebhookUrl`). */
  url: string;
  /** Webhook snowflake — safe to show; the token half never is. */
  id: string;
}

export interface Config {
  /** Web app origin share links are built against, no trailing slash. */
  appUrl: string;
  /** Proxy origin for short links; empty string disables them. */
  proxyUrl: string;
  /** Destinations by alias, in declaration order. */
  webhooks: ConfiguredWebhook[];
  /** When true, no tool may change anything on Discord or publish a message. */
  readOnly: boolean;
  /** Deadline applied to each outbound request. */
  timeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string {
  return (env[key] ?? "").trim();
}

/**
 * Strict boolean parser — mirrors the proxy's `parse_bool`. Only the eight
 * documented spellings are accepted; anything else is a configuration error
 * rather than a silent `false`.
 */
export function parseBool(raw: string, key: string): boolean {
  switch (raw.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new ConfigError(
        `${key} must be one of 1/true/yes/on or 0/false/no/off — got ${JSON.stringify(raw)}.`,
      );
  }
}

function parseOrigin(raw: string, key: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${key} must be an absolute http(s) URL — got ${JSON.stringify(raw)}.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${key} must be an http(s) URL — got ${JSON.stringify(raw)}.`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Aliases are what the model types, so they stay boring on purpose: letters,
 * digits, dash, underscore. That also keeps them safe to interpolate into an
 * error message or a tool description without escaping.
 */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function addWebhook(
  into: ConfiguredWebhook[],
  alias: string,
  rawUrl: string,
  source: string,
): void {
  if (!ALIAS_RE.test(alias)) {
    throw new ConfigError(
      `${source}: ${JSON.stringify(alias)} is not a usable webhook name — use 1-32 characters of A-Z, a-z, 0-9, "-" or "_".`,
    );
  }
  const parsed = parseWebhookUrl(rawUrl);
  if (!parsed) {
    // Deliberately does not echo the value: it is a credential, and this
    // message may be surfaced by the client that failed to start us.
    throw new ConfigError(
      `${source}: the URL for ${JSON.stringify(alias)} is not a Discord webhook URL ` +
        "(expected https://discord.com/api/webhooks/<id>/<token>).",
    );
  }
  if (into.some((w) => w.alias === alias)) {
    throw new ConfigError(`${source}: duplicate webhook name ${JSON.stringify(alias)}.`);
  }
  into.push({ alias, url: parsed.url, id: parsed.id });
}

function parseWebhookMap(raw: string): Array<[string, string]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      "DWEEB_WEBHOOKS must be a JSON object of " +
        '{"name": "https://discord.com/api/webhooks/…"} pairs.',
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(
      'DWEEB_WEBHOOKS must be a JSON object, e.g. {"announcements": "https://…"}.',
    );
  }
  return Object.entries(parsed as Record<string, unknown>).map(([alias, value]) => {
    if (typeof value !== "string") {
      throw new ConfigError(
        `DWEEB_WEBHOOKS: the value for ${JSON.stringify(alias)} must be a string URL.`,
      );
    }
    return [alias, value.trim()];
  });
}

/**
 * `DWEEB_PROXY_URL` set but blank is a real choice — it turns short links off,
 * leaving the server unable to reach any DWEEB backend at all. Unset keeps the
 * public default, which is what the deployed web app itself uses.
 */
function proxyDefault(env: Env): string {
  return env.DWEEB_PROXY_URL === undefined ? DEFAULT_PROXY_URL : "";
}

/**
 * Build the server config from an environment. Throws `ConfigError` on any
 * value that is present but unusable.
 */
export function loadConfig(env: Env): Config {
  const appRaw = read(env, "DWEEB_APP_URL");
  const proxyRaw = read(env, "DWEEB_PROXY_URL");
  const readOnlyRaw = read(env, "DWEEB_MCP_READ_ONLY");
  const timeoutRaw = read(env, "DWEEB_MCP_TIMEOUT_MS");

  const webhooks: ConfiguredWebhook[] = [];
  const single = read(env, "DWEEB_WEBHOOK_URL");
  if (single) addWebhook(webhooks, DEFAULT_WEBHOOK_ALIAS, single, "DWEEB_WEBHOOK_URL");
  const many = read(env, "DWEEB_WEBHOOKS");
  if (many) {
    for (const [alias, url] of parseWebhookMap(many)) {
      addWebhook(webhooks, alias, url, "DWEEB_WEBHOOKS");
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutRaw) {
    const n = Number(timeoutRaw);
    if (!Number.isInteger(n) || n < 1000 || n > 120_000) {
      throw new ConfigError(
        "DWEEB_MCP_TIMEOUT_MS must be a whole number of milliseconds between 1000 and 120000 — " +
          `got ${JSON.stringify(timeoutRaw)}.`,
      );
    }
    timeoutMs = n;
  }

  return {
    appUrl: appRaw ? parseOrigin(appRaw, "DWEEB_APP_URL") : DEFAULT_APP_URL,
    proxyUrl: proxyRaw ? parseOrigin(proxyRaw, "DWEEB_PROXY_URL") : proxyDefault(env),
    webhooks,
    readOnly: readOnlyRaw ? parseBool(readOnlyRaw, "DWEEB_MCP_READ_ONLY") : false,
    timeoutMs,
  };
}

/**
 * Look up a destination by alias. With no alias the sole configured webhook
 * wins when there is exactly one; otherwise the caller must name one, so a
 * server holding several channels can never post to the wrong one by default.
 */
export function findWebhook(config: Config, alias?: string): ConfiguredWebhook | null {
  if (!alias) {
    if (config.webhooks.length === 1) return config.webhooks[0]!;
    return config.webhooks.find((w) => w.alias === DEFAULT_WEBHOOK_ALIAS) ?? null;
  }
  return config.webhooks.find((w) => w.alias === alias) ?? null;
}
