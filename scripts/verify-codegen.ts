/**
 * Round-trip proof for the code export (`src/core/codegen`).
 *
 * The unit tests pin what the generators *print*. This script proves the printed
 * code is *right*: it runs every target against the real thing and compares what
 * comes out the other end with the payload that went in.
 *
 *   discord.js  — executes the generated builders, reads each `toJSON()`.
 *   discord.py  — executes the generated `build_view()`, reads `to_components()`.
 *   python / fetch / curl — run against a local capture server standing in for
 *                 Discord, so the request line, query string and body are real.
 *
 * It is an on-demand check, not a CI gate: it needs the published libraries,
 * and workflows here must not depend on a registry being reachable. Run it after
 * touching a generator, or when discord.js / discord.py ship a major version:
 *
 *   mkdir /tmp/cv && cd /tmp/cv && npm i discord.js
 *   python -m venv py && py/bin/pip install discord.py requests
 *   CODEGEN_VERIFY_NODE_DIR=/tmp/cv CODEGEN_VERIFY_PYTHON=/tmp/cv/py/bin/python \
 *     bun scripts/verify-codegen.ts
 *
 * A target whose runtime is not configured is skipped and reported as such.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEMPLATES } from "@/data/presets";
import { attachEditorFields } from "@/core/serialization/normalize";
import { generateCode, type CodeTarget } from "@/core/codegen";
import { prepareCodegenInput } from "@/core/codegen/payload";
import type { WebhookMessage } from "@/core/schema/types";

const NODE_DIR = process.env.CODEGEN_VERIFY_NODE_DIR;
const PYTHON = process.env.CODEGEN_VERIFY_PYTHON;
const BASH = process.env.CODEGEN_VERIFY_BASH ?? "bash";

/** Payloads the templates never reach: every optional field, every select kind. */
const EDGE_CASES: Record<string, unknown> = {
  "edge-every-field": {
    username: "Release Bot",
    avatar_url: "https://example.com/avatar.png",
    allowed_mentions: { parse: ["users"], roles: ["123456789012345678"], replied_user: false },
    flags: (1 << 15) | (1 << 12),
    components: [
      {
        type: 10,
        id: 7,
        content: 'Plain line with "quotes", a \\ backslash and an apostrophe\'s tail',
      },
      {
        type: 17,
        id: 9,
        accent_color: 0x00ff7f,
        spoiler: true,
        components: [
          { type: 10, content: "# Heading\n\nParagraph one.\n- bullet\n\u2028odd separator" },
          {
            type: 9,
            components: [
              { type: 10, content: "Beside a thumbnail" },
              { type: 10, content: "Second line\nwith a break" },
            ],
            accessory: {
              type: 11,
              media: { url: "https://example.com/thumb.png" },
              description: "Alt text",
              spoiler: true,
            },
          },
          {
            type: 9,
            components: [{ type: 10, content: "Beside a button" }],
            accessory: { type: 2, style: 5, label: "Open", url: "https://example.com/" },
          },
          { type: 14, divider: false, spacing: 2 },
          { type: 14 },
          {
            type: 12,
            items: [
              { media: { url: "https://example.com/a.png" }, description: "First", spoiler: true },
              { media: { url: "https://example.com/b.png" } },
            ],
          },
          {
            type: 1,
            components: [
              { type: 2, style: 1, label: "Primary", custom_id: "a", emoji: { name: "🎉" } },
              {
                type: 2,
                style: 2,
                custom_id: "b",
                emoji: { id: "123456789012345678", name: "party", animated: true },
              },
              { type: 2, style: 3, label: "Success", custom_id: "c", disabled: true },
              { type: 2, style: 4, label: "Danger", custom_id: "d" },
              { type: 2, style: 6, sku_id: "223456789012345678" },
            ],
          },
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: "pick",
                placeholder: "Choose one",
                min_values: 0,
                max_values: 2,
                options: [
                  {
                    label: "One",
                    value: "1",
                    description: "The first",
                    emoji: { name: "1️⃣" },
                    default: true,
                  },
                  { label: "Two", value: "2" },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 5,
            custom_id: "user",
            default_values: [{ id: "323456789012345678", type: "user" }],
          },
        ],
      },
      {
        type: 1,
        components: [{ type: 6, custom_id: "role", placeholder: "Pick a role", disabled: true }],
      },
      {
        type: 1,
        components: [
          {
            type: 7,
            custom_id: "mention",
            default_values: [
              { id: "323456789012345678", type: "user" },
              { id: "423456789012345678", type: "role" },
            ],
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 8,
            custom_id: "channel",
            channel_types: [0, 5, 15],
            default_values: [{ id: "523456789012345678", type: "channel" }],
          },
        ],
      },
    ],
  },
  "edge-attachments": {
    components: [
      { type: 13, file: { url: "attachment://report.pdf" }, spoiler: true },
      { type: 12, items: [{ media: { url: "attachment://shot_one.png" } }] },
    ],
  },
  "edge-thread": {
    thread_name: "Release notes",
    applied_tags: ["623456789012345678"],
    tts: true,
    allowed_mentions: { parse: [] },
    components: [{ type: 10, content: "Forum post body" }],
  },
};

