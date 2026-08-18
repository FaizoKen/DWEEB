import { afterEach, describe, expect, it, vi } from "vitest";

import { ComponentType } from "@/core/schema/types";
import { encodeShare } from "@/core/serialization/encode";
import { attachEditorFields } from "@/core/serialization/normalize";
import { TEMPLATES } from "@/data/presets";

import { loadConfig, type Env } from "./config";
import { WebhookInfoCache } from "./discord";
import { validateAgainstSchema } from "./jsonschema";
import { hasWebhookToken } from "./redact";
import { ALL_TOOLS, availableTools, callTool, type ToolContext, type ToolResult } from "./tools";

const HOOK_ID = "123456789012345678";
const HOOK_TOKEN = "abcdefghijklmnop-TOKEN";
const HOOK = `https://discord.com/api/webhooks/${HOOK_ID}/${HOOK_TOKEN}`;
const EXECUTE = `${HOOK}?wait=true&with_components=true`;

const TEXT_MESSAGE = {
  components: [{ type: ComponentType.TextDisplay, content: "# Hello\nA short post." }],
};

/** A message Discord would refuse: a link button with no URL. */
const BROKEN_MESSAGE = {
  components: [
    {
      type: ComponentType.ActionRow,
      components: [{ type: ComponentType.Button, style: 5, label: "Broken" }],
    },
  ],
};

type FetchMock = ReturnType<typeof vi.fn>;

interface Harness {
  ctx: ToolContext;
  fetchMock: FetchMock;
}

/** Build a tool context with a scripted `fetch`. The same mock backs both the
 *  injected `fetchImpl` (short links) and the global (Discord, reached through
 *  the app's own webhook client). */
function harness(env: Env = {}, responder: (url: string, init?: RequestInit) => Response): Harness {
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) =>
    Promise.resolve(responder(String(input), init)),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    ctx: {
      config: loadConfig(env),
      webhookInfo: new WebhookInfoCache(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    },
  };
}

const refuse = (url: string): Response => {
  throw new Error(`unexpected request to ${url}`);
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Call a tool the way the protocol layer does — arguments through the published
 * schema — and assert the result conforms to the schema the tool advertises.
 * Every call in this file goes through here, so a result that would break a
 * client validating structured output fails a test instead.
 */
async function run(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  const outcome = await callTool(tool, args, ctx);
  expect(
    validateAgainstSchema(outcome.structuredContent, tool.outputSchema),
    `${name} returned structured content its own outputSchema rejects`,
  ).toEqual([]);
  expect(hasWebhookToken(text(outcome))).toBe(false);
  return outcome;
}

function text(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ─── The surface itself ─────────────────────────────────────────────── */

describe("the tool surface", () => {
  it("declares unique names, titles, and descriptions", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of ALL_TOOLS) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.annotations.title, tool.name).toBe(tool.title);
    }
  });

  it("closes every input schema, so a mistyped argument is caught not ignored", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  // Both branches of every handler answer with `ok`, which is why an error
  // result still satisfies the declared output schema.
  it("puts `ok` on every output schema", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.outputSchema.required, tool.name).toEqual(["ok"]);
    }
  });

  it("marks exactly the tools that change Discord as mutating", () => {
    const mutating = ALL_TOOLS.filter((t) => t.mutates).map((t) => t.name);
    expect(mutating).toEqual(["send_message", "update_message", "delete_message"]);
  });

  // `readOnlyHint` describes what a tool *can* do, not what it usually does —
  // it is what a client uses to decide what to auto-approve. `create_share_link`
  // is local by default but can publish the message, so it is not read-only,
  // even though it changes nothing on Discord and survives read-only mode.
  it("claims read-only only where nothing can be written anywhere", () => {
    const writers = ALL_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
    expect(writers).toEqual([
      "create_share_link",
      "send_message",
      "update_message",
      "delete_message",
    ]);
    for (const tool of ALL_TOOLS) {
      if (tool.mutates) expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
    }
  });

  // A tool a model can see is one it will plan around; offering to post and
  // then refusing is worse than never offering.
  it("withholds the mutating tools entirely in read-only mode", () => {
    const readOnly = availableTools(loadConfig({ DWEEB_MCP_READ_ONLY: "1" }));
    expect(readOnly.map((t) => t.name)).not.toContain("send_message");
    expect(readOnly).toHaveLength(ALL_TOOLS.length - 3);
    expect(availableTools(loadConfig({}))).toHaveLength(ALL_TOOLS.length);
  });
});

