/**
 * The one way a message enters the server.
 *
 * Every tool that takes a message — validate, preview, share, send, update —
 * funnels through {@link resolveMessage}, which accepts the four shapes a model
 * plausibly has on hand and hands back one editor-shaped `WebhookMessage`:
 *
 *  - a JSON object (what `get_template` and `read_share_link` return),
 *  - a JSON string (a payload copied out of DWEEB's JSON tab, or a fenced
 *    block the model just wrote),
 *  - a share token (`1.N4Igr…`) or a DWEEB share URL (`…/#s=<token>`),
 *  - a short link (`…/s/<id>`), resolved through the configured proxy.
 *
 * One funnel matters for the same reason `attachEditorFields` does in the web
 * app: everything downstream — the validator, the traversal helpers, the wire
 * encoder — trusts the shape absolutely and dereferences non-optional fields
 * with no guard. A payload that skipped normalization reaches them as
 * `undefined` and throws a bare TypeError far from the line at fault. So the
 * import boundary lives here, exactly once, and every failure comes back as a
 * described error rather than an exception.
 */

import { countCharacters, countComponents } from "@/core/schema/traversal";
import { validateMessage, type ValidationIssue } from "@/core/schema/validation";
import { inspectCapabilities, type CapabilityNote } from "@/core/schema/capability";
import { isActionRow, isContainer, isMediaGallery, isSection } from "@/core/schema/guards";
import { COMPONENT_META } from "@/core/schema/metadata";
import type { AnyComponent, EditorId, WebhookMessage } from "@/core/schema/types";
import { attachEditorFields, stripEditorFields } from "@/core/serialization/normalize";
import { decodeShare } from "@/core/serialization/encode";
import { readShareTokenFromHash } from "@/core/serialization/url";
import { readShortLinkId } from "@/core/serialization/shortlink";
import type { Config } from "./config";

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Resolved<T> => ({ ok: true, value });
const err = <T>(error: string): Resolved<T> => ({ ok: false, error });

/** How a message argument was supplied. Reported back so the model can see
 *  what the server understood it to mean. */
export type MessageSource = "object" | "json" | "share-token" | "share-url" | "short-link";

export interface ResolvedMessage {
  message: WebhookMessage;
  source: MessageSource;
}

/** A share token is `<version>.<lz-string body>`; the version is an integer. */
const SHARE_TOKEN_RE = /^\d+\.[A-Za-z0-9+\-$]+$/;

/**
 * Turn whatever the model passed into an editor message. Network is only
 * touched for the short-link form, and only when a proxy is configured.
 */
export async function resolveMessage(
  input: unknown,
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<Resolved<ResolvedMessage>> {
  if (input && typeof input === "object") {
    return fromPayload(input, "object");
  }
  if (typeof input !== "string") {
    return err(
      "`message` must be the message object, or a string holding its JSON, a DWEEB share link, or a share token.",
    );
  }
  const trimmed = input.trim();
  if (!trimmed) return err("`message` was empty.");

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return err(`\`message\` looked like JSON but did not parse: ${(e as Error).message}`);
    }
    return fromPayload(parsed, "json");
  }

  if (SHARE_TOKEN_RE.test(trimmed)) return fromToken(trimmed, "share-token");

  if (trimmed.startsWith("#")) {
    const token = readShareTokenFromHash(trimmed);
    if (!token) return err("That URL fragment carries no `s=` share token.");
    return fromToken(token, "share-url");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return err(
      "`message` was neither JSON, a share token, nor a URL. Pass the message object itself, or a DWEEB share link.",
    );
  }

  const token = readShareTokenFromHash(url.hash);
  if (token) return fromToken(token, "share-url");

  const shortId = readShortLinkId(url.pathname);
  if (shortId) {
    const resolved = await resolveShortLink(shortId, config, fetchImpl);
    if (!resolved.ok) return err(resolved.error);
    return fromToken(resolved.value, "short-link");
  }

  return err(
    "That link carries no message. A DWEEB share link looks like https://dweeb.faizo.net/#s=<token> or https://dweeb.faizo.net/s/<id>.",
  );
}

function fromToken(token: string, source: MessageSource): Resolved<ResolvedMessage> {
  const decoded = decodeShare(token);
  if (!decoded.ok) return err(decoded.error);
  return ok({ message: decoded.message, source });
}

function fromPayload(payload: unknown, source: MessageSource): Resolved<ResolvedMessage> {
  try {
    return ok({ message: attachEditorFields(payload), source });
  } catch (e) {
    return err(`That payload is not a Components V2 message: ${(e as Error).message}`);
  }
}

