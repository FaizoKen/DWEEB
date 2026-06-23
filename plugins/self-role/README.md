# Self Role — a DWEEB plugin

Attach this to an **interactive button** or a **string select** in DWEEB and
members can give themselves the roles you choose — no moderator in the loop.
When a Discord user clicks:

1. the plugin works out which roles to **add or remove** (based on your mode),
2. it makes the change with the shared **DWEEB bot**,
3. they get a private **ephemeral reply** — an automatic “Added **Red**” summary,
   or a custom message you wrote.

Classic uses: colour pickers, pronoun/region roles, opt-in pings, “verify” /
rules-agreement buttons, reaction-role boards (the modern button version).

> **This is DWEEB's reference plugin** — new plugins are measured against it.
> See the quality bar in [`docs/plugins.md` §6](../../docs/plugins.md).

It's a single small Rust service that *is* its own registry, config UI, config
API, and Discord interactions endpoint — backed by one SQLite file. The one
thing it needs that the stateless plugins don't is a **bot token**, because
assigning a role is a Discord REST call (`PUT …/members/{user}/roles/{role}`)
that requires the **Manage Roles** permission.

```
DWEEB  ──reads──▶  GET /registry.json
DWEEB  ──embeds─▶  GET /config.html  ◀─connect/save─▶  /api/connect, /api/instances  ──▶  SQLite
Discord ─clicks─▶  POST /interactions  ──▶  plan add/remove  ──▶  Discord REST (bot token)
                                                              └──▶  ephemeral reply
```

## How a member's click becomes a role change

The behaviour is **two independent axes**, so the basic case stays a one-tap
choice and power users get real flexibility:

**Axis 1 — what a click does** (`mode`):

| Mode | What happens | Good for |
|---|---|---|
| **Toggle** | Flip each requested role (get it, or lose it if you have it). | The default; grab-bag menus, on/off buttons. |
| **Give only** | Only ever adds. | “Verify” / “I agree” / opt-in. |
| **Take only** | Only ever removes. | Opt-out buttons. |

**Axis 2 — how many they can hold** (`max`, select only):

| `max` | Behaviour |
|---|---|
| *(empty)* | No limit — the classic grab-bag. |
| **1** | **Pick one (swap)** — gaining a role evicts the others from this menu. Colours, regions, pronouns. |
| **N ≥ 2** | **Cap** — an add past N is refused with a friendly “you can hold at most N — remove one first”; removes always go through. |

`max = 1` subsumes the old `unique` mode (configs that used it migrate
automatically on read). The decision itself is still one pure, exhaustively
tested function (`plan_changes`).

A **button** manages exactly one role. A **string select** manages 1–25; the
member's picked option **values must be the role IDs**. You don't wire those by
hand — saving the config writes them for you (see below). Either way the plugin
only ever touches roles in the menu's managed set, so a crafted client can't
smuggle in `@admin`.

## More power, still optional

Everything below lives behind an **Advanced options** disclosure in the config
UI — defaults keep the basic flow a three-step affair (roles → behaviour →
save).

