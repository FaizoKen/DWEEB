# Tickets — a DWEEB plugin

Attach this to an **interactive button** ("Open a ticket") or a **string select**
(a topic menu) in DWEEB and members can open a **private support ticket** — no
moderator in the loop to create the channel. When a Discord user clicks:

1. the plugin runs an **anti-spam check** (open-ticket limit + cooldown),
2. optionally pops an **intake form** (a modal you design),
3. creates a **private channel** only the opener + your staff can see,
4. posts a **welcome message** (templated) with **Close** / **Claim** controls,
5. replies privately with a link to the new ticket.

Staff **claim** a ticket to take ownership, **close** it (with an optional
reason) to either delete the channel or lock it for the record, and a best-effort
**HTML transcript** is filed to your log channel on the way out.

Classic uses: support desks, report intake, application reviews, modmail-style
contact buttons, "talk to an admin" panels with per-topic routing.

It's a single small Rust service that *is* its own registry, config UI, config
API, and Discord interactions endpoint — backed by one SQLite file. Like
[Self Role](../self-role/) it needs a **bot token**, because creating a channel
and setting who can see it are Discord REST calls that require **Manage Channels**
and **Manage Roles**.

```
DWEEB  ──reads──▶  GET /registry.json
DWEEB  ──embeds─▶  GET /config.html  ◀─connect/save─▶  /api/connect, /api/instances  ──▶  SQLite
Discord ─clicks─▶  POST /interactions
   open  ──▶ (intake modal?) ──▶ create private channel ──▶ welcome + controls ──▶ ephemeral link
   claim ──▶ mark claimed, disable the button (edit the control message)
   close ──▶ (reason modal?) ──▶ transcript → log ──▶ delete  OR  lock + Reopen/Delete
```

## What a great ticket system needs — and what this does

| Need | How it's handled |
|---|---|
| **One private space per ticket** | A `#ticket-0001` (or `#ticket-name`) text channel under your category, with overwrites that hide it from `@everyone` and grant the opener, your staff roles, and the bot. |
| **Triage up front** | An optional **intake form** (0–5 modal questions) shown *before* the channel is created; answers are posted at the top of the ticket. |
| **Topic routing** | On a **string select** panel each option is a topic (Billing, Bug, …). DWEEB wires + locks the option values for you (see below); the ticket is tagged with the chosen topic. |
| **Staff handling** | Designated **staff roles** see every ticket; a **Claim** button assigns ownership so two people don't double up. |
| **Clean close** | **Close** asks for an optional reason (doubles as a confirmation), files a transcript, then **deletes** the channel or **locks** it (read-only, with **Reopen** / **Delete**). |
| **Records** | A self-contained **HTML transcript** (last ~300 messages) uploaded to your **log channel**, plus open/close log lines. |
| **Anti-spam** | A per-member **open-ticket limit** and a **cooldown** between opens, enforced *before* a channel is ever created. |
| **Friendly setup** | Quick path = pick your staff role and Save; everything else has a sane default behind **Advanced options**. A permission pre-flight names the exact fix before you save. |

## Component targets & the topic-value contract

`button` → one "Open a ticket" flow. `string_select` → a **topic menu**: each
option opens a ticket tagged with that topic.

Because DWEEB stores only the component's `custom_id`, a select's **options live
in your DWEEB message**, not in the plugin. The contract: **each option's
`value` = the topic id**. You never type that out — on **Save** the config UI
hands DWEEB the finished option list (label = topic name, value = topic id) over
the plugin protocol's `options` field, and DWEEB **wires them onto the Select
Menu and locks them**, exactly as it locks the plugin-owned `custom_id`. To
change the topics you reconfigure here; hand-editing the option values is
disabled so the value↔topic contract can't drift. A click is matched only
against the configured topics, so a crafted client can't smuggle in an unknown
one.

## In-ticket controls

Every ticket opens with a control row:

- **Close** *(opener — if allowed — or staff)* — asks for an optional reason,
  then closes per your **close mode**.
- **Claim** *(staff)* — records who owns the ticket and disables the button.

