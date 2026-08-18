import { describe, expect, it } from "vitest";

import { loadConfig, type Env } from "./config";
import { WebhookInfoCache } from "./discord";
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpServer,
  negotiateVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
} from "./protocol";
import { ALL_TOOLS } from "./tools";

function server(env: Env = {}): McpServer {
  return new McpServer({
    info: { name: "dweeb", title: "DWEEB", version: "test" },
    instructions: "Build Discord messages.",
    toolContext: {
      config: loadConfig(env),
      webhookInfo: new WebhookInfoCache(),
      fetchImpl: (() => {
        throw new Error("no network in these tests");
      }) as unknown as typeof fetch,
    },
  });
}

/** One response — `handle` widens to an array only for a JSON-RPC batch. */
type Single = JsonRpcResponse;

async function request(
  mcp: McpServer,
  method: string,
  params?: unknown,
  id: string | number = 1,
): Promise<Single> {
  const answer = await mcp.handle({ jsonrpc: "2.0", id, method, params });
  if (!answer || Array.isArray(answer)) throw new Error(`expected one response to ${method}`);
  return answer;
}

function ok(answer: Single): Record<string, unknown> {
  if ("error" in answer) throw new Error(`expected a result, got ${answer.error.message}`);
  return answer.result;
}

function err(answer: Single): { code: number; message: string } {
  if (!("error" in answer)) throw new Error("expected an error");
  return answer.error;
}

describe("initialize", () => {
  it("answers with the negotiated version, the capabilities, and the instructions", async () => {
    const mcp = server();
    const result = ok(
      await request(mcp, "initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "probe", version: "1" },
      }),
    );
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(result.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    });
    expect(result.serverInfo).toMatchObject({ name: "dweeb" });
    expect(String(result.instructions)).toContain("Discord");
  });

  it("echoes an older version it can still speak", async () => {
    const mcp = server();
    const result = ok(await request(mcp, "initialize", { protocolVersion: "2024-11-05" }));
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(mcp.protocolVersion).toBe("2024-11-05");
  });

  // A newer client is not an error: the spec says answer with ours and let the
  // client decide. Failing the handshake here would lock the server out of
  // every future revision.
  it("answers a version it has never heard of with the newest it speaks", () => {
    expect(negotiateVersion("2099-01-01")).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateVersion(5)).toBe(LATEST_PROTOCOL_VERSION);
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateVersion(version)).toBe(version);
    }
  });

  it("completes the three-step handshake", async () => {
    const mcp = server();
    await request(mcp, "initialize", { protocolVersion: LATEST_PROTOCOL_VERSION });
    expect(mcp.isInitialized).toBe(false);
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(mcp.isInitialized).toBe(true);
  });
});