describe("argument checking", () => {
  it("rejects an argument the tool never declared", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run("list_templates", { serach: "welcome" }, ctx);
    expect(outcome.isError).toBe(true);
    expect(text(outcome)).toContain("not a recognised argument");
  });

  it("rejects a required argument that is missing", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run("get_template", {}, ctx);
    expect(text(outcome)).toContain("id is required");
  });

  it("applies a declared default", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run("describe_schema", {}, ctx);
    expect(text(outcome)).toContain("## Message object shape");
    expect(text(outcome)).toContain("## Limits, as data");
  });
});

/* ─── Building ───────────────────────────────────────────────────────── */

describe("describe_schema", () => {
  it("can hand back just the numbers", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run("describe_schema", { section: "limits" }, ctx);
    expect(text(outcome)).toContain("TOTAL_CHARACTERS = 4000");
    expect(outcome.structuredContent?.guide).toBeUndefined();
  });
});

describe("list_templates / get_template", () => {
  it("lists everything by default", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run("list_templates", {}, ctx);
    expect(outcome.structuredContent?.count).toBe(TEMPLATES.length);
  });

  it("filters by category and by search, including the message's own text", async () => {
    const { ctx } = harness({}, refuse);
    const byCategory = await run("list_templates", { category: "Welcome" }, ctx);
    const listed = byCategory.structuredContent?.templates as Array<{ category: string }>;
    expect(listed.every((t) => t.category === "Welcome")).toBe(true);

    const bySearch = await run("list_templates", { search: "giveaway" }, ctx);
    expect(bySearch.structuredContent?.count as number).toBeGreaterThan(0);
  });

  it("refuses an unknown category rather than answering with everything", async () => {
    const { ctx } = harness({}, refuse);
    expect(text(await run("list_templates", { category: "Nope" }, ctx))).toContain(
      "must be one of",
    );
  });

  it("returns a template as a wire payload with no editor ids", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run("get_template", { id: "welcome" }, ctx);
    const message = outcome.structuredContent?.message as Record<string, unknown>;
    expect(JSON.stringify(message)).not.toContain("_id");
    expect(message.flags).toBe(1 << 15);
    expect((outcome.structuredContent?.report as { ok: boolean }).ok).toBe(true);
  });

  it("lists the available ids when asked for one that does not exist", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run("get_template", { id: "welcom" }, ctx);
    expect(outcome.isError).toBe(true);
    expect(text(outcome)).toContain("welcome");
  });

  // Every template must be structurally sound. The one legitimate exception is
  // a link-plugin template whose URL still carries a `{token}` the server owner
  // has to paste their own finished link over — the validator blocks send on
  // that deliberately, and reporting it is the point.
  it("hands back every template in a state the validator accepts", async () => {
    const { ctx } = harness({}, refuse);
    for (const template of TEMPLATES) {
      const outcome = await run("get_template", { id: template.id }, ctx);
      const report = outcome.structuredContent?.report as {
        ok: boolean;
        errors: Array<{ code: string }>;
      };
      const unexpected = report.errors.filter((e) => e.code !== "BUTTON_LINK_URL_UNFINISHED");
      expect(unexpected, template.id).toEqual([]);
    }
  });
});

describe("validate_message", () => {
  it("passes a good message and names the fault in a bad one", async () => {
    const { ctx } = harness({}, refuse);
    expect(text(await run("validate_message", { message: TEXT_MESSAGE }, ctx))).toContain("Valid");

    const bad = await run("validate_message", { message: BROKEN_MESSAGE }, ctx);
    expect(text(bad)).toContain("BUTTON_URL_INVALID");
    expect(text(bad)).toContain("components[0].components[0]");
  });

  // Reporting is the whole job; a malformed payload must not escape as a throw.
  it("describes a payload it cannot even parse", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run(
      "validate_message",
      { message: { components: [{ type: ComponentType.Section, components: [] }] } },
      ctx,
    );
    expect(outcome.isError).toBe(true);
    expect(text(outcome)).toContain("accessory");
  });
});