A **locked** ticket (close mode = *lock*) shows **Reopen** and **Delete**
(staff only) instead. Reopen restores the opener's access and renames the
channel back; Delete files nothing new and removes it.

## Architecture & safety

| Concern | How it's handled |
|---|---|
| Interaction authenticity | Ed25519 signature verified on the **raw** body before parsing ([`discord.rs`](src/discord.rs)). Bad/missing signature → `401`. Custom-app signatures verified with the dispatcher-attested key. |
| Who can reconfigure a panel | The instance id is 128 bits of CSPRNG entropy, carried inside the Discord `custom_id` (not visible to normal users). Knowing it is the capability; there is no separate account system. |
| Who can close / claim / reopen | Re-derived from the interaction every time: staff = holding a configured staff role **or** Administrator / Manage Server / Manage Channels. The opener may close only if the panel allows it. Never trusts a client-supplied flag. |
| Topic integrity | A submitted select value is matched against the configured topics; an unknown value is refused, not acted on. |
| Bot-token leakage | The token is never per-instance and never stored — it lives only in `BOT_TOKEN`, so the browser never receives it and the database holds no secret. |
| SSRF | The token is only ever sent to `discord.com` (a fixed host); there is no user-supplied URL to abuse. |
| Mention injection | The welcome and every system message set `allowed_mentions` explicitly — it pings only the opener / staff roles you opted into, so an `@everyone` in a topic name or template can never ping the channel. Transcript notes suppress all mentions. |
| Reply within Discord's 3s window | The multi-call flows **defer**: the click is acked instantly and the channel work (create + post, or transcript + delete) runs off-path, editing the deferred reply when done. Single calls use a 2.5s client timeout. |
| Permission mistakes | The most common ticket failure. The config pre-flight flags a missing **Manage Channels** / **Manage Roles** *before* you save and names the fix; a runtime refusal replies in plain language ("I need Manage Channels and Manage Roles…") and is kept distinct from "Discord was busy — try again". |
| Resource bounds | ≤ 20 staff roles, ≤ 25 topics, ≤ 5 intake questions, welcome ≤ 1500 chars, custom reply ≤ 500, open limit ≤ 50, cooldown ≤ 1 day; audit-log reasons clamped to ASCII; transcript capped at ~300 messages. |

The **decision** core is pure and unit-tested — the anti-spam gate, the staff
check, channel naming, the permission overwrites, the welcome/controls/transcript
builders, and `custom_id` routing all live in [`discord.rs`](src/discord.rs) with
no I/O. Run `cargo test`.