/** Drop every field whose value is the API default, so both sides compare on meaning. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(node)) {
    if (raw === null || raw === undefined) continue;
    if (
      (key === "spoiler" || key === "disabled" || key === "animated" || key === "default") &&
      raw === false
    )
      continue;
    if (key === "divider" && raw === true) continue;
    if (key === "spacing" && raw === 1) continue;
    if ((key === "min_values" || key === "max_values") && raw === 1) continue;
    // discord.py reports `required` on every select; it only means something in a modal.
    if (key === "required") continue;
    if (key === "sku_id" || key === "id") {
      out[key] = typeof raw === "number" && key === "sku_id" ? String(raw) : raw;
      continue;
    }
    out[key] = normalize(raw);
  }
  // A snowflake is a string on the wire and an int in discord.py.
  if (typeof out.id === "number" && typeof node.type === "string") out.id = String(out.id);
  if (out.emoji && typeof out.emoji === "object") {
    const emoji = out.emoji as Record<string, unknown>;
    if (typeof emoji.id === "number") emoji.id = String(emoji.id);
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(normalize(a))) === JSON.stringify(sortKeys(normalize(b)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => [key, sortKeys(item)]),
  );
}

interface Case {
  name: string;
  message: WebhookMessage;
}

const cases: Case[] = [
  ...TEMPLATES.map((template) => ({ name: `template:${template.id}`, message: template.message })),
  ...Object.entries(EDGE_CASES).map(([name, payload]) => ({
    name,
    message: attachEditorFields(payload),
  })),
];

let failures = 0;
const fail = (label: string, detail: string) => {
  failures += 1;
  console.error(`✗ ${label}\n    ${detail.split("\n").join("\n    ")}`);
};

/**
 * Children are awaited, never `spawnSync`ed: the capture server below runs on
 * this process's event loop, and a synchronous wait would freeze the very
 * server the child is trying to reach.
 */
async function exec(
  command: string[],
  cwd: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60_000);
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { status, stdout, stderr };
}

/** Run `work` over every case, a few at a time — interpreter start-up dominates. */
async function pool(work: (testCase: Case, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < cases.length) {
        const index = next++;
        await work(cases[index]!, index);
      }
    }),
  );
}

const dir = await mkdtemp(join(tmpdir(), "dweeb-codegen-"));
// discord.File and the multipart senders open their paths eagerly, so every
// referenced upload has to exist beside the generated program.
for (const testCase of cases) {
  for (const name of prepareCodegenInput(testCase.message).attachments) {
    await writeFile(join(dir, name), "x");
  }
}

