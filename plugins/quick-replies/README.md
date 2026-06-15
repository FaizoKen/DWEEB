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
- **Or a saved message** — instead of typing a reply, point it at one of your
  **DWEEB saved messages** (the rich Components V2 messages you build and name in
  the editor). The config UI fetches them over the plugin protocol's
  `savedMessages` resource and offers a picker; the chosen one is **snapshotted**
  into the instance, so the reply keeps working even if you later edit or delete
  the original. `{user}`/`{username}`/`{server}` inside a saved message are still
  substituted per click, and mentions are pinned to the clicker exactly like a
  typed reply — a saved message can never `@everyone`. Saved messages are
  client-side content, so **no bot token** is involved and the click path still
  does zero outbound I/O.
- **Always private** — every reply is ephemeral: only the person who clicks sees
  it. That's the right default for FAQ/support/link-hub macros and keeps a busy
  channel quiet no matter how often a button is used.
- **Variables** — `{user}` (a mention), `{username}` (their name), and
  `{server}`, substituted per click from the interaction payload — **no Discord
  lookup**. Unknown `{tokens}` are left untouched.
- **Emoji picker** *(topic menus)* — each topic's dropdown emoji is chosen from a
  picker: a set of common **unicode** emoji plus your server's own **custom
  emoji**, fetched through the shared bot exactly like the DWEEB dashboard. Both
  unicode and custom emoji are wired onto the select option (custom ones as
  `{ id, name, animated }`).
- **Role-gating** *(optional)* — restrict a reply to members holding **any one
  of** a set of roles. Someone without the role gets a private "this reply is
  for … only" notice instead. Trust is re-derived from the member's payload
  roles, so the gate can't be bypassed by a crafted click.

## How a click becomes a reply

The decision is a pure function of the **interaction payload** alone — no Discord
call, so it always answers well inside Discord's ~3s window:

1. **Which reply** — a button maps to its single reply; a select maps the picked
   option `value` back to its reply key (intersected with the known keys).
2. **Role gate** — if the reply is gated, the member's payload roles must include
   one of the allowed roles, or they get the private "not for you" notice. A
   gated reply used outside a guild (no member roles) fails closed.
3. **Substitute + send** — `{user}`/`{username}`/`{server}` are filled in (in the
   typed body, or in every `content` field of a saved message) and the reply goes
   back as the interaction response — **always ephemeral** (only the clicker sees
   it). A reply with a usable saved-message payload sends that; otherwise it sends
   the typed title/body.

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

Every reply sets `allowed_mentions` to `{ parse: [], users: [clicker] }`, so a
stray `@everyone`/`@here`/role mention in the text (or in a display name) never
pings anyone — only the clicker can be mentioned, and only via `{user}`. (Replies
are ephemeral, but the pin is kept defensively regardless.)

## Architecture & safety

| Concern | How it's handled |
|---|---|
| Interaction authenticity | Ed25519 signature verified on the **raw** body before parsing ([`discord.rs`](src/discord.rs)). Bad/missing signature → `401`. Custom-app signatures verified with the dispatcher-attested key (constant-time secret check). |
| Who can reconfigure | The instance id is 128 bits of CSPRNG entropy, carried inside the Discord `custom_id` (invisible to normal users). Knowing it is the capability; there's no separate account system. |
| Option-value integrity | A select's options are wired **and locked** by DWEEB; the handler maps a picked `value` to a known reply key and ignores anything it doesn't recognise — never acting on a raw client-supplied value. |
| Role-gating | Re-derived from the member's payload roles (intersected with the configured set), never from a client claim; fails closed outside a guild. |
| Mention safety | Every reply sets `allowed_mentions` to ping **only** the clicker (`parse: []`), so canned text — or a member's own name — can never `@everyone` the channel. |
| Reply within Discord's 3s window | A click does **zero** outbound I/O — it's a config read and a pure builder. The only Discord calls anywhere are the optional config-time role + custom-emoji listing. |
| No stored secrets | No bot token, no webhook URL, nothing per-instance to leak — the database holds only your reply text/option keys and any snapshotted saved-message content (itself pure content). |
| Saved-message safety | A saved message rides in as Components V2 with the **same** `allowed_mentions` pin as a typed reply; only its `content` text is variable-substituted, so `custom_id`s/URLs are never mangled. A content/embeds-only payload (no V2 components) is ignored and the typed body sends instead. |
| Resource bounds | 1–25 replies, body ≤ 1500 chars, title ≤ 200, saved-message payload ≤ 16 KB, option label/description ≤ 100, ≤ 25 gate roles per reply. |
| XSS in the config UI | Every Discord-supplied string (role names, emoji names/ids) is rendered with `textContent` or as `src`/`alt` attributes, never as HTML, so nothing the bot or browser supplies can inject markup. |

## The bot (optional)

Quick Replies works with **no bot at all**. If the deployment configures the
shared DWEEB bot (`BOT_TOKEN`), the config UI gains two conveniences: the
**role-gate picker** can list a server's roles so you pick "Subscribers" instead
of pasting a role id, and the **emoji picker** can list the server's custom emoji
(both come from the one `/api/connect` probe). A server admin only ever *invites*
the bot — never pastes a token — and the invite's `permissions` are normalized to
the same shared union the other plugins use (Quick Replies itself needs no
privileged bit, but the union must match so re-inviting can't strip another
plugin's grant). `BOT_INVITE_URL` surfaces a one-click "add the bot" button.

> **Operators:** if `BOT_TOKEN` is set it grants full bot access — treat the
> database as a secret store and only run plugins you trust, the same reason the
> DWEEB registry is bundled and curated. If it's unset, the config UI says
> role-gating isn't available and the emoji picker offers standard unicode emoji
> only; nothing else changes.

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
| POST | `/api/connect` | Probe a guild with the shared bot → its roles (gate picker) and custom emoji (emoji picker). Stores nothing. |
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
| [`src/rest.rs`](src/rest.rs) | The thin (optional) Discord REST: list a guild's roles + custom emoji for the config pickers. |
| [`src/validate.rs`](src/validate.rs) | Input validation for everything the browser sends. |
| [`src/routes.rs`](src/routes.rs) | HTTP handlers + the click → reply flow. |
| [`static/config.html`](static/config.html) | The config iframe (replies, saved-message + emoji pickers, variables, role-gate). |
