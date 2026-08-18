import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config";
import { WebhookInfoCache } from "./discord";
import { main } from "./index";
import { McpServer, LATEST_PROTOCOL_VERSION } from "./protocol";
import { serveStdio } from "./stdio";

/** Collect everything written to a stream as one string. */
function collector(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function parseLines(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function testServer(): McpServer {
  return new McpServer({
    info: { name: "dweeb", title: "DWEEB", version: "test" },
    instructions: "Build Discord messages.",
    toolContext: {
      config: loadConfig({}),
      webhookInfo: new WebhookInfoCache(),
      fetchImpl: (() => {
        throw new Error("no network in these tests");
      }) as unknown as typeof fetch,
    },
  });
}

/** Feed `chunks` through the transport and return what it wrote back. */
async function pump(chunks: string[]): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = collector();
  const logs: string[] = [];
  const done = serveStdio(testServer(), {
    input,
    output: output.stream,
    log: (line) => logs.push(line),
  });
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await done;
  return parseLines(output.text());
}

const ping = (id: number): string => `${JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })}\n`;

describe("the stdio transport", () => {
  it("answers each message on its own line", async () => {
    const answers = await pump([ping(1), ping(2)]);
    expect(answers.map((a) => a.id)).toEqual([1, 2]);
    expect(answers.every((a) => a.jsonrpc === "2.0")).toBe(true);
  });

  it("handles several messages arriving in one chunk", async () => {
    expect(await pump([ping(1) + ping(2) + ping(3)])).toHaveLength(3);
  });

  it("handles one message split across chunks", async () => {
    const line = ping(9);
    const answers = await pump([line.slice(0, 12), line.slice(12)]);
    expect(answers[0]!.id).toBe(9);
  });

  it("tolerates CRLF line endings and blank lines", async () => {
    const answers = await pump([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\r\n`,
      "\n",
      ping(2),
    ]);
    expect(answers.map((a) => a.id)).toEqual([1, 2]);
  });

  it("still answers a final message that arrived without its newline", async () => {
    const answers = await pump([
      ping(1),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    ]);
    expect(answers.map((a) => a.id)).toEqual([1, 2]);
  });

  // Answering a notification is a protocol violation and desynchronizes a
  // client that matches replies to ids.
  it("writes nothing at all for a notification", async () => {
    expect(
      await pump([`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`]),
    ).toEqual([]);
  });

  it("answers malformed JSON instead of dropping the connection", async () => {
    const answers = await pump(["{ not json\n", ping(2)]);
    expect((answers[0]!.error as { code: number }).code).toBe(-32700);
    expect(answers[1]!.id).toBe(2);
  });

  // Every message has to survive `JSON.parse` on one line at the other end.
  it("never emits a raw newline inside a message", async () => {
    const input = new PassThrough();
    const output = collector();
    const done = serveStdio(testServer(), { input, output: output.stream, log: () => {} });
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        // A template full of markdown newlines, rendered into the result text.
        params: { name: "get_template", arguments: { id: "welcome" } },
      })}\n`,
    );
    input.end();
    await done;
    const lines = output.text().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1 });
  });
});

/**
 * The same path a real client drives, through `main` — CLI flags, config from
 * the environment, and a full MCP handshake over the streams it is handed.
 */
describe("main", () => {
  function streams() {
    const stdin = new PassThrough();
    const stdout = collector();
    const stderr = collector();
    return { stdin, stdout, stderr };
  }

  it("prints the version and exits", async () => {
    const { stdin, stdout, stderr } = streams();
    const code = await main(["--version"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {},
    });
    expect(code).toBe(0);
    expect(stdout.text().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("summarises the configuration for --check", async () => {
    const { stdin, stdout, stderr } = streams();
    const code = await main(["--check"], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: { DWEEB_MCP_READ_ONLY: "true" },
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("mode: read-only");
    expect(stdout.text()).toContain("destinations: none (cannot post)");
  });

  // The reason has to reach stderr, where the client shows it. A server that
  // starts with permissions the operator did not grant is the failure mode
  // this prevents.
  it("refuses to start on an unusable environment, and says why", async () => {
    const { stdin, stdout, stderr } = streams();
    const code = await main([], {
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: { DWEEB_MCP_READ_ONLY: "maybe" },
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("DWEEB_MCP_READ_ONLY");
    expect(stdout.text()).toBe("");
  });

  it("rejects an option it does not know", async () => {
    const { stdin, stdout, stderr } = streams();
    expect(
      await main(["--post-everything"], {
        stdin,
        stdout: stdout.stream,
        stderr: stderr.stream,
        env: {},
      }),
    ).toBe(1);
    expect(stderr.text()).toContain("unknown option");
  });

  it("serves a full handshake, then a tool call, and keeps stdout protocol-only", async () => {
    const { stdin, stdout, stderr } = streams();
    const running = main([], { stdin, stdout: stdout.stream, stderr: stderr.stream, env: {} });

    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {} },
      })}\n`,
    );
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "validate_message", arguments: { message: { components: [] } } },
      })}\n`,
    );
    stdin.end();

    expect(await running).toBe(0);
    const answers = parseLines(stdout.text());
    expect(answers).toHaveLength(2);
    expect((answers[0]!.result as { serverInfo: { name: string } }).serverInfo.name).toBe("dweeb");
    // Validating an invalid message is a *successful* validation: the verdict
    // is the answer, not a failure of the call.
    const call = answers[1]!.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(call.isError).toBeUndefined();
    expect(call.content[0]!.text).toContain("EMPTY_MESSAGE");
    // The banner and every diagnostic belong on stderr; one stray byte on
    // stdout breaks the client's parser.
    expect(stderr.text()).toContain("ready");
  });
});