// ── discord.js ──────────────────────────────────────────────────────────────
if (NODE_DIR) {
  let checked = 0;
  await pool(async (testCase, index) => {
    const input = prepareCodegenInput(testCase.message);
    const code = generateCode(testCase.message, "discordjs");
    // Inside NODE_DIR so `require("discord.js")` resolves against its node_modules.
    const file = join(NODE_DIR, `__codegen_${index}.cjs`);
    await writeFile(
      file,
      `let captured;\nconst channel = { send: async (options) => { captured = options; } };\n(async () => {\n${code}\n` +
        `process.stdout.write(JSON.stringify({ components: captured.components.map((c) => c.toJSON()), flags: Number(captured.flags), files: (captured.files ?? []).map((f) => f.name) }));\n})().catch((error) => { console.error(error); process.exit(1); });\n`,
    );
    const run = await exec(["node", file], NODE_DIR);
    await rm(file, { force: true });
    if (run.status !== 0) return fail(`discord.js ${testCase.name}`, run.stderr.slice(0, 1200));
    const actual = JSON.parse(run.stdout) as {
      components: unknown;
      flags: number;
      files: string[];
    };
    if (!same(actual.components, input.payload.components)) {
      return fail(
        `discord.js ${testCase.name}`,
        `components differ\n expected ${JSON.stringify(sortKeys(normalize(input.payload.components)))}\n actual   ${JSON.stringify(sortKeys(normalize(actual.components)))}`,
      );
    }
    if (actual.flags !== input.payload.flags) {
      return fail(`discord.js ${testCase.name}`, `flags ${actual.flags} ≠ ${input.payload.flags}`);
    }
    if (!same(actual.files, input.attachments)) {
      return fail(`discord.js ${testCase.name}`, `files ${JSON.stringify(actual.files)}`);
    }
    checked += 1;
  });
  console.log(`discord.js: ${checked}/${cases.length} messages round-tripped`);
} else {
  console.log("discord.js: skipped (set CODEGEN_VERIFY_NODE_DIR)");
}

// ── discord.py ──────────────────────────────────────────────────────────────
if (PYTHON) {
  let checked = 0;
  await pool(async (testCase, index) => {
    const input = prepareCodegenInput(testCase.message);
    const indented = generateCode(testCase.message, "discordpy")
      .split("\n")
      .map((line) => (line ? `    ${line}` : line))
      .join("\n");
    const file = join(dir, `view_${index}.py`);
    await writeFile(
      file,
      // A snowflake exceeds 2^53, so it is turned into a string in Python —
      // before JSON.parse on this side could round it.
      `import asyncio, json, sys\n\ndef _wide(value):\n    if isinstance(value, dict):\n        return {k: _wide(v) for k, v in value.items()}\n    if isinstance(value, list):\n        return [_wide(v) for v in value]\n    if isinstance(value, int) and not isinstance(value, bool) and value > 2**53:\n        return str(value)\n    return value\n\nclass _Channel:\n    async def send(self, **kwargs):\n        self.kwargs = kwargs\n\nasync def _main():\n    channel = _Channel()\n${indented}\n` +
        `    kwargs = channel.kwargs\n    sys.stdout.write(json.dumps({\n        "components": _wide(kwargs["view"].to_components()),\n        "silent": bool(kwargs.get("silent")),\n        "tts": bool(kwargs.get("tts")),\n        "files": [f.filename for f in kwargs.get("files", [])],\n    }))\n\nasyncio.run(_main())\n`,
    );
    const run = await exec([PYTHON, file], dir);
    if (run.status !== 0) return fail(`discord.py ${testCase.name}`, run.stderr.slice(-1200));
    const actual = JSON.parse(run.stdout) as {
      components: unknown;
      silent: boolean;
      tts: boolean;
      files: string[];
    };
    if (!same(actual.components, input.payload.components)) {
      return fail(
        `discord.py ${testCase.name}`,
        `components differ\n expected ${JSON.stringify(sortKeys(normalize(input.payload.components)))}\n actual   ${JSON.stringify(sortKeys(normalize(actual.components)))}`,
      );
    }
    if (actual.silent !== Boolean(input.payload.flags & (1 << 12))) {
      return fail(`discord.py ${testCase.name}`, `silent=${actual.silent}`);
    }
    if (actual.tts !== Boolean(input.payload.tts)) {
      return fail(`discord.py ${testCase.name}`, `tts=${actual.tts}`);
    }
    if (!same(actual.files, input.attachments)) {
      return fail(`discord.py ${testCase.name}`, `files ${JSON.stringify(actual.files)}`);
    }
    checked += 1;
  });
  console.log(`discord.py: ${checked}/${cases.length} messages round-tripped`);
} else {
  console.log("discord.py: skipped (set CODEGEN_VERIFY_PYTHON)");
}