> **Long-lived tickets and the component TTL.** The in-ticket **Close** / **Claim**
> buttons are ordinary message components, so the dispatcher's
> `COMPONENT_TTL_DAYS` (default 7, counted from the welcome message's send time)
> applies: a click on a ticket older than the window is disabled instead of
> forwarded. Most tickets close well within a week, but if yours can stay open
> longer, set `COMPONENT_TTL_DAYS=0` (no expiry) on the dispatcher — see the
> [dispatcher README](../dispatcher/README.md). The panel button itself is a
> normal DWEEB message and can be made permanent the usual way.

## The bot

Tickets **always uses the shared DWEEB bot** to manage ticket channels — there is
no bring-your-own-bot option in the config UI. The operator configures it once
with `BOT_TOKEN` (a bot with **Manage Channels** + **Manage Roles**); end users
only ever *invite* it.

The config UI then needs zero setup in the common case:

- **Zero-touch (the default on DWEEB)**: the editor is open against a connected
  server, so the UI asks DWEEB for the current server (the `guild` resource),
  connects with the DWEEB bot, runs the permission pre-flight, and drops you onto
  the staff/category pickers. No token, no Server ID. If the bot isn't in that
  server yet (or is missing a permission) the status line says exactly that and
  offers the `BOT_INVITE_URL` one-click add.
- **No server connected**: the UI does **not** ask for a raw Server ID — a
  hand-typed id is what causes a panel to be set up for the wrong server. It
  points you back to the builder to connect your server, after which this panel
  targets that exact server automatically.

Because the bot is **shared** across plugins and Discord's invite is destructive
on re-authorization (it *replaces* a bot's permissions, never merges), every
DWEEB invite URL requests the **same union** — currently **Manage Channels +
Manage Roles + Manage Webhooks** (`805306384`). Tickets normalizes any
operator-supplied `BOT_INVITE_URL` to that union at startup, and the value is
mirrored in the DWEEB frontend (`src/core/guild/config.ts`) and every other
plugin. Bump them all together when a plugin's needs change. (Manage Webhooks is
required by the proxy's Send/Restore webhook picker, not by tickets itself, but
the shared invite must carry it so re-inviting through this link doesn't strip
it.)

> **Operators:** the `BOT_TOKEN` grants full bot access, not just channel
> management. Treat the plugin's database as a secret store and only run plugins
> you trust — the same reason the DWEEB registry is bundled and curated. If
> `BOT_TOKEN` is unset, the config UI says so and Tickets can't open tickets.

## Run locally

```bash
cd plugins/tickets
cp .env.example .env          # set DISCORD_PUBLIC_KEY (your app's public key)
cargo run                      # listens on http://localhost:8093
```

DWEEB's plugin list is bundled, so this plugin's manifest ships in
`src/core/plugins/registry.json` pointing at `http://localhost:8093/config.html`
in dev. Restart `pnpm dev`, drop a button or select into a message, and attach
**Tickets** from the plugin picker.

To receive real interactions, expose `/interactions` publicly (the production
path is the dispatcher) and set `BOT_TOKEN` to a bot with **Manage Channels** +
**Manage Roles**.

## Deploy (cheapest path)

```bash
docker build -t dweeb-tickets plugins/tickets
docker run -p 8093:8093 \
  -e DISCORD_PUBLIC_KEY=… \
  -e PUBLIC_BASE_URL=https://tickets.example.com \
  -e BOT_TOKEN=… \
  -v tickets-data:/data \
  dweeb-tickets
```

The image is a single binary on `debian-slim` (just CA certs); SQLite is
bundled. It runs comfortably on the free/cheapest tier of Fly.io, Railway,
Render, or a $5 VPS. Give it a small persistent volume for the `.db` file (it
holds open-ticket state, not just config). On the DWEEB production stack it's
wired exactly like the other plugins — see [`docs/plugins.md` §5](../../docs/plugins.md).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. |
| GET | `/registry.json` | DWEEB plugin registry (one plugin). CORS-open. |
| GET | `/config.html` | The config iframe DWEEB embeds. |
| GET | `/api/meta` | Whether a hosted bot exists + its invite URL. |
| POST | `/api/connect` | Probe a guild with the shared bot → roles, channels, and the bot's permission status. Stores nothing. |
| POST | `/api/instances` | Create a panel → `{ id }`. |
| GET | `/api/instances/:id` | Read a panel's config. |
| PUT | `/api/instances/:id` | Replace a panel's config. |
| POST | `/interactions` | Discord interactions (signature-verified). |

## Files

| File | Role |
|---|---|
| [`src/main.rs`](src/main.rs) | Wiring: env, router, listen. |
| [`src/config.rs`](src/config.rs) | Env parsing (incl. the shared bot + invite-permission union). |
| [`src/store.rs`](src/store.rs) | SQLite: panel configs, the ticket rows (also the anti-spam ledger), and per-panel numbering. |
| [`src/discord.rs`](src/discord.rs) | Signature verify, interaction parsing, and the **pure** decisions/builders (anti-spam gate, staff check, overwrites, welcome/controls/transcript) — unit-tested. |
| [`src/rest.rs`](src/rest.rs) | Discord REST: connect/pre-flight (config), and create/post/rename/overwrite/delete + transcript (clicks). |
| [`src/validate.rs`](src/validate.rs) | Input validation. |
| [`src/routes.rs`](src/routes.rs) | HTTP handlers + the ticket lifecycle flows. |
| [`static/config.html`](static/config.html) | The config iframe (bot → staff/channels → welcome → advanced). |