- **Per-role emoji & subtitles** *(select only)* — give each option an emoji
  (standard or one of your server's custom emoji, fetched through the bot) and a
  one-line subtitle. DWEEB wires them onto the locked option list.
- **Who can use it** — gate the whole menu behind a role (any-of / all-of) and/or
  a **minimum account age**. The check is pure over the interaction payload — no
  extra Discord call — and a denied click gets a plain-language reason.
- **Temporary roles** — auto-remove a granted role a set time later (1 minute to
  1 year). A crash-safe SQLite **grant ledger** plus a background **reaper**
  (`reaper.rs`) take the role back; the confirmation tells the member when it
  expires (`<t:…:R>`).
- **Audit log** — post “@member gained Red” to a Discord webhook on every change
  (and on auto-expiry). Pick one of your saved webhooks or paste a URL; the URL
  is SSRF-guarded to genuine Discord webhooks and `allowed_mentions` is emptied
  so a log line can never ping.

## Component targets & the option-value contract

`button` → one role. `string_select` → many. Because DWEEB stores only the
component's `custom_id`, the select's **options live in your DWEEB message**, not
in the plugin. The contract is simple: **each option's `Value` = the role's ID.**

You never type that contract out. On **Save**, the config UI hands DWEEB the
finished option list (label = role name, value = role ID) over the plugin
protocol's `options` field, and DWEEB **wires them onto the Select Menu and
locks them** — exactly like it locks the plugin-owned `custom_id`. To change the
options you reconfigure (or detach) the plugin; hand-editing is disabled so the
value↔role-ID contract can't drift. Step 4 of the config UI is now just a
read-only preview of what will be wired.

## Placeholders in your message

Drop **`{roles}`** into your DWEEB message text and it renders the role(s) this
menu grants — so you write *"Click to grab {roles}"* and never hand-paste a role.
It's a **static** placeholder: the value (the role **names**, e.g. *"Red, Blue and
Green"*) is sent to DWEEB on save and painted once when the message is posted, so
there's no live re-render to do here. Names — not `<@&id>` mentions — so posting
the message can never ping a whole role.

DWEEB's built-in **`{server}` / `{channel}`** tokens work here too (they work in
any message). See [the placeholder framework](../../docs/plugins.md#placeholders-message-text-that-follows-your-values).

## Architecture & safety

| Concern | How it's handled |
|---|---|
| Interaction authenticity | Ed25519 signature verified on the **raw** body before parsing ([`discord.rs`](src/discord.rs)). Bad/missing signature → `401`. Custom-app signatures verified with the dispatcher-attested key. |
| Who can reconfigure an instance | The instance id is 128 bits of CSPRNG entropy, carried inside the Discord `custom_id` (not visible to normal users). Knowing it is the capability; there is no separate account system. |
| Bot-token leakage | The bot token is never per-instance and never stored: it lives only in the server's `BOT_TOKEN` env, so the browser never receives it and the database holds no secret. |
| SSRF | The token is only ever sent to `discord.com` (a fixed host) — there is no user-supplied URL to abuse. |
| Privilege escalation | Only roles in the menu's managed set are ever touched; select values are intersected with that set. The bot can only assign roles **below** its own top role, enforced by Discord. The access gate re-derives the member's roles from the payload — never a client-supplied claim. |
| SSRF | Role assignment only ever calls `discord.com` (a fixed host). The one user-supplied URL — the optional audit-log webhook — is pinned to genuine Discord webhook hosts/paths (`validate_webhook`), exactly like Modal Form. |
| Audit-log safety | Posts set `allowed_mentions.parse = []`, so a log line can name roles/users without pinging. The webhook URL is a secret: stored server-side, **masked** (`log_webhook_set: bool`) out of every browser read. |
| Reply within Discord's 3s window | Role add/removes fire **concurrently** with a 2.5s client timeout; the access gate and limit are pure (no I/O); the audit-log post is fired **detached**. The reply is sent regardless and reports what (if anything) Discord refused. |
| Hierarchy mistakes | The most common self-role failure. The config picker flags every role the bot **can't** assign *before* you save, and a runtime refusal replies with a plain-language fix. |
| Temporary-role durability | The grant ledger is SQLite, so the reaper resumes cleanly after a restart. A removal that can never succeed (role gone / now above the bot) is dropped so it can't wedge the queue; a transient failure retries next tick. |
| Resource bounds | 1–25 roles, ≤ 10 gate roles, account-age ≤ 366 days, expiry 1 min–1 year, custom reply ≤ 500 chars, subtitles ≤ 100 chars, names clamped. |

## The bot

Self Role **always uses the shared DWEEB bot** to assign roles — there is no
bring-your-own-bot option in the config UI. The operator configures it once with
`BOT_TOKEN` (a bot with **Manage Roles**); end users never see or paste a token.

The config UI then needs zero setup in the common case:

- **Zero-touch (the default on DWEEB)**: the editor is open against a connected
  server, so step 1 vanishes — the UI asks DWEEB for the current server (the
  `guild` resource), connects with the DWEEB bot, and drops you straight onto the
  role picker. No token, no Server ID, no Connect button. If the bot isn't in
  that server yet (or lacks **Manage Roles**) the status line says so and offers
  the `BOT_INVITE_URL` one-click add.
- **No server connected**: if DWEEB doesn't hand us a server, the UI does **not**
  ask for a raw Server ID — a hand-typed id is exactly what causes a menu to be
  set up for the wrong server ("this menu was set up for a different server"
  later, at click time). Instead it points you back to the builder to connect
  your server (sign-in is required there), after which this menu targets that
  exact server automatically.

Because role assignment is decoupled from who *posts* the menu, the message can
be sent through a DWEEB webhook **or** a guild's own [custom bot](../../docs/plugins.md)
— either way the click reaches this plugin (the dispatcher forwards it) and the
DWEEB bot makes the role change. The **custom reply** is just the interaction
response, so it works in both cases too: a guild posting with its own bot can
word the confirmation in its own voice.

> **Operators:** the `BOT_TOKEN` grants full bot access, not just role
> management. Treat the plugin's database as a secret store and only run plugins
> you trust — the same reason the DWEEB registry is bundled and curated. If
> `BOT_TOKEN` is unset, the config UI says so and Self Role can't assign roles.

## Run locally

```bash
cd plugins/self-role
cp .env.example .env          # set DISCORD_PUBLIC_KEY (your app's public key)
cargo run                      # listens on http://localhost:8092
```

DWEEB's plugin list is bundled, so this plugin's manifest ships in
`src/core/plugins/registry.json` pointing at `http://localhost:8092/config.html`
in dev. Restart `pnpm dev`, drop a button or select into a message, and attach
**Self Role** from the plugin picker.

To receive real interactions, expose `/interactions` publicly (the production
path is the dispatcher) and connect a real bot in the config UI.

## Deploy (cheapest path)

```bash
docker build -t dweeb-self-role plugins/self-role
docker run -p 8092:8092 \
  -e DISCORD_PUBLIC_KEY=… \
  -e PUBLIC_BASE_URL=https://selfrole.example.com \
  -v selfrole-data:/data \
  dweeb-self-role
```

The image is a single binary on `debian-slim` (just CA certs); SQLite is
bundled. It runs comfortably on the free/cheapest tier of Fly.io, Railway,
Render, or a $5 VPS. Give it a small persistent volume for the `.db` file. On
the DWEEB production stack it's wired exactly like the other plugins — see
[`docs/plugins.md` §5](../../docs/plugins.md).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. |
| GET | `/registry.json` | DWEEB plugin registry (one plugin). CORS-open. |
| GET | `/config.html` | The config iframe DWEEB embeds. |
| GET | `/api/meta` | Whether a hosted bot exists + its invite URL. |
| POST | `/api/connect` | Probe a guild with the shared bot → assignable roles **and the server's custom emoji** for the pickers. Stores nothing. |
| POST | `/api/instances` | Create an instance → `{ id }`. |
| GET | `/api/instances/:id` | Read an instance. |
| PUT | `/api/instances/:id` | Replace an instance. |
| POST | `/interactions` | Discord interactions (signature-verified). |

## Files

| File | Role |
|---|---|
| [`src/main.rs`](src/main.rs) | Wiring: env, router, listen. |
| [`src/config.rs`](src/config.rs) | Env parsing (incl. optional shared bot). |
| [`src/store.rs`](src/store.rs) | SQLite store + config/mask types. |
| [`src/discord.rs`](src/discord.rs) | Signature verify, interaction parsing, the pure role-diff (`plan_changes`) + access gate (`check_access`), callbacks. |
| [`src/rest.rs`](src/rest.rs) | Discord REST: list roles/emoji + hierarchy (config), add/remove role (clicks), audit-log webhook post. |
| [`src/reaper.rs`](src/reaper.rs) | The background task that takes back expired temporary roles. |
| [`src/validate.rs`](src/validate.rs) | Input validation + the audit-log webhook SSRF guard. |
| [`src/routes.rs`](src/routes.rs) | HTTP handlers + the interaction flow. |
| [`static/config.html`](static/config.html) | The config iframe (connect → roles → behaviour → customize → advanced → reply). |
