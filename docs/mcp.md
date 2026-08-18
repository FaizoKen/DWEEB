# DWEEB over MCP

DWEEB speaks the **Model Context Protocol**, so Claude — or any MCP client — can
build, check, and post Discord **Components V2** messages using DWEEB's own
schema, validator, and templates.

It is a **hosted connector**: you add one URL in Claude, sign in with Discord,
and it works. Nothing to install, clone, or run. In the app it lives under
**More ▸ Connect an AI client**, which hands over the address with a copy button.

```
https://api.dweeb.faizo.net/mcp
```

The server lives inside the Rust proxy (`server/src/mcp/`) because that is where
Discord auth, the guild membership and Manage-Webhooks gates, the webhook
resolution, and the short-link store already are. A caller acts with **your**
Discord token, so it reaches exactly the servers and channels you can — there is
no ambient bot authority to borrow, and no webhook URL ever leaves the server.

```
              Claude (claude.ai, Desktop, Code…)
                          │  HTTPS + OAuth 2.1
                          ▼
              ┌─────────────────────────┐
              │ server/src/mcp/  (Rust) │
              └────────────┬────────────┘
                           │ generated data + pinned rules
              ┌────────────┴────────────┐
              │  src/core — schema ·    │
              │  validation · templates │
              └─────────────────────────┘
```

Being Rust, it cannot import the TypeScript schema layer, so its data is
**generated** from that one source and its validator is **pinned** to the
TypeScript one by a shared corpus — see
[Keeping the two in step](#keeping-the-two-in-step).

---

# The server (`server/src/mcp/`)

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

Six work on a message alone and need nothing configured: `describe_schema`,
`list_templates`, `get_template`, `validate_message`, `preview_message`, and
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

The server is Rust, so it cannot import the TypeScript schema layer that the web
app validates against. Two different mechanisms keep the two in agreement, and
the difference matters:

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
