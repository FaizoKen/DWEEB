/**
 * The Model Context Protocol, spoken directly.
 *
 * MCP is JSON-RPC 2.0 with a fixed set of methods, and over stdio it is
 * newline-delimited JSON on stdin/stdout. The whole surface this server needs —
 * initialize, ping, tools, resources, prompts — is small, stable, and
 * implemented here rather than pulled in: the official TypeScript SDK brings
 * ninety-odd transitive packages (a web framework, a JOSE implementation, two
 * JSON-Schema validators) to run a pipe, and this repository has spent its life
 * not doing that. The trade is that spec correctness is our job, so the parts
 * that are easy to get subtly wrong are called out below and covered by
 * `protocol.test.ts`.
 *
 * Things worth knowing if you touch this:
 *
 *  - **Version negotiation.** The client proposes a protocol version; a server
 *    that supports it echoes it back, and one that does not answers with the
 *    latest version it *does* support and lets the client decide whether to go
 *    on. A version newer than anything we know is therefore not an error — we
 *    answer with ours. Never fail the handshake over it.
 *  - **Notifications get no reply.** A JSON-RPC message with no `id` is a
 *    notification: answering one is a protocol violation, and over a pipe it
 *    desynchronizes a client that is matching replies to ids. `handle` returns
 *    `null` for those, and the transport must not write anything.
 *  - **Tool failures are results, not errors.** A tool that ran and failed
 *    comes back as a normal result with `isError: true`, because the model
 *    needs to read the reason and try again. A JSON-RPC error is reserved for
 *    the protocol failing: unknown method, unknown tool, malformed params.
 *  - **Structured output is version-gated.** `outputSchema` / `structuredContent`
 *    arrived in 2025-06-18. Older clients ignore unknown fields, but sending a
 *    field the negotiated version does not define is exactly the kind of thing
 *    a strict client rejects, so they are withheld below that version. Every
 *    tool also renders its result as text, so nothing is lost.
 */

import { availableTools, callTool, type ToolContext, type ToolDefinition } from "./tools";
import { buildPrompt, PROMPT_DESCRIPTORS } from "./prompts";
import { readResource, RESOURCE_TEMPLATES, RESOURCES } from "./resources";
import { redact } from "./redact";

/** Newest revision this server implements. */
export const LATEST_PROTOCOL_VERSION = "2025-06-18";

/** Every revision it can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** First revision carrying `outputSchema` / `structuredContent`. */
const STRUCTURED_OUTPUT_SINCE = "2025-06-18";

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP's own code for `resources/read` against a URI we do not serve. */
  ResourceNotFound: -32002,
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
}

export interface ServerOptions {
  info: ServerInfo;
  /** One-paragraph description of what this server is for, handed to the
   *  client at initialize so the model knows when to reach for it. */
  instructions: string;
  toolContext: ToolContext;
}

function success(id: JsonRpcId, result: Record<string, unknown>): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function failure(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  const error: JsonRpcFailure["error"] = { code, message: redact(message) };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/** Negotiate against what the client asked for. An unknown (or newer) version
 *  is answered with ours rather than refused — see the note above. */
export function negotiateVersion(requested: unknown): string {
  if (typeof requested === "string") {
    const match = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested);
    if (match) return match;
  }
  return LATEST_PROTOCOL_VERSION;
}

/** Tool listing entry, shaped for the negotiated protocol version. */
function describeTool(tool: ToolDefinition, structured: boolean): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
  if (structured) entry.outputSchema = tool.outputSchema;
  return entry;
}

export class McpServer {
  private readonly options: ServerOptions;
  private negotiated: string = LATEST_PROTOCOL_VERSION;
  private initialized = false;

  constructor(options: ServerOptions) {
    this.options = options;
  }

  /** The protocol version agreed with the client (or the newest we speak,
   *  before a handshake). */
  get protocolVersion(): string {
    return this.negotiated;
  }

