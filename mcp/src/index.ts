/**
 * DWEEB's MCP server — assembly.
 *
 * `main` is everything the process does: read the environment, answer the CLI
 * flags, and otherwise serve MCP over stdio until stdin closes. The executable
 * wrapper lives in `main.ts`; keeping the two apart means the tests can call
 * `main(["--check"], …)` without a module-level side effect starting a server
 * on their stdin.
 *
 * Boot is deliberately loud and early: an unusable environment variable stops
 * the process here, with the reason on stderr where the client shows it, rather
 * than becoming a confusing tool failure ten minutes into a conversation.
 */

import type { Readable, Writable } from "node:stream";

import pkg from "../../package.json";
import { loadConfig, ConfigError, type Config, type Env } from "./config";
import { WebhookInfoCache } from "./discord";
import { McpServer } from "./protocol";
import { serveStdio } from "./stdio";
import { ALL_TOOLS, availableTools } from "./tools";

const NAME = "dweeb";
const TITLE = "DWEEB — Discord message builder";

const INSTRUCTIONS = `Build, check, and post Discord messages that use the Components V2 layout \
system, through DWEEB — the same schema, validator, and templates as the DWEEB web app.

Use this server whenever the task involves a Discord message that is more than plain text: \
containers with accent stripes, sections with thumbnails, image galleries, buttons, or select menus.

The workflow that works: start from \`list_templates\` / \`get_template\` rather than from scratch, \
read \`describe_schema\` when unsure of a component's shape, then \`validate_message\` and \
\`preview_message\` before anything is posted. \`create_share_link\` opens the message in DWEEB's \
visual editor, which is how a person reviews it — offer the link instead of describing the message. \
\`send_message\` posts it, and is visible to everyone in the channel the moment it succeeds.

Messages are Components V2: the legacy \`content\` and \`embeds\` fields are forbidden, and the whole \
message is expressed through \`components\`.`;

function usage(): string {
  return `DWEEB MCP server ${pkg.version}

Speaks the Model Context Protocol over stdio, exposing DWEEB's Discord
Components V2 builder: templates, validation, previews, share links, and
webhook posting.

  bun run mcp               start the server (stdio)
  bun run mcp -- --check    validate the environment and exit
  bun run mcp -- --tools    list the tools this configuration exposes
  bun run mcp -- --version  print the version
  bun run mcp -- --help     this text

Environment:
  DWEEB_WEBHOOK_URL     one Discord webhook URL, named "default"
  DWEEB_WEBHOOKS        JSON object of {"name": "webhook url"} pairs
  DWEEB_APP_URL         DWEEB deployment share links point at
                        (default https://dweeb.faizo.net)
  DWEEB_PROXY_URL       DWEEB proxy used for short links; set it empty to
                        disable them (default https://api.dweeb.faizo.net)
  DWEEB_MCP_READ_ONLY   1/true to withhold every tool that changes Discord
  DWEEB_MCP_TIMEOUT_MS  deadline per outbound request (default 15000)

With no webhook configured the server still builds, validates, previews, and
shares messages — it just cannot post them.`;
}

/** One-line description of what this process will do, for the stderr banner
 *  and `--check`. Names no credential. */
export function summarize(config: Config): string {
  const destinations =
    config.webhooks.length === 0
      ? "none (cannot post)"
      : config.webhooks.map((w) => w.alias).join(", ");
  return [
    `app: ${config.appUrl}`,
    `proxy: ${config.proxyUrl || "disabled (no short links)"}`,
    `destinations: ${destinations}`,
    `mode: ${config.readOnly ? "read-only" : "read-write"}`,
    `tools: ${availableTools(config).length}/${ALL_TOOLS.length}`,
    `timeout: ${config.timeoutMs}ms`,
  ].join(" · ");
}

/** Assemble a server around a config. Exported so the tests can drive the real
 *  protocol surface without spawning a process. */
export function createServer(config: Config): McpServer {
  return new McpServer({
    info: { name: NAME, title: TITLE, version: pkg.version },
    instructions: INSTRUCTIONS,
    toolContext: {
      config,
      webhookInfo: new WebhookInfoCache(),
      fetchImpl: fetch,
    },
  });
}

export interface MainStreams {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  env: Env;
}

const PROCESS_STREAMS: MainStreams = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
};

/** Run the server. Resolves to the process exit code. */
export async function main(
  argv: string[] = process.argv.slice(2),
  streams: MainStreams = PROCESS_STREAMS,
): Promise<number> {
  const { stdout, stderr, stdin, env } = streams;

  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(`${usage()}\n`);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    stdout.write(`${pkg.version}\n`);
    return 0;
  }

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      stderr.write(`dweeb-mcp: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  if (argv.includes("--check")) {
    stdout.write(`dweeb-mcp ${pkg.version} — ${summarize(config)}\n`);
    return 0;
  }
  if (argv.includes("--tools")) {
    for (const tool of availableTools(config)) {
      stdout.write(`${tool.name}\t${tool.title}\n`);
    }
    return 0;
  }

  const unknown = argv.filter((arg) => arg.startsWith("-"));
  if (unknown.length > 0) {
    stderr.write(`dweeb-mcp: unknown option ${unknown[0]}\n${usage()}\n`);
    return 1;
  }

  const log = (line: string): void => {
    stderr.write(`dweeb-mcp: ${line}\n`);
  };
  log(`ready — ${summarize(config)}`);

  await serveStdio(createServer(config), { input: stdin, output: stdout, log });
  return 0;
}
