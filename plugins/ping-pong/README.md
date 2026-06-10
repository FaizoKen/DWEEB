# Ping Pong — a DWEEB plugin

Attach this to an **interactive button** in DWEEB. When a Discord user clicks
it, they instantly get a reply with a message you choose — ephemeral (only the
clicker sees it) or public — plus a **detailed latency report** as subtext:

```
Pong! 🏓
⏱ click → server 142 ms · dispatcher hop 0.4 ms · handler 23 µs
```

- **click → server** — the interaction `id` is a snowflake embedding the
  click's millisecond timestamp; compared against this host's (NTP-synced)
  clock it gives the true Discord → server delivery time.
- **dispatcher hop** — the [interactions dispatcher](../dispatcher) stamps its
  receive time in `x-dweeb-dispatcher-received` when forwarding, exposing the
  internal hop (omitted when the service is called directly).
- **handler** — time spent inside the request handler itself.

It's also the **minimal plugin template**: where [Modal Form](../modal-form)
shows the *stateful* pattern (SQLite instance store, capability ids), Ping Pong
is fully **stateless** — the whole config travels inside the `custom_id`
Discord hands back on every click:

```
pingpong:1:<e|p>:<percent-encoded reply text>
└prefix──┘ │  │   └ what to say (whole id ≤ 100 chars, Discord's limit)
         ver  └ e = ephemeral, p = public
```

No database, no volume, nothing to look up. The config UI live-counts the
encoded budget so the id can never exceed Discord's cap; the service falls
back to a default "Pong! 🏓" if it ever sees a malformed id.

```
DWEEB  ──reads──▶  GET /registry.json
DWEEB  ──embeds─▶  GET /config.html  ──save──▶  custom_id (no server call!)
Discord ─clicks─▶  POST /interactions  ──▶  reply decoded from the custom_id
```

In production, interactions arrive through the
[interactions dispatcher](../dispatcher), which routes on the `pingpong:`
prefix; the raw body and signature headers are forwarded untouched, so this
service verifies Discord's Ed25519 signature itself, exactly as if it were
called directly.

## Run locally

```bash
cd plugins/ping-pong
cp .env.example .env          # set DISCORD_PUBLIC_KEY (your app's public key)
cargo run                      # listens on http://localhost:8091
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. |
| GET | `/registry.json` | DWEEB plugin registry (one plugin). CORS-open. |
| GET | `/config.html` | The config iframe DWEEB embeds. |
| POST | `/interactions` | Discord interactions (signature-verified). |

## Files

| File | Role |
|---|---|
| [`src/main.rs`](src/main.rs) | Everything: env, router, signature verify, custom_id decode. |
| [`static/config.html`](static/config.html) | The config iframe (reply text + visibility). |