describe("envelope handling", () => {
  it("never answers a notification", async () => {
    const mcp = server();
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/cancelled" })).toBeNull();
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/unheard-of" })).toBeNull();
  });

  it("ignores a message that is an answer to us rather than a request of us", async () => {
    expect(await server().handle({ jsonrpc: "2.0", id: 1, result: {} })).toBeNull();
  });

  it("reports malformed JSON against a null id", async () => {
    const answer = await server().handleLine("{not json");
    if (!answer || Array.isArray(answer)) throw new Error("expected one response");
    expect(err(answer).code).toBe(ErrorCode.ParseError);
    expect((answer as { id: unknown }).id).toBeNull();
  });

  it("rejects a message with no jsonrpc version, keeping the id so it can be matched", async () => {
    const answer = await server().handle({ id: 7, method: "ping" });
    if (!answer || Array.isArray(answer)) throw new Error("expected one response");
    expect(err(answer).code).toBe(ErrorCode.InvalidRequest);
    expect((answer as { id: unknown }).id).toBe(7);
  });

  it("rejects an unknown method", async () => {
    expect(err(await request(server(), "resources/subscribe")).code).toBe(ErrorCode.MethodNotFound);
  });

  it("answers a ping with nothing to say", async () => {
    expect(ok(await request(server(), "ping"))).toEqual({});
  });

  // Batching was dropped in 2025-06-18 but permitted before it; answering one
  // costs nothing and keeps an older client working.
  it("answers a batch with a batch, and drops the notifications from it", async () => {
    const answer = await server().handle([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(Array.isArray(answer)).toBe(true);
    expect(answer).toHaveLength(2);
  });

  it("rejects an empty batch", async () => {
    const answer = await server().handle([]);
    if (!answer || Array.isArray(answer)) throw new Error("expected one response");
    expect(err(answer).code).toBe(ErrorCode.InvalidRequest);
  });
});

describe("tools", () => {
  it("lists every tool with a schema and annotations", async () => {
    const result = ok(await request(server(), "tools/list"));
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(ALL_TOOLS.length);
    for (const tool of tools) {
      expect(tool.name).toBeTypeOf("string");
      expect(tool.description).toBeTypeOf("string");
      expect((tool.inputSchema as { type: string }).type).toBe("object");
      expect(tool.annotations).toBeTruthy();
    }
  });

  it("hides the mutating tools when the server runs read-only", async () => {
    const result = ok(await request(server({ DWEEB_MCP_READ_ONLY: "on" }), "tools/list"));
    const names = (result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("send_message");
  });

  it("runs a tool and returns its content", async () => {
    const result = ok(
      await request(server(), "tools/call", {
        name: "get_template",
        arguments: { id: "welcome" },
      }),
    );
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("Welcome");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeTruthy();
  });

  // A tool that ran and failed is a result the model must read and act on. A
  // JSON-RPC error is for the protocol failing, and most clients never show
  // its text to the model at all.
  it("reports a tool's own failure as a result, not a protocol error", async () => {
    const result = ok(
      await request(server(), "tools/call", {
        name: "get_template",
        arguments: { id: "nope" },
      }),
    );
    expect(result.isError).toBe(true);
  });

  it("rejects a call to a tool that does not exist, naming the ones that do", async () => {
    const error = err(await request(server(), "tools/call", { name: "send_tweet", arguments: {} }));
    expect(error.code).toBe(ErrorCode.InvalidParams);
    expect(error.message).toContain("send_message");
  });

  it("rejects a hidden tool exactly as it rejects an unknown one", async () => {
    const error = err(
      await request(server({ DWEEB_MCP_READ_ONLY: "1" }), "tools/call", {
        name: "send_message",
        arguments: { message: { components: [] } },
      }),
    );
    expect(error.code).toBe(ErrorCode.InvalidParams);
  });

  it("rejects arguments that are not an object", async () => {
    const error = err(
      await request(server(), "tools/call", { name: "list_templates", arguments: [1, 2] }),
    );
    expect(error.code).toBe(ErrorCode.InvalidParams);
  });
});

describe("structured output", () => {
  it("is offered when the negotiated version defines it", async () => {
    const mcp = server();
    await request(mcp, "initialize", { protocolVersion: "2025-06-18" });
    const listed = ok(await request(mcp, "tools/list"));
    expect((listed.tools as Array<Record<string, unknown>>)[0]!.outputSchema).toBeTruthy();
    const called = ok(await request(mcp, "tools/call", { name: "list_templates", arguments: {} }));
    expect(called.structuredContent).toBeTruthy();
  });

  // `outputSchema` and `structuredContent` arrived in 2025-06-18. Sending a
  // field an older revision does not define is what a strict client rejects,
  // and the text content carries the same information anyway.
  it("is withheld from a client that negotiated an older revision", async () => {
    const mcp = server();
    await request(mcp, "initialize", { protocolVersion: "2024-11-05" });
    const listed = ok(await request(mcp, "tools/list"));
    expect((listed.tools as Array<Record<string, unknown>>)[0]!.outputSchema).toBeUndefined();
    const called = ok(await request(mcp, "tools/call", { name: "list_templates", arguments: {} }));
    expect(called.structuredContent).toBeUndefined();
    expect((called.content as Array<{ text: string }>)[0]!.text).toContain("template");
  });
});

describe("resources", () => {
  it("lists the reference material and its URI template", async () => {
    const listed = ok(await request(server(), "resources/list"));
    const uris = (listed.resources as Array<{ uri: string }>).map((r) => r.uri);
    expect(uris).toEqual(["dweeb://guide", "dweeb://limits", "dweeb://templates"]);

    const templates = ok(await request(server(), "resources/templates/list"));
    expect((templates.resourceTemplates as Array<{ uriTemplate: string }>)[0]!.uriTemplate).toBe(
      "dweeb://templates/{id}",
    );
  });

  it("reads the guide, the limits, and one template", async () => {
    const mcp = server();
    for (const [uri, needle] of [
      ["dweeb://guide", "Component types"],
      ["dweeb://limits", "TOTAL_COMPONENTS"],
      ["dweeb://templates", "welcome"],
      ["dweeb://templates/welcome", '"type"'],
    ] as const) {
      const result = ok(await request(mcp, "resources/read", { uri }));
      const contents = result.contents as Array<{ uri: string; text: string }>;
      expect(contents[0]!.uri).toBe(uri);
      expect(contents[0]!.text).toContain(needle);
    }
  });

  it("answers the spec's resource-not-found code for a URI it does not serve", async () => {
    const error = err(await request(server(), "resources/read", { uri: "dweeb://templates/nope" }));
    expect(error.code).toBe(ErrorCode.ResourceNotFound);
  });

  it("rejects a read with no URI", async () => {
    expect(err(await request(server(), "resources/read", {})).code).toBe(ErrorCode.InvalidParams);
  });
});

describe("prompts", () => {
  it("lists prompts with their arguments", async () => {
    const result = ok(await request(server(), "prompts/list"));
    const prompts = result.prompts as Array<{ name: string; arguments: unknown[] }>;
    expect(prompts.map((p) => p.name)).toEqual([
      "build_message",
      "revise_message",
      "audit_message",
    ]);
    expect(prompts[0]!.arguments.length).toBeGreaterThan(0);
  });

  it("builds a prompt from its arguments", async () => {
    const result = ok(
      await request(server(), "prompts/get", {
        name: "build_message",
        arguments: { brief: "a rules post", template: "rules" },
      }),
    );
    const messages = result.messages as Array<{ role: string; content: { text: string } }>;
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content.text).toContain("a rules post");
    expect(messages[0]!.content.text).toContain('template or category "rules"');
  });

  it("rejects a missing required argument, and an unknown prompt", async () => {
    expect(err(await request(server(), "prompts/get", { name: "build_message" })).code).toBe(
      ErrorCode.InvalidParams,
    );
    expect(err(await request(server(), "prompts/get", { name: "nope" })).message).toContain("nope");
  });
});