describe("preview_message", () => {
  it("outlines the layout", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run("preview_message", { message: TEXT_MESSAGE }, ctx);
    expect(text(outcome)).toContain("¶ Text");
    expect(outcome.structuredContent?.stats).toMatchObject({ total_components: 1 });
  });
});

/* ─── Sharing ────────────────────────────────────────────────────────── */

describe("create_share_link", () => {
  it("encodes the message into the URL and uploads nothing", async () => {
    const { ctx, fetchMock } = harness({ DWEEB_APP_URL: "https://dweeb.example" }, refuse);
    const outcome = await run("create_share_link", { message: TEXT_MESSAGE }, ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.structuredContent?.url).toBe(
      `https://dweeb.example/#s=${outcome.structuredContent?.token}`,
    );
    expect(text(outcome)).toContain("never sent to any server");
  });

  it("round-trips back through read_share_link", async () => {
    const { ctx } = harness({}, refuse);
    const shared = await run("create_share_link", { message: TEXT_MESSAGE }, ctx);
    const back = await run("read_share_link", { link: shared.structuredContent?.url }, ctx);
    expect(back.structuredContent?.message).toMatchObject(TEXT_MESSAGE);
    expect(back.structuredContent?.source).toBe("share-url");
  });

  it("uploads only when asked, and answers with the short URL", async () => {
    const { ctx, fetchMock } = harness({ DWEEB_PROXY_URL: "https://api.example" }, (url) =>
      url === "https://api.example/api/shortlink" ? json({ id: "Ab3xY9" }) : refuse(url),
    );
    const outcome = await run("create_share_link", { message: TEXT_MESSAGE, short: true }, ctx);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(outcome.structuredContent?.short_url).toBe("https://dweeb.faizo.net/s/Ab3xY9");
  });

  // Read-only means nothing leaves this machine, and a short link publishes the
  // message to a server.
  it("refuses to upload in read-only mode, and says what to do instead", async () => {
    const { ctx, fetchMock } = harness({ DWEEB_MCP_READ_ONLY: "true" }, refuse);
    const outcome = await run("create_share_link", { message: TEXT_MESSAGE, short: true }, ctx);
    expect(outcome.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text(outcome)).toContain("read-only");
  });

  it("reports a short-link service that refuses", async () => {
    const { ctx } = harness({ DWEEB_PROXY_URL: "https://api.example" }, () =>
      json({ error: "Rate limited." }, 429),
    );
    const outcome = await run("create_share_link", { message: TEXT_MESSAGE, short: true }, ctx);
    expect(outcome.isError).toBe(true);
    expect(text(outcome)).toContain("Rate limited.");
  });
});

describe("read_share_link", () => {
  it("accepts a bare token", async () => {
    const { ctx } = harness({}, refuse);
    const token = encodeShare(attachEditorFields(TEXT_MESSAGE));
    const outcome = await run("read_share_link", { link: token }, ctx);
    expect(outcome.structuredContent?.source).toBe("share-token");
  });

  it("explains a link that carries no message", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run("read_share_link", { link: "https://dweeb.faizo.net/" }, ctx);
    expect(outcome.isError).toBe(true);
  });
});

/* ─── Destinations ───────────────────────────────────────────────────── */

describe("list_webhooks", () => {
  it("names the destinations and never their tokens", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOKS: `{"news": "${HOOK}"}` }, refuse);
    const outcome = await run("list_webhooks", {}, ctx);
    expect(text(outcome)).toContain("news");
    expect(text(outcome)).not.toContain(HOOK_TOKEN);
    expect(JSON.stringify(outcome.structuredContent)).not.toContain(HOOK_TOKEN);
  });

  it("says how to configure one when there is none", async () => {
    const { ctx } = harness({}, refuse);
    expect(text(await run("list_webhooks", {}, ctx))).toContain("DWEEB_WEBHOOK_URL");
  });
});

