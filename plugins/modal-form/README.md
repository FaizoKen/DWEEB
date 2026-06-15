# Modal Form — a DWEEB plugin

Attach this to an **interactive button** in DWEEB. When a Discord user clicks it:

1. a **form** (a modal you design) pops up,
2. their answers are **forwarded to a channel** via a webhook (e.g. staff intake),
3. they get a private **ephemeral reply** — a **plain message** you type, or one
   of your DWEEB **saved messages**.

Classic uses: applications, suggestions, ticket intake, report forms, feedback
boxes (including **anonymous** ones).

It's a single small Rust service that *is* its own registry, config UI, config
API, and Discord interactions endpoint — backed by one SQLite file. No bot
token, no database server, no Discord REST calls. That makes it cheap to host.

```
DWEEB  ──reads──▶  GET /registry.json
DWEEB  ──embeds─▶  GET /config.html  ◀──saves config──▶  /api/instances  ──▶  SQLite
Discord ─clicks─▶  POST /interactions  ──modal──▶  user
                          │ submit
                          ├─ forwards answers ──▶  your Discord webhook
                          └─ replies with your plain or saved message (ephemeral)
```

## What you can build

| Setting | What it does |
|---|---|
| **Fields (1–5)** | Each is a text input: short or paragraph, **required** or not, with an optional **placeholder**, **prefilled text**, and **min/max length**. Reorder them in the config UI; ids stay stable so answers never get reshuffled. |
| **Where submissions go** | A Discord webhook URL (paste it, or pick a saved DWEEB webhook). Each submission is posted there as a tidy Components V2 message. |
| **Posted-under name** | An optional display name for the forwarded message (defaults to “Modal Form”). |
| **Anonymous mode** | Turn off *“show who submitted”* and the forward never names the member — an anonymous suggestion/report box. |
| **Reply** | A plain message you type, or one of your saved DWEEB messages. Sent privately (ephemeral) the moment they submit. |
| **One response per person** | Optional. After a member submits, a second click is turned away *before* the form opens — perfect for applications. |

The config UI is **stepped, live-previewed, and self-explanatory**: a faux modal
updates as you type so a first-time admin sees exactly what members will get,
and a built-in help panel explains how to grab a webhook URL.

## Why button-only (no select target)

A modal is the natural payload of a **button**. A select menu would leave its
option visibly "stuck" selected after opening the form, and re-clicking the same
option fires nothing — a confusing trigger for a form. So Modal Form targets
`button` only; that's a design choice, not a gap.

## Architecture & safety

| Concern | How it's handled |
|---|---|
| Interaction authenticity | Ed25519 signature verified on the **raw** body before parsing ([`discord.rs`](src/discord.rs)). Bad/missing signature → `401`. Custom-app signatures verified with the dispatcher-attested key. |
| Who can reconfigure an instance | The instance id is 128 bits of CSPRNG entropy, carried inside the Discord `custom_id` (not visible to normal users). Knowing it is the capability; there's no separate account system. |
| Secret leakage | The forward webhook URL is **write-only**: `GET` masks it to a boolean, so the browser never receives it. |
| SSRF | The forward target is restricted to Discord webhook hosts + `/api/webhooks/` paths ([`validate.rs`](src/validate.rs)). |
| Mention injection | The forward sets `allowed_mentions: { parse: [] }`, so an `@everyone`/`@here`/role mention a member pastes into an answer **can't ping** the destination channel. |
| Reply within Discord's 3s window | The forward POST uses a **2.5s** client timeout and is best-effort; the user's reply is sent regardless of its outcome. |
| One-response integrity | The submission is recorded only when the forward actually reached Discord, so a transient failure can't lock a member out forever. |
| Resource bounds | 1–5 fields, title ≤45, field labels ≤45, placeholders ≤100, prefills ≤4000, min ≤ max, reply payload ≤16 KB, values clamped to Discord limits. |

The **pure core** (building the modal, the forward message, and the reply, plus
all validation) is unit-tested; run `cargo test`.

## Run locally

```bash
cd plugins/modal-form
cp .env.example .env          # set DISCORD_PUBLIC_KEY (your app's public key)
cargo run                      # listens on http://localhost:8090
```

DWEEB's plugin list is bundled, so add this plugin's manifest to
`src/core/plugins/registry.json` (it ships there by default pointing at
`http://localhost:8090/config.html`), then restart `pnpm dev`. The canonical
manifest is what this service returns at `GET /registry.json` — copy it in,
swapping `configUrl` for your deployed origin when you go to production.

To receive real interactions, expose `/interactions` publicly (e.g. `cloudflared
tunnel`, ngrok, or a deploy) and set that URL as your app's **Interactions
Endpoint URL** in the Discord Developer Portal. Set `PUBLIC_BASE_URL` to the
same public origin so the embedded config URL matches.

## Deploy (cheapest path)

```bash
docker build -t dweeb-modal-form plugins/modal-form
docker run -p 8090:8090 \
  -e DISCORD_PUBLIC_KEY=… \
  -e PUBLIC_BASE_URL=https://modalform.example.com \
  -v modalform-data:/data \
  dweeb-modal-form
```

The image is a single binary on `debian-slim` (just CA certs); SQLite is bundled.
It runs comfortably on the free/cheapest tier of Fly.io, Railway, Render, or a
$5 VPS. Give it a small persistent volume for the `.db` file.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. |
| GET | `/registry.json` | DWEEB plugin registry (one plugin). CORS-open. |
| GET | `/config.html` | The config iframe DWEEB embeds. |
| POST | `/api/instances` | Create an instance → `{ id }`. |
| GET | `/api/instances/:id` | Read an instance (webhook masked). |
| PUT | `/api/instances/:id` | Replace an instance. Empty `forward_webhook` keeps the existing one. |
| POST | `/interactions` | Discord interactions (signature-verified). |

## Files

| File | Role |
|---|---|
| [`src/main.rs`](src/main.rs) | Wiring: env, router, listen. |
| [`src/config.rs`](src/config.rs) | Env parsing. |
| [`src/store.rs`](src/store.rs) | SQLite store (instances + per-form submission ledger) + config/mask types. |
| [`src/discord.rs`](src/discord.rs) | Signature verify, interaction types, and the pure modal/forward/reply builders (unit-tested). |
| [`src/validate.rs`](src/validate.rs) | Input validation + SSRF guard (unit-tested). |
| [`src/routes.rs`](src/routes.rs) | HTTP handlers + the interaction flow. |
| [`static/config.html`](static/config.html) | The config iframe (stepped builder, live preview, reply picker). |