/** Fetch the share token behind a short-link id from the configured proxy. */
export async function resolveShortLink(
  id: string,
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<Resolved<string>> {
  if (!config.proxyUrl) {
    return err(
      "Short links need a DWEEB proxy — set DWEEB_PROXY_URL (or pass the full `#s=` share link instead).",
    );
  }
  let res: Response;
  try {
    res = await fetchImpl(`${config.proxyUrl}/api/shortlink/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    return err(`Couldn't reach the short-link service: ${(e as Error).message}`);
  }
  const data = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
  if (!res.ok || !data?.token) {
    return err(data?.error ?? `The short-link service answered ${res.status}.`);
  }
  return ok(data.token);
}

/* ─── Reporting ──────────────────────────────────────────────────────── */

export interface MessageStats {
  top_level_components: number;
  total_components: number;
  characters: number;
}

export function messageStats(message: WebhookMessage): MessageStats {
  return {
    top_level_components: message.components.length,
    total_components: countComponents(message),
    characters: countCharacters(message),
  };
}

/**
 * Map every editor id to a JSON path into the wire payload
 * (`components[0].components[2].accessory`).
 *
 * The validator reports problems against the editor's opaque `_id`, which is
 * meaningless to a model that only ever sees the wire JSON — it cannot act on
 * "node xk3f9 is missing a label". A path it can act on: it points at the
 * exact object to fix in the payload it just sent.
 */
export function buildPathIndex(message: WebhookMessage): Map<EditorId, string> {
  const index = new Map<EditorId, string>();
  message.components.forEach((node, i) => indexNode(node, `components[${i}]`, index));
  return index;
}

function indexNode(node: AnyComponent, path: string, index: Map<EditorId, string>): void {
  index.set(node._id, path);
  if (isContainer(node) || isActionRow(node)) {
    node.components.forEach((child, i) =>
      indexNode(child as AnyComponent, `${path}.components[${i}]`, index),
    );
    return;
  }
  if (isSection(node)) {
    node.components.forEach((child, i) => indexNode(child, `${path}.components[${i}]`, index));
    if (node.accessory) indexNode(node.accessory, `${path}.accessory`, index);
    return;
  }
  if (isMediaGallery(node)) {
    node.items.forEach((item, i) => index.set(item._id, `${path}.items[${i}]`));
  }
}

export interface ReportedIssue {
  code: string;
  message: string;
  /** Path into the wire payload, when the issue names a component. */
  path?: string;
  /** Human label of the component the path points at (e.g. "Button"). */
  component?: string;
}

function reportIssue(
  issue: ValidationIssue,
  paths: Map<EditorId, string>,
  labels: Map<EditorId, string>,
): ReportedIssue {
  const out: ReportedIssue = { code: issue.code, message: issue.message };
  const path = issue.nodeId ? paths.get(issue.nodeId) : undefined;
  if (path) out.path = path;
  const label = issue.nodeId ? labels.get(issue.nodeId) : undefined;
  if (label) out.component = label;
  return out;
}

/** Human component labels by editor id, for the same reason as the paths. */
function buildLabelIndex(message: WebhookMessage): Map<EditorId, string> {
  const labels = new Map<EditorId, string>();
  const visit = (node: AnyComponent): void => {
    labels.set(node._id, COMPONENT_META[node.type]?.label ?? `Type ${node.type}`);
    if (isContainer(node) || isActionRow(node)) {
      (node.components as AnyComponent[]).forEach(visit);
    } else if (isSection(node)) {
      node.components.forEach(visit);
      if (node.accessory) visit(node.accessory);
    } else if (isMediaGallery(node)) {
      node.items.forEach((item, i) => labels.set(item._id, `Gallery image ${i + 1}`));
    }
  };
  message.components.forEach(visit);
  return labels;
}

export interface MessageReport {
  /** False when Discord would reject the message as built. */
  ok: boolean;
  /** Problems that block sending. */
  errors: ReportedIssue[];
  /** Accepted by Discord, but it will ignore or degrade something. */
  warnings: ReportedIssue[];
  /** What the message needs from its destination to actually work. */
  requirements: Array<{ kind: CapabilityNote["kind"]; title: string; detail: string }>;
  stats: MessageStats;
}

/**
 * The full verdict on a message: what Discord would reject, what it would
 * quietly ignore, and what the destination has to provide.
 */
export function reportMessage(message: WebhookMessage, threadIdProvided = false): MessageReport {
  const { issues } = validateMessage(message);
  const paths = buildPathIndex(message);
  const labels = buildLabelIndex(message);
  const errors = issues
    .filter((i) => i.severity === "error")
    .map((i) => reportIssue(i, paths, labels));
  const warnings = issues
    .filter((i) => i.severity === "warning")
    .map((i) => reportIssue(i, paths, labels));
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    requirements: inspectCapabilities(message, { threadIdProvided }).map((n) => ({
      kind: n.kind,
      title: n.title,
      detail: n.detail,
    })),
    stats: messageStats(message),
  };
}

/**
 * The exact JSON body Discord receives: editor ids dropped, undefined optionals
 * removed, `flags` computed. Identical to the web app's JSON export, so a
 * payload round-trips between the two without translation.
 */
export function toWire(message: WebhookMessage): Record<string, unknown> {
  return stripEditorFields(message) as Record<string, unknown>;
}
