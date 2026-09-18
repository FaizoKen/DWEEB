/**
 * Plain-HTTP senders: cURL, JavaScript `fetch`, and Python `requests`.
 *
 * All three post the exact payload the JSON tab exports, so they differ only in
 * transport — and the transport is where hand-written webhook code goes wrong:
 * `with_components=true` missing from the URL (Discord then drops the
 * components without an error), and `attachment://` files sent without the
 * `attachments` index that maps each multipart part to its filename. The
 * generated code gets both right, which is the reason to generate it.
 */

import type { CodegenInput, WirePayload } from "./payload";
import { quote } from "./printer";

const PLACEHOLDER_URL = "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN";

/** The payload as sent: with Discord's `attachments` index when files ride along. */
function wireBody({ payload, attachments }: CodegenInput): WirePayload | Record<string, unknown> {
  if (!attachments.length) return payload;
  return { ...payload, attachments: attachments.map((filename, id) => ({ id, filename })) };
}

/** A Python literal for a JSON value: `True`/`False`/`None`, four-space indent. */
function pyLiteral(value: unknown, depth: number): string {
  const pad = "    ".repeat(depth + 1);
  const close = "    ".repeat(depth);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const scalar = value.every((item) => item === null || typeof item !== "object");
    if (scalar) return `[${value.map((item) => pyLiteral(item, depth)).join(", ")}]`;
    return `[\n${value.map((item) => `${pad}${pyLiteral(item, depth + 1)},`).join("\n")}\n${close}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== undefined,
  );
  if (!entries.length) return "{}";
  return `{\n${entries
    .map(([key, item]) => `${pad}${quote(key)}: ${pyLiteral(item, depth + 1)},`)
    .join("\n")}\n${close}}`;
}

export function generateCurl(input: CodegenInput): string {
  const json = JSON.stringify(wireBody(input), null, 2);
  const url = `${PLACEHOLDER_URL}?with_components=true&wait=true`;
  // The JSON travels on stdin through a quoted heredoc, so an apostrophe in the
  // message text — which would end a single-quoted -d argument — is inert.
  if (!input.attachments.length) {
    return [
      "# Components V2 webhook message — designed in DWEEB (https://dweeb.faizo.net).",
      "# Replace the URL with your webhook's. with_components=true is required:",
      "# without it Discord accepts the request and silently drops the components.",
      `curl -X POST ${quote(url)} \\`,
      '  -H "Content-Type: application/json" \\',
      "  --data-binary @- <<'JSON'",
      json,
      "JSON",
      "",
    ].join("\n");
  }
  return [
    "# Components V2 webhook message — designed in DWEEB (https://dweeb.faizo.net).",
    "# Replace the URL with your webhook's. with_components=true is required:",
    "# without it Discord accepts the request and silently drops the components.",
    "# Each files[n] part is matched to its attachment:// reference by filename.",
    `curl -X POST ${quote(url)} \\`,
    "  -F 'payload_json=<-;type=application/json' \\",
    ...input.attachments.map(
      (name, index) =>
        `  -F ${quote(`files[${index}]=@./${name}`)}${index < input.attachments.length - 1 ? " \\" : " <<'JSON'"}`,
    ),
    json,
    "JSON",
    "",
  ].join("\n");
}

export function generateFetch(input: CodegenInput): string {
  const json = JSON.stringify(wireBody(input), null, 2);
  const head = [
    "// Components V2 webhook message — designed in DWEEB (https://dweeb.faizo.net).",
    "// Runs anywhere fetch does: Node 18+, Deno, Bun, a Cloudflare Worker.",
    "// Keep the webhook URL out of browser code — anyone who reads it can post.",
    ...(input.attachments.length ? ['import { readFile } from "node:fs/promises";', ""] : []),
    `const WEBHOOK_URL = ${quote(PLACEHOLDER_URL)};`,
    "",
    `const payload = ${json};`,
    "",
  ];
  const request = input.attachments.length
    ? [
        "// Each files[n] part is matched to its attachment:// reference by filename.",
        "const form = new FormData();",
        'form.append("payload_json", JSON.stringify(payload));',
        ...input.attachments.map(
          (name, index) =>
            `form.append(${quote(`files[${index}]`)}, new Blob([await readFile(${quote(`./${name}`)})]), ${quote(name)});`,
        ),
        "",
        "// with_components=true is required, or Discord silently drops the components.",
        "const response = await fetch(`${WEBHOOK_URL}?with_components=true&wait=true`, {",
        '  method: "POST",',
        "  body: form,",
        "});",
      ]
    : [
        "// with_components=true is required, or Discord silently drops the components.",
        "const response = await fetch(`${WEBHOOK_URL}?with_components=true&wait=true`, {",
        '  method: "POST",',
        '  headers: { "Content-Type": "application/json" },',
        "  body: JSON.stringify(payload),",
        "});",
      ];
  return [
    ...head,
    ...request,
    "if (!response.ok) {",
    "  throw new Error(`Discord returned ${response.status}: ${await response.text()}`);",
    "}",
    "",
  ].join("\n");
}

export function generatePythonRequests(input: CodegenInput): string {
  const head = [
    "# Components V2 webhook message — designed in DWEEB (https://dweeb.faizo.net).",
    "# pip install requests",
    ...(input.attachments.length ? ["import json", ""] : []),
    "import requests",
    "",
    `WEBHOOK_URL = ${quote(PLACEHOLDER_URL)}`,
    "",
    `payload = ${pyLiteral(wireBody(input), 0)}`,
    "",
    "# with_components=true is required, or Discord silently drops the components.",
  ];
  const request = input.attachments.length
    ? [
        "# Each files[n] part is matched to its attachment:// reference by filename.",
        "files = {",
        ...input.attachments.map(
          (name, index) =>
            `    ${quote(`files[${index}]`)}: (${quote(name)}, open(${quote(`./${name}`)}, "rb")),`,
        ),
        "}",
        "response = requests.post(",
        "    WEBHOOK_URL,",
        '    params={"with_components": "true", "wait": "true"},',
        '    data={"payload_json": json.dumps(payload)},',
        "    files=files,",
        "    timeout=30,",
        ")",
      ]
    : [
        "response = requests.post(",
        "    WEBHOOK_URL,",
        '    params={"with_components": "true", "wait": "true"},',
        "    json=payload,",
        "    timeout=10,",
        ")",
      ];
  return [...head, ...request, "response.raise_for_status()", ""].join("\n");
}
