# Quick Replies — a DWEEB plugin

Attach this to an **interactive button** or a **string select** in DWEEB and each
click (or picked option) sends a **canned reply** — text, links, and a few
`{user}`/`{server}` variables — privately to the clicker, or publicly in the
channel. It's the cheapest plugin to host: a click is a pure *config-blob → pick
→ reply*, so there's **no Discord REST call on the hot path and no bot token
required**.

Classic uses: self-service **FAQ**, **server rules**, "where do I find X",
**support macros**, and role-gated **link hubs**.

```
DWEEB   ──reads──▶  GET /registry.json
DWEEB   ──embeds─▶  GET /config.html  ◀─save (+ optional connect)─▶  /api/instances, /api/connect  ──▶  SQLite
Discord ─click───▶  POST /interactions  ──▶  pick reply (pure)  ──▶  ephemeral / public reply
```

## Button vs. topic menu

| Target | Shape | Good for |
|---|---|---|
| **Button** | One button → one canned reply. | A single "📜 Rules", "How to verify", or "Support" button. |
| **String select** | A topic menu → one reply per option (1–25). | A self-service FAQ / link hub where members pick the topic they need. |

For the **select**, the menu's options *are* the plugin's contract: each option's
`value` is the reply's stable key. You never wire that by hand — on **Save** the
config UI hands DWEEB the finished option list (label, emoji, description, value)
over the plugin protocol's `options` field, and DWEEB **wires them onto the
select and locks them**, exactly like it locks the plugin-owned `custom_id`. The
interaction handler only ever acts on a value it recognises, so a crafted client
can't smuggle in an unknown option.

## What makes a reply rich

A reply is more than a line of text:

- **Heading + body** — an optional `### heading` over a Markdown body with links.
  It's sent as a Components V2 **container** (a tidy card), not a bare line.
- **Private or public** — each reply is ephemeral by default (only the clicker
  sees it — ideal for FAQ/support), or flip it to post in the channel.
- **Variables** — `{user}` (a mention), `{username}` (their name), and
  `{server}`, substituted per click from the interaction payload — **no Discord
  lookup**. Unknown `{tokens}` are left untouched.
- **Role-gating** *(optional)* — restrict a reply to members holding **any one
  of** a set of roles. Someone without the role gets a private "this reply is
  for … only" notice instead. Trust is re-derived from the member's payload
  roles, so the gate can't be bypassed by a crafted click.

The config UI shows a **live preview** of every reply as you type (heading,
Markdown, the substituted variables, and the private/public badge), so there are
no surprises when a member clicks.

## How a click becomes a reply

The decision is a pure function of the **interaction payload** alone — no Discord
call, so it always answers well inside Discord's ~3s window:

1. **Which reply** — a button maps to its single reply; a select maps the picked
   option `value` back to its reply key (intersected with the known keys).
2. **Role gate** — if the reply is gated, the member's payload roles must include
   one of the allowed roles, or they get the private "not for you" notice. A
   gated reply used outside a guild (no member roles) fails closed.
3. **Substitute + send** — `{user}`/`{username}`/`{server}` are filled in and the
   reply goes back as the interaction response, ephemeral or public.

Because the reply is just the interaction response, it works whether the message
was posted through a DWEEB webhook **or** a guild's own
[custom bot](../../docs/plugins.md) — the dispatcher routes the click here either
way, and a guild posting with its own bot still gets the exact reply you wrote.

## Variables

| Token | Becomes | Notes |
|---|---|---|
| `{user}` | A mention of the clicker | The only ping a reply may fire (`allowed_mentions` pins it to the clicker). |
| `{username}` | Their display name | Plain text. |
| `{server}` | The server's name | Falls back to "the server" when unknown. |

A **public** reply sets `allowed_mentions` to `{ parse: [], users: [clicker] }`,
so a stray `@everyone`/`@here`/role mention in the text (or in a display name)
never pings the channel — only the clicker can be mentioned, and only via
`{user}`.

## Architecture & safety

