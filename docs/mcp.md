# DWEEB over MCP

DWEEB ships an **MCP server** (`mcp/`) so an AI assistant can build, check, and
post Discord **Components V2** messages using the same schema, validator,
templates, and wire encoder as the web app.

It is not a second implementation. Every tool below is a thin shell around
`src/core` — the validator is `core/schema/validation.ts`, the payload encoder
is `core/serialization/normalize.ts`, the webhook client is
`core/webhook/send.ts`, the templates are `src/data/presets.ts`, and the
authoring guide is `server/src/ai_prompt.txt`, the one text already shared
between the Rust proxy and the browser's AI panel. A message posted through MCP
is byte-for-byte the message the editor would have posted, and a schema change
that breaks the server fails the same `bun run test` that made it.

```
      MCP client (Claude Code, Claude Desktop, …)
                    │  stdio · JSON-RPC
                    ▼
      ┌─────────────────────────────┐
      │  mcp/  protocol · tools     │
      └──────────────┬──────────────┘
                     │ imports, never reimplements
      ┌──────────────┴──────────────┐
      │  src/core  schema · encode  │───▶ Discord webhook API
      │            validate · send  │───▶ DWEEB proxy (short links only)
      └─────────────────────────────┘
```

## Quick start

```bash
bun run mcp:check     # what this environment would give the server
bun run mcp           # serve MCP on stdio
```

With no configuration at all the server can already list templates, explain the
schema, validate, preview, and produce share links — the whole build loop. Give
it a webhook and it can also post, edit, and delete.

## Connecting a client

The server is one command: `bun /path/to/DWEEB/mcp/src/main.ts`. Point any MCP
client at it.

**Claude Code**

```bash
claude mcp add dweeb -e DWEEB_WEBHOOK_URL=https://discord.com/api/webhooks/… \
  -- bun /path/to/DWEEB/mcp/src/main.ts
```

**Claude Desktop, Cursor, and anything else taking JSON config**

```json
{
  "mcpServers": {
    "dweeb": {
      "command": "bun",
      "args": ["/path/to/DWEEB/mcp/src/main.ts"],
      "env": {
        "DWEEB_WEBHOOKS": "{\"announcements\": \"https://discord.com/api/webhooks/…\"}"
      }
    }
  }
}
```

Use an absolute path to `bun` if the client does not inherit your shell's
`PATH` (`which bun`). Node cannot run the entry directly — the server imports
TypeScript straight out of `src/core` through the repository's `@/…` alias,
which Bun resolves from `tsconfig.json`.

## Environment

Every value is trimmed, and a value that is present but unparseable is a **boot
error**, not a fall back to the default — the same rule as the proxy's
`config.rs`, for the same reason: a server that starts with permissions the
operator did not grant is worse than one that does not start.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DWEEB_WEBHOOK_URL` | — | One Discord webhook URL, named `default`. |
| `DWEEB_WEBHOOKS` | — | JSON object of `{"name": "webhook url"}` pairs. |
| `DWEEB_APP_URL` | `https://dweeb.faizo.net` | DWEEB deployment share links point at. |
| `DWEEB_PROXY_URL` | `https://api.dweeb.faizo.net` | Proxy used for short links. Set it **empty** to disable them, and the server never contacts any DWEEB backend. |
| `DWEEB_MCP_READ_ONLY` | `false` | `1/true/yes/on` withholds every tool that changes Discord. |
| `DWEEB_MCP_TIMEOUT_MS` | `15000` | Deadline per outbound request (1000–120000). |

A destination is referred to by **name**, never by URL: a webhook URL is a
bearer credential, and naming it keeps the token out of the model's context and
out of the conversation transcript.

## Tools

