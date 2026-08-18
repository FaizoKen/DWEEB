# DWEEB over MCP

DWEEB speaks the **Model Context Protocol** so an AI assistant can build, check,
and post Discord **Components V2** messages using DWEEB's own schema, validator,
and templates.

There are **two servers**, because the two ways a client connects have genuinely
different shapes:

| | **Local** (`mcp/`) | **Remote** (`server/src/mcp/`) |
| --- | --- | --- |
| Transport | stdio — the client launches it | HTTPS at `/mcp` |
| Clients | Claude Code, Claude Desktop, Cursor | claude.ai custom connectors, anything remote |
| Auth | none — it is your own process | OAuth 2.1, Discord as the identity provider |
| Destination | webhook URLs you configure | the servers and channels *your Discord account* can reach |
| Language | TypeScript, importing `src/core` | Rust, inside the existing proxy |

Pick the local one if your client can launch a command; it is simpler, needs no
account, and posts through webhook URLs you hold. Pick the remote one for
claude.ai, or when a client must connect over the network.

Neither is a second implementation of Discord's rules. The local server
*imports* `src/core`. The remote server cannot (it is Rust), so its data is
**generated** from the same source and its validator is **pinned** to the
TypeScript one by a shared corpus — see [Keeping the two in step](#keeping-the-two-in-step).

```
  Claude Code / Desktop            claude.ai / remote clients
          │ stdio                            │ HTTPS + OAuth
          ▼                                  ▼
  ┌───────────────────┐            ┌─────────────────────────┐
  │ mcp/  (TypeScript)│            │ server/src/mcp/  (Rust) │
  └─────────┬─────────┘            └────────────┬────────────┘
            │ imports                           │ generated data
            │                                   │ + pinned rules
  ┌─────────┴───────────────────────────────────┴────────────┐
  │  src/core — schema · validation · encoding · templates    │
  └───────────────────────────────────────────────────────────┘
```

---

# The local server (`mcp/`)

Every tool is a thin shell around `src/core` — the validator is
`core/schema/validation.ts`, the payload encoder is
`core/serialization/normalize.ts`, the webhook client is `core/webhook/send.ts`,
the templates are `src/data/presets.ts`, and the authoring guide is
`server/src/ai_prompt.txt`, the one text already shared between the Rust proxy
and the browser's AI panel. A message posted through MCP is byte-for-byte the
message the editor would have posted, and a schema change that breaks the server
fails the same `bun run test` that made it.

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

**Only stdio.** The remote form is a separate server, in Rust, inside the
proxy — see below.

## Tests

`bun run test` covers the server along with everything else — 150-odd cases over
the config parser, the message funnel, the renderer, the schema checker, the
tool handlers (each one's structured output validated against the schema that
tool publishes), the protocol, and the transport, including a full handshake
driven through `main` over in-memory streams.

---

# The remote server (`server/src/mcp/`)

Lives inside the Rust proxy and serves MCP over HTTPS at `/mcp`, guarded by an
OAuth 2.1 authorization server. This is the one claude.ai's **custom connectors**
can talk to.

**Off by default.** It is a public, internet-reachable surface through which an
AI client can post to people's Discord channels, so a deployment opts in
(`MCP_ENABLED=true`) rather than inheriting it on upgrade. While off, every route
answers `501` — including the discovery documents, so a client is never sent
through a whole OAuth flow to reach a dead end.

## Connecting from claude.ai

Settings → Connectors → **Add custom connector**, and give it the MCP URL:

```
https://api.dweeb.faizo.net/mcp
```

Leave the OAuth fields blank. The client registers itself
([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591) dynamic registration),
discovers the authorization server, sends you to Discord to sign in, and comes
back with a token. You are authorizing **your own Discord account** — the
connector can reach exactly the servers and channels you can.

## How the authorization works

```
claude.ai ──1─▶ /mcp                     401 + WWW-Authenticate: …resource_metadata=…
          ──2─▶ /.well-known/oauth-protected-resource    → names the authorization server
          ──3─▶ /.well-known/oauth-authorization-server  → endpoints, S256 required
          ──4─▶ POST /oauth/register                     → client_id (public, no secret)
  browser ──5─▶ GET /oauth/authorize  ──▶ discord.com/oauth2/authorize
                                      ◀── /auth/callback?state=mcp_<sealed>
          ◀─6──  302 back to the client with ?code=…
          ──7─▶ POST /oauth/token  (+ PKCE verifier)     → access token
          ──8─▶ /mcp  Authorization: Bearer …
```

Five things about that flow are deliberate:

- **Discord is the identity provider.** Nothing in DWEEB authenticates a person;
  step 5 hands the browser to Discord and comes back with *your* Discord access
  token. Every MCP call then acts with it, through the same
  `authorize_member_session` / Manage-Webhooks gates the web app and the Activity
  already use. There is no ambient bot authority for a caller to borrow.
- **The authorization request rides in `state`, sealed.** The browser doing the
  Discord round trip belongs to the connector and carries none of our cookies —
  the same problem the Activity's connect flow has, solved the same way: the
  client id, redirect URI, PKCE challenge, and the client's own `state` travel
  AES-GCM sealed inside `state` (its own AAD domain) and are authenticated by
  opening it on the way back.
- **PKCE (S256) is mandatory**, and `plain` is not offered. An authorization code
  intercepted in transit is useless without the verifier.
- **No refresh tokens.** Ours could not refresh Discord's, so once the underlying
  token dies the honest answer is another authorization round trip — which is
  silent while your Discord session is good. An issued token's life is capped at
  the Discord token's, because a bearer that looks alive but resolves to nothing
  is the worst of both.
- **Errors before the redirect URI is verified render as a page, never a
  redirect.** Redirecting an error to an unverified URI is how an open redirector
  gets built.

## Tools

The pure ones are the same as the local server: `describe_schema`,
`list_templates`, `get_template`, `validate_message`, `preview_message`,
`create_share_link`. The Discord-facing ones are expressed in **servers and
channels** rather than webhook URLs, because there is no credential for a remote
caller to hold:

| Tool | What it does |
| --- | --- |
| `list_servers` | Your Discord servers, with whether the DWEEB bot is present and whether you hold Manage Webhooks. Posting needs both. |
| `list_channels` | The channels in one server, with the kind of each — a forum or media channel needs the message to carry a post title, and every other kind rejects one. |
| `send_message` | Post to a channel. Validated against Discord's rules *and* against that channel's kind before anything is sent. |
| `fetch_message` | Read back a message DWEEB posted, as an editable payload. |
| `update_message` | Replace a message DWEEB posted. Complete replacement, not a merge. |

`send_message` resolves (or creates) DWEEB's own webhook in the channel — the
same one the Activity posts through — so components bound to DWEEB plugins work,
and no webhook URL ever reaches the client.

## Storage and lifetime

`MCP_DB_PATH` (default `/data/mcp.db`) holds registered clients, authorization
codes, and access tokens. Nothing bearer-shaped is stored in the clear: codes,
tokens, and client secrets are kept as SHA-256 digests, and the Discord access
token behind a grant is AES-GCM **sealed** under the proxy's key — it has to be
readable, since every call replays it against Discord. A leak of the file alone
lets nobody call anything. Expired codes and tokens are swept hourly.

## Operating it

```bash
MCP_ENABLED=true            # in /opt/dweeb/.env, then `docker compose up -d`
MCP_DB_PATH=/data/mcp.db    # already set by compose; must be on the volume
MCP_PUBLIC_URL=             # only if /mcp is served under a different hostname
```

No Caddy change is needed: the `{$DOMAIN}` block already routes everything to the
proxy. `/ready` covers the MCP store, `/api/capabilities` reports `"mcp"`, and
`server/gatus/config.yaml` carries a commented-out discovery monitor to enable
alongside the feature.

`server/ops/mcp-smoke.sh` drives the real binary over real HTTP — discovery, the
401 challenge, registration, the authorize refusals, the token endpoint, and the
feature gate. Run it after any change here.

## Keeping the two in step

The remote server is Rust, so it cannot import the TypeScript schema layer. Two
different mechanisms keep it honest, and the difference matters:

**Data is generated.** `bun run gen:mcp` (part of `bun run build`) writes
`server/src/mcp/catalog.json` from `src/data/presets.ts` and
`src/core/schema/limits.ts` — all 36 templates, every numeric cap, the core
placeholder tokens, the link-plugin prefixes, and the share-token version.
Editing a template updates the Rust server by regenerating, not by remembering.

**Rules are pinned.** The ~70 validation checks genuinely had to be rewritten, so
the generator also emits `validation-corpus.json`: a hundred-odd messages with
the exact `(code, path)` pairs the TypeScript validator produces for each. Both
implementations are tested against it — `src/core/schema/corpus.test.ts` and the
tests in `server/src/mcp/components.rs`. The generator **refuses** to write a
corpus that does not exercise every code the validator can emit, so a rule added
without a case fails the build. Change a rule and both suites go red until the
port follows.

The same trick covers the share-link encoder: `lz-vectors.json` records
`lz-string`'s output for a set of inputs, and `server/src/mcp/lz.rs` must
reproduce it byte for byte. That one is easy to get subtly wrong — LZ-String
works in UTF-16 code units, so a port iterating Rust `char`s produces links the
browser cannot decode for any message containing an emoji.

If you change a validation rule, a limit, or a template:

```bash
bun run gen:mcp                 # regenerate the catalog, corpus, and vectors
bun run test                    # the TypeScript side of the pin
cd server && cargo test mcp::   # the Rust side
```