// ── Plain-HTTP targets, against a stand-in for Discord ──────────────────────
interface Captured {
  method: string;
  search: string;
  json: unknown;
  files: string[];
}
// Keyed by the webhook id in the path, so concurrent programs cannot be
// credited with each other's request.
const received = new Map<string, Captured>();
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const key = url.pathname.split("/")[3] ?? "";
    const files: string[] = [];
    let json: unknown;
    if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await request.formData();
      json = JSON.parse(String(form.get("payload_json")));
      for (const [name, value] of form.entries()) {
        if (name.startsWith("files[") && typeof value !== "string")
          files.push((value as File).name);
      }
    } else {
      json = await request.json();
    }
    received.set(key, { method: request.method, search: url.search, json, files });
    return Response.json({ id: "1" });
  },
});
const PLACEHOLDER = "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN";

async function verifyHttp(
  target: CodeTarget,
  label: string,
  command: (file: string) => string[],
  extension: string,
): Promise<void> {
  let checked = 0;
  await pool(async (testCase, index) => {
    const input = prepareCodegenInput(testCase.message);
    const key = `${target}-${index}`;
    const code = generateCode(testCase.message, target).replaceAll(
      PLACEHOLDER,
      `http://127.0.0.1:${server.port}/api/webhooks/${key}/token`,
    );
    const file = join(dir, `http_${key}.${extension}`);
    await writeFile(file, code);
    const run = await exec(command(file), dir);
    const captured = received.get(key);
    if (run.status !== 0 || !captured) {
      return fail(`${label} ${testCase.name}`, run.stderr.slice(-1200) || "no request arrived");
    }
    const expected = input.attachments.length
      ? {
          ...input.payload,
          attachments: input.attachments.map((filename, id) => ({ id, filename })),
        }
      : input.payload;
    if (captured.method !== "POST") return fail(`${label} ${testCase.name}`, captured.method);
    if (new URLSearchParams(captured.search).get("with_components") !== "true") {
      return fail(`${label} ${testCase.name}`, `query ${captured.search}`);
    }
    if (JSON.stringify(captured.json) !== JSON.stringify(expected)) {
      return fail(`${label} ${testCase.name}`, `body differs\n ${JSON.stringify(captured.json)}`);
    }
    if (JSON.stringify(captured.files) !== JSON.stringify(input.attachments)) {
      return fail(`${label} ${testCase.name}`, `files ${JSON.stringify(captured.files)}`);
    }
    checked += 1;
  });
  console.log(`${label}: ${checked}/${cases.length} requests matched byte-for-byte`);
}

await verifyHttp("fetch", "fetch", (file) => ["node", file], "mjs");
if (PYTHON) await verifyHttp("python", "python requests", (file) => [PYTHON, file], "py");
else console.log("python requests: skipped (set CODEGEN_VERIFY_PYTHON)");
await verifyHttp("curl", "curl", (file) => [BASH, file], "sh");

server.stop(true);
await rm(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log("\nEvery generated program produced the payload it was generated from.");