| Tool | What it does |
| --- | --- |
| `describe_schema` | The Components V2 authoring guide and the hard limits. No network, no configuration. |
| `list_templates` | The built-in templates, filterable by category or search (which also matches each template's own message text). |
| `get_template` | One template's complete payload, its outline, and its validation report. |
| `validate_message` | Discord's rules, run before Discord runs them — every problem named by its **path** in the payload. |
| `preview_message` | The message re-stated as the layout a reader sees. |
| `create_share_link` | A link that opens the message in DWEEB's visual editor. Local by default; `short: true` uploads it to the proxy. |
| `read_share_link` | A share link, short link, or token, decoded back into a message. |
| `list_webhooks` | The configured destinations, by name. Never their URLs. |
| `inspect_webhook` | Who owns a destination — which decides whether its buttons can ever respond. |
| `send_message` | Post. Validated first; refused outright if Discord would reject it. |
| `fetch_message` | Read back a message this destination posted, as an editable payload. |
| `update_message` | Replace a posted message. Complete replacement, not a merge. |
| `delete_message` | Permanently delete a posted message. |

Every tool that takes a `message` accepts four shapes: the payload object, a
string of its JSON, a DWEEB share link or token, or a short link. So a message a
person built in the visual editor can be handed straight back for editing.

### Resources

`dweeb://guide` (the authoring guide), `dweeb://limits` (the numeric caps),
`dweeb://templates` (the index), and `dweeb://templates/{id}` (one payload).
These duplicate three of the tools on purpose — every client offers tools to the
model, not every client surfaces resources.

### Prompts

`build_message`, `revise_message`, and `audit_message` — each one spells out the
order that actually works (build → validate → preview → share for review → only
then post), because a message is cheap to fix before it is posted and awkward
afterwards.

## What keeps this safe

- **Credentials never travel.** Destinations are named; the webhook URL stays in
  the server's environment. Every tool result is scrubbed on the way out
  (`redact.ts`), so a webhook token cannot reach the transcript even if the model
  put one in a button's URL or an upstream error quoted the request.
- **Nothing is posted that Discord would reject.** `send_message` and
  `update_message` validate first and refuse, with the reason, before any
  request is made.
- **Read-only mode withholds rather than refuses.** `DWEEB_MCP_READ_ONLY=1`
  removes the three mutating tools from `tools/list` entirely — a tool a model
  can see is one it will plan around, and offering to post and then refusing is
  a worse experience than never offering.
- **Share links stay local by default.** The message is encoded into the URL
  fragment and uploaded nowhere, exactly as the web app's own share link works.
  `short: true` is the opt-in that publishes it to the proxy for 7 days, and it
  is refused in read-only mode.
- **Annotations are honest.** `readOnlyHint` describes what a tool *can* do, not
  what it usually does, because that is what a client uses to decide what to
  auto-approve — so `create_share_link` is not read-only, even though its default
  path uploads nothing, since `short: true` publishes the message.
  `destructiveHint` is set on the two tools that overwrite or delete.

## Not included, on purpose

- **File uploads.** The editor can attach real files because the browser holds
  the bytes; a stdio server has no equivalent, and reading arbitrary local files
  is not a capability a message builder should acquire. Point media at `https://`
  URLs. A payload referencing `attachment://…` validates as an error, with the
  reason.
- **The guild features** — scheduling, the server message library, never-expire
  slots, plans, the Activity. Each is gated on a signed-in Discord session held
  by the proxy as a cookie, which this server has no way to hold and no business
  minting. Those live in the web app.
- **Plugin configuration.** Wiring a button to a plugin happens in a sandboxed
  config iframe with a browser-local management token. The MCP server can build a
  message carrying an interactive component, but the component is configured in
  DWEEB — `create_share_link` is the hand-off.

## Layout

```
mcp/src/
  main.ts        executable entry (the only file that starts anything)
  index.ts       CLI flags, config → server assembly
  protocol.ts    JSON-RPC + MCP: initialize, tools, resources, prompts
  stdio.ts       newline-delimited framing, backpressure, one line per message
  tools.ts       every tool: schema, annotations, handler
  message.ts     the single funnel every message argument enters through
  render.ts      the text outline `preview_message` returns
  guide.ts       the authoring guide, sliced from the shared prompt template
  resources.ts   dweeb:// resources
  prompts.ts     the workflow prompts
  config.ts      environment → config, loudly
  discord.ts     Discord calls, on top of core/webhook/send.ts
  jsonschema.ts  the checker that enforces the published schemas
  redact.ts      credential scrubbing
```

**There is no MCP SDK dependency.** The protocol surface a stdio server needs is
small and stable, and the official TypeScript SDK brings ninety-odd transitive
packages — a web framework, a JOSE implementation, two JSON-Schema validators —
to run a pipe. Speaking it directly keeps the server dependency-free (`bun run
mcp` needs no install step), keeps its tests inside the repository's existing
`bun run test`, and matches how the rest of this codebase is built. The trade is
that spec correctness is ours to hold, so `protocol.test.ts` covers version
negotiation, notifications, batching, error codes, and the version gate on
structured output.

**Only stdio.** No HTTP transport: it would need its own authentication story
for a server that can post to a Discord channel, and every client that matters
launches a local command.

## Tests

`bun run test` covers the server along with everything else — 150-odd cases over
the config parser, the message funnel, the renderer, the schema checker, the
tool handlers (each one's structured output validated against the schema that
tool publishes), the protocol, and the transport, including a full handshake
driven through `main` over in-memory streams.