describe("inspect_webhook", () => {
  it("reports the channel, the server, and who owns it", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, (url) =>
      url === HOOK
        ? json({
            id: HOOK_ID,
            name: "Announcer",
            channel_id: "555",
            guild_id: "777",
            type: 1,
          })
        : refuse(url),
    );
    const outcome = await run("inspect_webhook", {}, ctx);
    expect(text(outcome)).toContain("channel:    555");
    // A person made this one in Server Settings, so buttons would never respond.
    expect(text(outcome)).toContain("will NOT respond");
  });

  it("recognises an application-owned webhook, where components do work", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, () =>
      json({ id: HOOK_ID, name: "Bot hook", channel_id: "555", type: 3, application_id: "999" }),
    );
    expect(text(await run("inspect_webhook", {}, ctx))).toContain("can work here");
  });

  it("names the configured destinations when asked for an unknown one", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOKS: `{"news": "${HOOK}"}` }, refuse);
    const outcome = await run("inspect_webhook", { webhook: "staff" }, ctx);
    expect(outcome.isError).toBe(true);
    expect(text(outcome)).toContain("news");
  });
});

/* ─── Posting ────────────────────────────────────────────────────────── */

describe("send_message", () => {
  it("posts, and answers with the id and a link to the message", async () => {
    const { ctx, fetchMock } = harness({ DWEEB_WEBHOOK_URL: HOOK }, (url, init) => {
      if (init?.method === "POST" && url === EXECUTE) {
        return json({ id: "1188888888888888888", channel_id: "555" });
      }
      if (url === HOOK) return json({ id: HOOK_ID, channel_id: "555", guild_id: "777", type: 3 });
      return refuse(url);
    });
    const outcome = await run("send_message", { message: TEXT_MESSAGE }, ctx);
    expect(outcome.isError).toBeUndefined();
    expect(outcome.structuredContent?.message_id).toBe("1188888888888888888");
    expect(outcome.structuredContent?.link).toBe(
      "https://discord.com/channels/777/555/1188888888888888888",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The body Discord receives has to be the one the editor would have sent.
  it("sends the wire payload, flags and all", async () => {
    let body: Record<string, unknown> | null = null;
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, (url, init) => {
      if (init?.method === "POST") {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ id: "1188888888888888888", channel_id: "555" });
      }
      return json({ id: HOOK_ID, channel_id: "555", type: 3 });
    });
    await run("send_message", { message: TEXT_MESSAGE }, ctx);
    expect(body!.flags).toBe(1 << 15);
    expect(JSON.stringify(body)).not.toContain("_id");
  });

  // A message Discord would reject costs a round-trip and an error nobody can
  // act on, so it never leaves.
  it("refuses to send a message that would not survive Discord", async () => {
    const { ctx, fetchMock } = harness({ DWEEB_WEBHOOK_URL: HOOK }, refuse);
    const outcome = await run("send_message", { message: BROKEN_MESSAGE }, ctx);
    expect(outcome.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text(outcome)).toContain("Not posted");
    expect(text(outcome)).toContain("BUTTON_URL_INVALID");
  });

  it("passes Discord's own complaint through when it refuses", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, () =>
      json(
        {
          code: 50035,
          message: "Invalid Form Body",
          errors: { components: { 0: { _errors: [{ message: "This field is required" }] } } },
        },
        400,
      ),
    );
    const outcome = await run("send_message", { message: TEXT_MESSAGE }, ctx);
    expect(outcome.isError).toBe(true);
    expect(text(outcome)).toContain("Invalid Form Body");
    expect(text(outcome)).toContain("components[0]: This field is required");
  });

  it("still reports the post when the jump link cannot be resolved", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, (url, init) => {
      if (init?.method === "POST") return json({ id: "1188888888888888888", channel_id: "555" });
      return json({ message: "Unknown Webhook" }, 404);
    });
    const outcome = await run("send_message", { message: TEXT_MESSAGE }, ctx);
    expect(outcome.isError).toBeUndefined();
    expect(outcome.structuredContent?.message_id).toBe("1188888888888888888");
    expect(outcome.structuredContent?.link).toBeUndefined();
  });

  it("says what to configure when there is no destination at all", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run("send_message", { message: TEXT_MESSAGE }, ctx);
    expect(outcome.isError).toBe(true);
    expect(text(outcome)).toContain("DWEEB_WEBHOOK_URL");
  });

  it("refuses to guess between several destinations", async () => {
    const { ctx } = harness(
      {
        DWEEB_WEBHOOKS: `{"news": "${HOOK}", "staff": "${HOOK.replace(HOOK_ID, "223456789012345678")}"}`,
      },
      refuse,
    );
    const outcome = await run("send_message", { message: TEXT_MESSAGE }, ctx);
    expect(outcome.isError).toBe(true);
    expect(text(outcome)).toContain("name one with `webhook`");
  });

  it("posts into a thread when one is named", async () => {
    let seen = "";
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, (url, init) => {
      if (init?.method === "POST") {
        seen = url;
        return json({ id: "1188888888888888888", channel_id: "555" });
      }
      return json({ id: HOOK_ID, channel_id: "555", type: 3 });
    });
    await run("send_message", { message: TEXT_MESSAGE, thread_id: "444" }, ctx);
    expect(seen).toContain("thread_id=444");
  });
});

