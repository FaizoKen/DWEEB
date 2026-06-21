# Picker — a DWEEB plugin

Attach this to one of Discord's **auto-populated** select menus and give it a
brain. Those four selects — **User**, **Role**, **Mentionable** (user or role)
and **Channel** — fill themselves from the server, so you wire no options by
hand; but each one says *"needs a bot to handle clicks"* in the DWEEB builder.
**Picker is that bot.** When a member makes a selection it replies with their
picks resolved to mentions:

> You selected **@Alice**, **@Bob** and **#general**.

The reply is a **private confirmation** — ephemeral, so only the person who used
the menu sees it. A clean "here's what you picked" acknowledgement that adds no
channel noise.

Classic uses: a private "you selected X" confirmation, a colour/region
*acknowledger*, or a channel quick-jump the member can click from their own
ephemeral reply.

> **No bot token. No Discord REST call on the hot path.** A pick is a pure
> *payload → resolve → reply*, so this is the cheapest plugin in the set to host —
> the same shape as [`quick-replies`](../quick-replies) and
> [`ping-pong`](../ping-pong), minus even the one optional role-list call.

```
DWEEB  ──reads──▶  GET /registry.json
DWEEB  ──embeds─▶  GET /config.html  ◀─save─▶  /api/instances  ──▶  SQLite
Discord ─picks──▶  POST /interactions  ──▶  resolve picks → mentions  ──▶  reply
```

## How a selection becomes a reply

It's a pure function of three things — the menu's **kind** (which select it's
attached to), the **snowflakes** the member picked, and the instance's **reply
config**:

1. **Classify** each picked id. The select's component type fixes the kind for
   User (`<@id>`), Role (`<@&id>`) and Channel (`<#id>`) selects. A **Mentionable**
   select mixes users and roles, so each id is a role iff Discord listed it under
   the interaction's `resolved.roles`, else a user.
2. **Render** them as a human list into `{picks}` — *"@Alice, @Bob and #general"*.
3. **Substitute** the reply's tokens and send it as a private (ephemeral) reply.

The whole decision (`classify_picks` / `build_reply` in [`discord.rs`](src/discord.rs))
is one pure, exhaustively-tested function with no I/O.

## Tokens in your reply

Write these in the heading or message and they fill in per pick:

| Token | Becomes |
|---|---|
| `{picks}` | The picks as mentions — `@Alice, @Bob and #general` (user/role mentions, or `#channel` links for a Channel select). |
| `{count}` | How many they picked. |
| `{user}` | A mention of the person who used the menu. |
| `{username}` | Their display name (no ping). |
| `{server}` | The server's name. |

Unknown `{...}` tokens are left verbatim, so literal braces in prose are safe.

## Always private

Every reply is **ephemeral** — only the member who used the menu sees it, and no
one is notified. It's a private confirmation, so it never adds channel noise and
can't be used to make the bot ping people on a member's behalf.

**Mention safety.** Each reply also sets `allowed_mentions.parse = []`, so even
though the picks render as `<@id>`/`<@&id>` mentions, an `@everyone`/`@here` or
role mention in your template text can never produce a ping (ephemeral replies
don't notify regardless — this is belt-and-braces).

## Component targets

`user_select` · `role_select` · `mentionable_select` · `channel_select`

These are DWEEB's stable names for Discord's auto-populated selects (types
5/6/7/8). Unlike a string select, their options are filled by Discord from the
server at use time — there's nothing for the plugin to wire onto the menu, so it
stores **only** the reply config keyed by the component's `custom_id`.

## Architecture & safety

| Concern | How it's handled |
|---|---|
| Interaction authenticity | Ed25519 signature verified on the **raw** body before parsing ([`discord.rs`](src/discord.rs)). Bad/missing signature → `401`. Custom-app signatures verified with the dispatcher-attested key (`attested_key`, constant-time secret compare). |
| Who can reconfigure an instance | The instance id is 128 bits of CSPRNG entropy, carried inside the Discord `custom_id` (not visible to normal users). Knowing it is the capability; there is no separate account system. |
| No secrets | There is no bot token and no webhook to store — the database holds only reply text. Nothing sensitive ever reaches the browser. |
| No SSRF | The service makes **zero** outbound requests; there is no user-supplied URL and no third-party host to abuse. |
| Trusting the payload, not the client | Picked ids are filtered to real snowflakes and classified from the interaction's own `component_type`/`resolved` — never from a client-supplied claim. |
| Reply within Discord's 3s window | A pick is answered straight from the payload (no I/O), so the only latency is the dispatcher hop. |
| Resource bounds | Heading ≤ 200 chars, body ≤ 1500, and the rendered reply is clamped to the Components V2 text cap. |

## Run locally

```bash
cd plugins/picker
cp .env.example .env          # set DISCORD_PUBLIC_KEY (your app's public key)
cargo run                      # listens on http://localhost:8097
```

DWEEB's plugin list is bundled, so this plugin's manifest ships in
`src/core/plugins/registry.json` pointing at `http://localhost:8097/config.html`
in dev. Restart the web dev server, drop a **User / Role / Mentionable / Channel
select** into a message, and attach **Picker** from the plugin picker.

To receive real interactions, expose `/interactions` publicly (the production
path is the dispatcher) and post the message through an application-owned webhook
so Discord delivers its component interactions to the dispatcher.

## Deploy (cheapest path)

```bash
docker build -t dweeb-picker plugins/picker
docker run -p 8097:8097 \
  -e DISCORD_PUBLIC_KEY=… \
  -e PUBLIC_BASE_URL=https://picker.example.com \
  -v picker-data:/data \
  dweeb-picker
```

The image is a single binary on `debian-slim`; SQLite is bundled and there is no
outbound HTTP. It runs comfortably on the free/cheapest tier of Fly.io, Railway,
Render, or a $5 VPS. On the DWEEB production stack it's wired exactly like the
other plugins — see [`docs/plugins.md` §5](../../docs/plugins.md).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. |
| GET | `/registry.json` | DWEEB plugin registry (one plugin). CORS-open. |
| GET | `/config.html` | The config iframe DWEEB embeds. |
| POST | `/api/instances` | Create an instance → `{ id }`. |
| GET | `/api/instances/:id` | Read an instance. |
| PUT | `/api/instances/:id` | Replace an instance. |
| POST | `/interactions` | Discord interactions (signature-verified). |

## Files

| File | Role |
|---|---|
| [`src/main.rs`](src/main.rs) | Wiring: env, router, listen. |
| [`src/config.rs`](src/config.rs) | Env parsing (no bot token — none is needed). |
| [`src/store.rs`](src/store.rs) | SQLite store + the instance config type. |
| [`src/discord.rs`](src/discord.rs) | Signature verify, interaction parsing, the **pure** pick-classify/render/build logic. |
| [`src/validate.rs`](src/validate.rs) | Input validation. |
| [`src/routes.rs`](src/routes.rs) | HTTP handlers + the interaction flow. |
| [`static/config.html`](static/config.html) | The config iframe (heading + message with tokens). |