| Concern | How it's handled |
|---|---|
| Interaction authenticity | Ed25519 signature verified on the **raw** body before parsing ([`discord.rs`](src/discord.rs)). Bad/missing signature → `401`. Custom-app signatures verified with the dispatcher-attested key (constant-time secret check). |
| Who can reconfigure | The instance id is 128 bits of CSPRNG entropy, carried inside the Discord `custom_id` (invisible to normal users). Knowing it is the capability; there's no separate account system. |
| Option-value integrity | A select's options are wired **and locked** by DWEEB; the handler maps a picked `value` to a known reply key and ignores anything it doesn't recognise — never acting on a raw client-supplied value. |
| Role-gating | Re-derived from the member's payload roles (intersected with the configured set), never from a client claim; fails closed outside a guild. |
| Mention safety | Every reply sets `allowed_mentions` to ping **only** the clicker (`parse: []`), so canned text — or a member's own name — can never `@everyone` the channel. |
| Reply within Discord's 3s window | A click does **zero** outbound I/O — it's a config read and a pure builder. The only Discord call anywhere is the optional config-time role listing. |
| No stored secrets | No bot token, no webhook URL, nothing per-instance to leak — the database holds only your reply text + option keys. |
| Resource bounds | 1–25 replies, body ≤ 1500 chars, title ≤ 200, option label/description ≤ 100, ≤ 25 gate roles per reply. |
| XSS in the config UI | Every Discord-supplied string (role names) is rendered with `textContent`; the live preview escapes input **before** applying its Markdown-lite subset, so a reply body can't inject HTML. |

## The bot (optional)

Quick Replies works with **no bot at all**. If the deployment configures the
shared DWEEB bot (`BOT_TOKEN`), the config UI gains one convenience: the
**role-gate picker** can list a server's roles so you pick "Subscribers" instead
of pasting a role id. A server admin only ever *invites* the bot — never pastes a
token — and the invite's `permissions` are normalized to the same shared union
the other plugins use (Quick Replies itself needs no privileged bit, but the
union must match so re-inviting can't strip another plugin's grant).
`BOT_INVITE_URL` surfaces a one-click "add the bot" button.

> **Operators:** if `BOT_TOKEN` is set it grants full bot access — treat the
> database as a secret store and only run plugins you trust, the same reason the
> DWEEB registry is bundled and curated. If it's unset, the config UI says
> role-gating isn't available; nothing else changes.

## Run locally

```bash
cd plugins/quick-replies
cp .env.example .env          # set DISCORD_PUBLIC_KEY (your app's public key)
cargo run                      # listens on http://localhost:8096
```

DWEEB's plugin list is bundled, so this plugin's manifest ships in
`src/core/plugins/registry.json` pointing at `http://localhost:8096/config.html`
in dev. Restart `pnpm dev`, drop a button or select into a message, and attach
**Quick Replies** from the plugin picker. To receive real interactions, expose
`/interactions` publicly (the production path is the dispatcher).

## Deploy (cheapest path)

```bash
docker build -t dweeb-quick-replies plugins/quick-replies
docker run -p 8096:8096 \
  -e DISCORD_PUBLIC_KEY=… \
  -e PUBLIC_BASE_URL=https://quickreplies.example.com \
  -v quickreplies-data:/data \
  dweeb-quick-replies
```

The image is a single binary on `debian-slim` (just CA certs); SQLite is
bundled. It runs comfortably on the free/cheapest tier of Fly.io, Railway,
Render, or a $5 VPS — and, with no bot token and no hot-path I/O, it's the
lightest plugin to host. Give it a small persistent volume for the `.db` file.
On the DWEEB production stack it's wired exactly like the other plugins — see
[`docs/plugins.md` §5](../../docs/plugins.md).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. |
| GET | `/registry.json` | DWEEB plugin registry (one plugin). CORS-open. |
| GET | `/config.html` | The config iframe DWEEB embeds. |
| GET | `/api/meta` | Whether a shared bot exists (for the gate picker) + its invite URL. |
| POST | `/api/connect` | Probe a guild with the shared bot → its roles for the gate picker. Stores nothing. |
| POST | `/api/instances` | Create a menu → `{ id }`. |
| GET | `/api/instances/:id` | Read a menu's config. |
| PUT | `/api/instances/:id` | Replace a menu's config. |
| POST | `/interactions` | Discord interactions (signature-verified). |

## Files

| File | Role |
|---|---|
| [`src/main.rs`](src/main.rs) | Wiring: env, router, listen. |
| [`src/config.rs`](src/config.rs) | Env parsing (incl. the optional shared bot + invite normalization). |
| [`src/store.rs`](src/store.rs) | SQLite store + config / reply types. |
| [`src/discord.rs`](src/discord.rs) | Signature verify, interaction parsing, and the **pure** core: variable substitution, the role-gate decision, and the Components V2 reply builder. |
| [`src/rest.rs`](src/rest.rs) | The thin (optional) Discord REST: list a guild's roles for the gate picker. |
| [`src/validate.rs`](src/validate.rs) | Input validation for everything the browser sends. |
| [`src/routes.rs`](src/routes.rs) | HTTP handlers + the click → reply flow. |
| [`static/config.html`](static/config.html) | The config iframe (replies, live preview, variables, role-gate). |