describe("fetch_message / update_message / delete_message", () => {
  const MESSAGE_URL = `${HOOK}/messages/1188888888888888888?with_components=true`;

  it("reads a posted message back as an editable payload", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, (url) =>
      url === MESSAGE_URL ? json({ ...TEXT_MESSAGE, flags: 1 << 15 }) : refuse(url),
    );
    const outcome = await run("fetch_message", { message_id: "1188888888888888888" }, ctx);
    expect(outcome.structuredContent?.message).toMatchObject(TEXT_MESSAGE);
  });

  it("accepts a Discord message link in place of an id", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, (url) =>
      url === MESSAGE_URL ? json({ ...TEXT_MESSAGE, flags: 1 << 15 }) : refuse(url),
    );
    const outcome = await run(
      "fetch_message",
      { message_id: "https://discord.com/channels/777/555/1188888888888888888" },
      ctx,
    );
    expect(outcome.structuredContent?.message_id).toBe("1188888888888888888");
  });

  it("rejects something that is neither an id nor a link", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, refuse);
    const outcome = await run("fetch_message", { message_id: "the last one" }, ctx);
    expect(outcome.isError).toBe(true);
  });

  it("validates before replacing a live message", async () => {
    const { ctx, fetchMock } = harness({ DWEEB_WEBHOOK_URL: HOOK }, refuse);
    const outcome = await run(
      "update_message",
      { message_id: "1188888888888888888", message: BROKEN_MESSAGE },
      ctx,
    );
    expect(outcome.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text(outcome)).toContain("Not updated");
  });

  it("replaces a message and reports the link", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, (url, init) => {
      if (init?.method === "PATCH") return json({ id: "1188888888888888888", channel_id: "555" });
      if (url === HOOK) return json({ id: HOOK_ID, channel_id: "555", guild_id: "777", type: 3 });
      return refuse(url);
    });
    const outcome = await run(
      "update_message",
      { message_id: "1188888888888888888", message: TEXT_MESSAGE },
      ctx,
    );
    expect(outcome.structuredContent?.link).toBe(
      "https://discord.com/channels/777/555/1188888888888888888",
    );
  });

  it("deletes a message", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, (_url, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : refuse(_url),
    );
    const outcome = await run("delete_message", { message_id: "1188888888888888888" }, ctx);
    expect(outcome.isError).toBeUndefined();
    expect(outcome.structuredContent?.message_id).toBe("1188888888888888888");
  });

  it("reports a delete Discord refuses", async () => {
    const { ctx } = harness({ DWEEB_WEBHOOK_URL: HOOK }, () =>
      json({ code: 10008, message: "Unknown Message" }, 404),
    );
    const outcome = await run("delete_message", { message_id: "1188888888888888888" }, ctx);
    expect(outcome.isError).toBe(true);
    expect(text(outcome)).toContain("Unknown Message");
  });
});

/* ─── Credentials ────────────────────────────────────────────────────── */

describe("webhook tokens", () => {
  // A model can put anything in a message, including a webhook URL — and the
  // preview and the JSON both echo it straight back into the transcript.
  it("are scrubbed out of a result even when the message itself carries one", async () => {
    const { ctx } = harness({}, refuse);
    const outcome = await run(
      "preview_message",
      {
        message: {
          components: [
            {
              type: ComponentType.ActionRow,
              components: [{ type: ComponentType.Button, style: 5, label: "Hook", url: HOOK }],
            },
          ],
        },
      },
      ctx,
    );
    // `run` asserts the absence for every call; assert the surviving half here.
    expect(text(outcome)).toContain(`webhooks/${HOOK_ID}/`);
    expect(text(outcome)).not.toContain(HOOK_TOKEN);
  });
});
