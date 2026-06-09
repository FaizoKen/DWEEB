# Modal Form — a DWEEB plugin

Attach this to an **interactive button** in DWEEB. When a Discord user clicks it:

1. a **modal** (a form you design) pops up,
2. their answers are **forwarded to a webhook** (e.g. a staff channel),
3. they get an **ephemeral reply** built from one of your DWEEB **saved messages**.

Classic uses: applications, suggestions, ticket intake, report forms.

It's a single small Rust service that *is* its own registry, config UI, config
API, and Discord interactions endpoint — backed by one SQLite file. No bot
token, no database server, no Discord REST calls. That makes it cheap to host.

```
DWEEB  ──reads──▶  GET /registry.json
DWEEB  ──embeds─▶  GET /config.html  ◀──saves config──▶  /api/instances  ──▶  SQLite
Discord ─clicks─▶  POST /interactions  ──modal──▶  user
                          │ submit
                          ├─ forwards answers ──▶  your Discord webhook
                          └─ replies with your saved message (ephemeral)
```

## Architecture & safety

| Concern | How it's handled |
|---|---|
| Interaction authenticity | Ed25519 signature verified on the **raw** body before parsing ([`discord.rs`](src/discord.rs)). Bad/missing signature → `401`. |
| Who can reconfigure an instance | The instance id is 128 bits of CSPRNG entropy, carried inside the Discord `custom_id` (not visible to normal users). Knowing it is the capability; there's no separate account system. |
| Secret leakage | The forward webhook URL is **write-only**: `GET` masks it to a boolean, so the browser never receives it. |
| SSRF | The forward target is restricted to Discord webhook hosts + `/api/webhooks/` paths ([`validate.rs`](src/validate.rs)). |
| Reply within Discord's 3s window | The forward POST uses a 3s client timeout and is best-effort; the user's reply is sent regardless. |
| Resource bounds | 1–5 fields, title ≤45, reply payload ≤16 KB, values clamped to Discord limits. |

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
| [`src/store.rs`](src/store.rs) | SQLite store + config/mask types. |
| [`src/discord.rs`](src/discord.rs) | Signature verify, interaction types, callbacks. |
| [`src/validate.rs`](src/validate.rs) | Input validation + SSRF guard. |
| [`src/routes.rs`](src/routes.rs) | HTTP handlers. |
| [`static/config.html`](static/config.html) | The config iframe (modal builder + saved-message picker). |