  /** True once the client has confirmed the handshake. Nothing is gated on it —
   *  a client that pipelines its first call is served — it exists so the
   *  transport can say "connected" once, and so the tests can assert that the
   *  full three-step handshake really completed. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  private get structuredOutput(): boolean {
    return this.negotiated >= STRUCTURED_OUTPUT_SINCE;
  }

  private get tools(): ToolDefinition[] {
    return availableTools(this.options.toolContext.config);
  }

  /**
   * Handle one parsed JSON-RPC message. Returns the response to write back, or
   * `null` when there is nothing to say — a notification, or a message that is
   * a response to us rather than a request of us.
   */
  async handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(message)) {
      // Batching was permitted through 2025-03-26 and removed in 2025-06-18.
      // Answering one costs nothing and keeps an older client working.
      if (message.length === 0) {
        return failure(null, ErrorCode.InvalidRequest, "An empty batch is not a request.");
      }
      const answers: JsonRpcResponse[] = [];
      for (const entry of message) {
        const answer = await this.handle(entry);
        if (Array.isArray(answer)) answers.push(...answer);
        else if (answer) answers.push(answer);
      }
      return answers.length > 0 ? answers : null;
    }

    if (!message || typeof message !== "object") {
      return failure(null, ErrorCode.InvalidRequest, "A JSON-RPC message must be an object.");
    }
    const envelope = message as Record<string, unknown>;

    // A result/error coming the other way is an answer to a request we did not
    // make. Ignore it rather than replying, which would loop.
    if (envelope.method === undefined) return null;

    if (envelope.jsonrpc !== "2.0") {
      return failure(
        typeof envelope.id === "string" || typeof envelope.id === "number" ? envelope.id : null,
        ErrorCode.InvalidRequest,
        'Every message must carry `"jsonrpc": "2.0"`.',
      );
    }
    if (typeof envelope.method !== "string") {
      return failure(null, ErrorCode.InvalidRequest, "`method` must be a string.");
    }

    const hasId = typeof envelope.id === "string" || typeof envelope.id === "number";
    const params = (envelope.params ?? {}) as Record<string, unknown>;

    if (!hasId) {
      await this.handleNotification(envelope.method, params);
      return null;
    }

    const id = envelope.id as JsonRpcId;
    try {
      return await this.handleRequest(id, envelope.method, params);
    } catch (e) {
      return failure(id, ErrorCode.InternalError, `Internal error: ${(e as Error).message}`);
    }
  }

  /** Parse and handle one raw line. Malformed JSON is answered, not dropped:
   *  a client that sent garbage is owed an explanation. */
  async handleLine(line: string): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      return failure(null, ErrorCode.ParseError, `Invalid JSON: ${(e as Error).message}`);
    }
    return this.handle(parsed);
  }

  private async handleNotification(
    method: string,
    _params: Record<string, unknown>,
  ): Promise<void> {
    if (method === "notifications/initialized") {
      this.initialized = true;
    }
    // Everything else — `notifications/cancelled`, a client's progress updates —
    // is accepted silently. A notification never gets an answer, including an
    // error, so an unknown one has nowhere to go and must not stop the server.
  }

  private async handleRequest(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    switch (method) {
      case "initialize":
        return this.initialize(id, params);

      case "ping":
        // Liveness only; the spec defines an empty result.
        return success(id, {});

      case "tools/list":
        return success(id, {
          tools: this.tools.map((tool) => describeTool(tool, this.structuredOutput)),
        });

      case "tools/call":
        return this.callTool(id, params);

      case "resources/list":
        return success(id, { resources: RESOURCES });

      case "resources/templates/list":
        return success(id, { resourceTemplates: RESOURCE_TEMPLATES });

      case "resources/read":
        return this.readResource(id, params);

      case "prompts/list":
        return success(id, { prompts: PROMPT_DESCRIPTORS });

      case "prompts/get":
        return this.getPrompt(id, params);

      default:
        return failure(id, ErrorCode.MethodNotFound, `This server does not implement ${method}.`);
    }
  }

  private initialize(id: JsonRpcId, params: Record<string, unknown>): JsonRpcResponse {
    this.negotiated = negotiateVersion(params.protocolVersion);
    return success(id, {
      protocolVersion: this.negotiated,
      capabilities: {
        // Nothing this server exposes changes while it runs: the tool set is
        // fixed at boot by the config, and the templates are compiled in. So
        // no listChanged notifications, and no resource subscriptions.
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: this.options.info,
      instructions: this.options.instructions,
    });
  }

  private async callTool(id: JsonRpcId, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const name = params.name;
    if (typeof name !== "string") {
      return failure(id, ErrorCode.InvalidParams, "`name` must be the tool's name.");
    }
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      const known = this.tools.map((t) => t.name).join(", ");
      // Deliberately a protocol error, not an `isError` result: the tool does
      // not exist, so there is no tool run to report the failure of.
      return failure(
        id,
        ErrorCode.InvalidParams,
        `No tool named ${JSON.stringify(name)}. Available: ${known}.`,
      );
    }
    const rawArgs = params.arguments;
    if (
      rawArgs !== undefined &&
      (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))
    ) {
      return failure(id, ErrorCode.InvalidParams, "`arguments` must be an object.");
    }

    // `callTool` validates the arguments and scrubs credentials out of the
    // result, so nothing is left to do here but shape it for the negotiated
    // protocol version.
    const outcome = await callTool(
      tool,
      rawArgs as Record<string, unknown> | undefined,
      this.options.toolContext,
    );
    const result: Record<string, unknown> = { content: outcome.content };
    if (outcome.isError) result.isError = true;
    if (this.structuredOutput && outcome.structuredContent) {
      result.structuredContent = outcome.structuredContent;
    }
    return success(id, result);
  }

  private readResource(id: JsonRpcId, params: Record<string, unknown>): JsonRpcResponse {
    const uri = params.uri;
    if (typeof uri !== "string") {
      return failure(id, ErrorCode.InvalidParams, "`uri` must be the resource's URI.");
    }
    const contents = readResource(uri);
    if (!contents) {
      return failure(id, ErrorCode.ResourceNotFound, `No resource at ${uri}.`, { uri });
    }
    return success(id, { contents: [contents] });
  }

  private getPrompt(id: JsonRpcId, params: Record<string, unknown>): JsonRpcResponse {
    const name = params.name;
    if (typeof name !== "string") {
      return failure(id, ErrorCode.InvalidParams, "`name` must be the prompt's name.");
    }
    const args = params.arguments;
    const built = buildPrompt(
      name,
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : undefined,
    );
    if ("error" in built) {
      return failure(id, ErrorCode.InvalidParams, built.error);
    }
    return success(id, built as unknown as Record<string, unknown>);
  }
}
