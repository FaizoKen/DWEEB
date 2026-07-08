# DWEEB proxy

A small Rust service that lets the DWEEB builder fetch a server's **roles,
channels, and custom emojis** from Discord — gated behind a Discord login so it
is safe to run **publicly**.

## Why this exists

The builder posts messages straight to a webhook from the browser. But a webhook
token **cannot read** a server's roles/channels/emojis, and the Discord REST
endpoints that can:

1. require a **bot token** (which must never ship to the browser), and
2. don't send **CORS** headers (so a browser `fetch` to them is blocked).

This proxy holds the bot token server-side, adds CORS, caches results, and — so
it can be exposed to the public internet — only returns a server's data to a
**signed-in Discord user who actually belongs to that server**. No 24/7 hosted
bot is involved; these are stateless REST reads. The bot just has to be a
**member** of a server for that server to be readable.

## How access works

```
Browser ──/auth/login──▶ Discord consent ──/auth/callback──▶ proxy sets
   encrypted session cookie (HttpOnly), then every /api/guilds/:id read:
     1. decodes a valid session            (else 401 → sign in)
     2. confirms the user is in that guild  (else 403)         ← prevents
     3. reads the guild with the BOT token     (cached)           enumeration
```

A user can only ever read servers **they manage** (owner or *Manage Server*; see
`REQUIRE_MANAGE_GUILD`). They cannot enumerate other servers the bot happens to
be in.

## Endpoints

| Method | Path                          | Auth | Returns                                  |
| ------ | ----------------------------- | ---- | ---------------------------------------- |
| GET    | `/health`                     | —    | `{ "status": "ok" }`                     |
| GET    | `/auth/login`                 | —    | 302 → Discord consent (sets state cookie)|
| GET    | `/auth/callback`              | —    | exchanges code; sets session **or** (webhook flow) → frontend with the new webhook |
| GET    | `/auth/webhook`               | —    | 302 → Discord's `webhook.incoming` channel picker (sets state cookie); optional `?guild_id=` pre-selects the server |
| POST   | `/auth/logout`                | —    | clears the session                       |
| GET    | `/auth/me`                    | ✓    | `{ id, name, avatar_url }`               |
| GET    | `/api/guilds`                 | ✓    | `{ guilds: [{ id, name, icon, bot_present }] }` |
| GET    | `/api/guilds/:id/roles`       | ✓    | `[{ id, name, color, position, … }]`     |
| GET    | `/api/guilds/:id/channels`    | ✓    | `[{ id, name, type, position, … }]`      |
| GET    | `/api/guilds/:id/emojis`      | ✓    | `[{ id, name, animated, available }]`    |
| GET    | `/api/guilds/:id/bootstrap`   | ✓    | `{ roles, channels, emojis }` (one call) |
| GET/POST | `/api/guilds/:id/permanent` | ✓    | permanent-component slots (relayed to the dispatcher) |
| DELETE | `/api/guilds/:id/permanent/:message_id` | ✓ | free a permanent slot |
| GET/POST | `/api/guilds/:id/custom-apps` | ✓  | the guild's registered custom bots (relayed to the dispatcher); register takes `{ application_id, public_key, client_secret? }` (the display name is fetched from Discord) |
| DELETE | `/api/guilds/:id/custom-apps/:application_id` | ✓ | unregister a custom bot |
| POST   | `/api/guilds/:id/custom-apps/:application_id/webhook` | ✓ | `{ url }` — one-click `webhook.incoming` under that bot, using its stored secret |
| POST   | `/api/shortlink`              | —    | `201 { id, expires_at }` — stores a share token for 7 days |
| GET    | `/api/shortlink/:id`          | —    | `{ token }`, or 404 once expired/unknown |
| POST   | `/api/telemetry/crash`        | —    | `204` — records a content-free frontend crash report to the log (target `web_crash`) |
| POST   | `/api/schedules`              | opt. | `201 { id, manage_token, next_run_at }` — schedule a post (manage token returned once) |
| GET    | `/api/schedules`              | ✓    | the signed-in user's schedules (cross-device) |
| GET    | `/api/guilds/:id/schedules`   | ✓    | every schedule for a server (Manage Webhooks gated) |
| GET    | `/api/schedules/:id`          | 🎟/✓ | one schedule (masked + decrypted payload) |
| PATCH  | `/api/schedules/:id`          | 🎟/✓ | edit / reschedule / pause / resume |
| DELETE | `/api/schedules/:id`          | 🎟/✓ | cancel (hard-delete) |
| POST   | `/internal/permanent/reenable` | 🔑  | `{ guild_id, channel_id, message_id }` → `202` — dispatcher-only; revives a never-expired message's TTL-disabled components via the webhook token |

`✓` = requires the session cookie **and** membership of `:id`.
`🎟` = a per-schedule **manage token** (`X-Manage-Token` header), OR the signed-in account that created it. `opt.` = an optional session stamps the owner for cross-device listing.
`🔑` = service-to-service; no user session, gated by the shared `DISPATCHER_API_TOKEN` (`Authorization: Bearer …`). Called by the interactions dispatcher when its "Never expire" button grants a slot; the proxy finds the DWEEB webhook that posted the message and clears the `disabled` flags an expired click stamped on — no bot token, the webhook token does the edit.

### Short links

The builder's default share link keeps the whole message in the URL hash, so it
never reaches a server. The opt-in **short link** is the exception: the browser
POSTs the compressed share token here, it's stored in a small SQLite file
(`SHORTLINK_DB_PATH`, on the `proxy_data` volume under Docker) under a random
base62 id, and the builder shares `https://<frontend>/s/<id>`. Opening that URL
resolves the token back via `GET /api/shortlink/:id`.

Links **auto-expire after `SHORTLINK_TTL_DAYS` (default 7)**: reads filter on
the expiry timestamp (an expired link 404s immediately) and an hourly sweep
deletes expired rows. Creation is anonymous by design — sharing must not
require a login — so it's guarded by the per-IP rate limiter, a strict
share-token shape + size check (this can't be used as a general blob store),
and a total-row cap (`SHORTLINK_MAX_ENTRIES`). Set `SHORTLINK_TTL_DAYS=0` to
disable the feature (the endpoints answer 501).

### Scheduled posts

The opt-in **schedule** lets the builder post a message later — once, or on a
recurring wall-clock cadence (daily / weekly / monthly at a fixed local time in a
chosen IANA timezone). A scheduler can't live in the browser (it's closed when
the post must fire), so the proxy holds the destination **webhook URL and the
message payload** in its own SQLite file (`SCHEDULE_DB_PATH`, on the `proxy_data`
volume — a schedule must survive a redeploy). Both are **sealed at rest**
(AES-256-GCM under `SESSION_SECRET`, the same `seal.rs` used for custom-bot
secrets), so a leak of this file alone yields neither a usable webhook nor the
message. Completed/failed rows are swept after `SCHEDULE_RETENTION_DAYS`.

A background **worker** (`schedule_worker.rs`) drains due rows on a timer
(`SCHEDULER_TICK_SECS`), modelled on the self-role temporary-role reaper: a
bounded batch per tick, an atomic `active → sending` claim under a lease so a
crashed worker's rows are reclaimed (delivery is **at-least-once**), and a
transient-vs-permanent failure split — 429/5xx/network back off and retry; a 4xx
(deleted webhook, invalid body) stops the series with the reason recorded.
Recurring rules are computed with `chrono-tz` (DST-correct), and the *next* run
is always taken strictly after **now**, so a long outage yields one catch-up
post, not a burst.

**Creating a schedule requires a Discord login** — the row is owned by the
account (manageable across devices and counted against the per-server quota under
a real identity). Each row still gets an unguessable **manage token** (only its
SHA-256 is stored; the browser keeps it in `localStorage`) for token-based
management, and caches its destination `guild_id`, so a **server manager**
(Manage Webhooks in that guild — same gate as the webhook picker) can list and
manage *every* schedule for their server via `GET /api/guilds/:id/schedules`. Any
of the three — manage token, owning account, or guild manager — authorizes a
read/edit/cancel.

The headline limit is a **per-server quota** (`SCHEDULE_MAX_PER_GUILD`, default
5): a server can hold that many active schedules at once. Further bounded by the
per-IP rate limiter, a per-webhook cap (`SCHEDULE_MAX_PER_WEBHOOK`), a total-row
cap (`SCHEDULE_MAX_ENTRIES`), a horizon (`SCHEDULE_MAX_HORIZON_DAYS`), and a
payload size limit. Set `SCHEDULES_ENABLED=false` to disable the feature (the
endpoints answer 501 and the worker never starts).

### Message library (per server)

The **library** (`library.rs`) is the server-side twin of the builder's
browser-local posted/saved stores: one shared, labelled shelf of messages per
Discord server, readable and writable by anyone holding **Manage Webhooks**
there — from the web app (cookie session) *and* the embedded Activity (bearer),
via `GET/POST /api/guilds/:id/library` + `PATCH/DELETE …/library/:entry`.

Rows carry a `label`: **`posted`** (a live Discord message, upserted by its
message id so re-posting refreshes one entry instead of duplicating — and it
keeps the sealed webhook execute URL, so a later load can update the message in
place) or **`draft`** (pure content, saved deliberately). Posted entries are
recorded automatically: the web Send panel mirrors each successful send, the
Activity's server-side publish/edit handlers record their posts, and the
schedule worker records each fired schedule (reusing the row's already-sealed
payload/webhook). Scheduled and never-expire status are *derived* client-side
from their own APIs — never duplicated here.

Payloads and webhook URLs are **sealed at rest** like a schedule's
(AES-256-GCM under `SESSION_SECRET`), in their own SQLite file
(`LIBRARY_DB_PATH`, on the `proxy_data` volume). The per-server cap is the plan
gate (`PLAN_*_LIBRARY`: Free 10 / Plus 100 / Pro unlimited; standalone
deployments use `LIBRARY_MAX_PER_GUILD`). A downgraded server keeps every
stored entry readable and deletable, but while it holds **more** entries than
its cap the shelf is *content-frozen*: creates, posted-row refreshes, and
`PATCH`es carrying a new payload all answer 409 (rename/relabel stay allowed).
Without the freeze, surplus rows from a paid month would work as rotating
storage — keep 500 entries on Free and rewrite their content forever.
Auto-records at/over quota are silently skipped (a send must never look failed
because the shelf is full).
`LIBRARY_MAX_ENTRIES` bounds total disk use; `LIBRARY_ENABLED=false` turns the
feature off (the endpoints answer 501 and both frontends fall back to
browser-local storage).

### Creating a webhook (`webhook.incoming`)

`/auth/webhook` starts Discord's **`webhook.incoming`** OAuth flow: Discord shows
its own channel picker, the *user* authorizes a webhook for a channel they
manage, and the callback exchanges the code and redirects back to the builder
with the new webhook's URL in the fragment (`#dweeb_webhook=…`). **The bot needs
no permissions and need not even be in the server** — webhook creation never
touches the bot token. It reuses the same `/auth/callback` redirect URI and state
cookie as login (distinguished by a state prefix), so no extra redirect URI is
registered. The webhook URL is the user's own credential and lives only in their
browser; the proxy never stores it.

Passing `?guild_id=` (the builder forwards the connected server's id) pre-selects
that server in Discord's picker. It's only a default — the user can still pick
another server and must hold **Manage Server** there; a non-snowflake or
unusable id is dropped and Discord shows the full picker.

### Custom bots (bring your own app)

A server can register its **own Discord application** from the dashboard
(account menu → *Custom bot*) so the interactions dispatcher serves *its*
interactions too — plugin components then work on messages sent under their
bot, with its name and avatar. Each server gets one registration by default
(`CUSTOM_APPS_PER_GUILD`; per-server plan extensions can come later — the API
already reports the cap). The proxy only adds the authorization (login +
Manage Server) and relays to the dispatcher's token-gated `/custom-apps`
registry; see `plugins/dispatcher/README.md` for the verification model.

Registration also collects the app's **client secret**, which is what makes
posting as their bot one click later: the secret is **sealed here
(AES-256-GCM under a key derived from `SESSION_SECRET`)** before it's handed
to the dispatcher's registry, so the registry only ever stores opaque
ciphertext and it is never returned to any browser. The Send dialog's
webhook section then offers *Create a webhook from \<their bot\>*: the proxy
fetches the ciphertext back, opens it, runs the same `webhook.incoming` flow
under their app (the secret rides to the callback in an encrypted, HttpOnly,
10-minute cookie), and the callback exchanges the code with their
credentials before handing the webhook back through the usual fragment. The
user must add this proxy's `/auth/callback` URL to their app's OAuth2
redirects — the dashboard shows the exact URL to copy. Rotating
`SESSION_SECRET` makes stored secrets unopenable; the flow then asks for the
app to be re-registered.

## Hardening (built in)

- **Login + membership authorization** on every read (above).
- **Per-IP rate limiting** (token bucket) on `/api` + `/auth`
  (`RATE_LIMIT_PER_MIN` / `RATE_LIMIT_BURST`). The real client IP is read from
  `CF-Connecting-IP` / `X-Forwarded-For` / `X-Real-IP` — whatever proxy sits in
  front must strip the ones it doesn't set itself (the bundled `Caddyfile`
  does).
- **Global concurrency cap** on calls made under the shared bot token
  (`DISCORD_MAX_CONCURRENCY`) so a spike can't blow Discord's global rate budget.
- **Short-TTL caching** of guild data and per-user guild lists (`CACHE_TTL_SECS`).
- **Encrypted, HttpOnly session cookies** (the user's access token never reaches
  page JS); CORS restricted to the builder's exact origin(s) with credentials.

## One-time Discord setup

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** → **Reset Token** → copy into `DISCORD_BOT_TOKEN`.
3. **OAuth2** → copy **Client ID** → `DISCORD_CLIENT_ID`, **Client Secret** →
   `DISCORD_CLIENT_SECRET`.
4. **OAuth2 → Redirects** → add your callback URL and set it as
   `OAUTH_REDIRECT_URL` (e.g. `http://localhost:8080/auth/callback` for dev,
   `https://api.dweeb.example.com/auth/callback` for prod). They must match
   exactly.
5. Generate a session secret: `openssl rand -hex 48` → `SESSION_SECRET`.

Reading roles/channels/emojis needs **no privileged intents**. Listing *members*
would — that's intentionally never exposed.

## Run locally

```bash
cp .env.example .env          # fill in the values from the setup above
cargo run                     # listens on 0.0.0.0:8080
# then open the builder (VITE_PROXY_BASE_URL=http://localhost:8080) and sign in
```

For local dev set `COOKIE_SECURE=false` (plain HTTP) and
`ALLOWED_ORIGINS=http://localhost:5173`.

## Deploy (Docker, direct TLS via Caddy)

```bash
cp .env.example .env          # production values; COOKIE_SECURE=true
docker compose pull           # or: docker compose up -d --build
docker compose up -d
```

The compose file runs Caddy in front of the proxy. Point the domain's DNS A
record **straight at the host** (Cloudflare proxy OFF / "DNS only") and set
`DOMAIN` + `ACME_EMAIL` in `.env` — Caddy obtains and renews the Let's Encrypt
certificate itself and serves HTTP/1.1, HTTP/2 and HTTP/3 (QUIC). Open
**80/tcp, 443/tcp and 443/udp** in any firewall. The proxy container publishes
no host port; only Caddy is reachable, and it strips `CF-Connecting-IP` /
`X-Real-IP` so per-IP rate limiting can't be spoofed (see `Caddyfile`).

For lowest latency on the host, enable BBR and give QUIC larger UDP buffers:

```bash
cat >/etc/sysctl.d/99-dweeb-net.conf <<'EOF'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.core.rmem_max=7500000
net.core.wmem_max=7500000
EOF
sysctl --system
```

**Cookie tip:** host the proxy on a subdomain of the builder's site (e.g.
`api.dweeb.example.com` next to `dweeb.example.com`) and keep
`COOKIE_SAMESITE=lax` — the session then flows same-site. Only use
`COOKIE_SAMESITE=none` if the two are on genuinely different sites.

## Scaling horizontally

A single instance handles a lot (it's a cached Rust proxy), so start there.
When you need multiple replicas behind a load balancer, set `REDIS_URL` and they
share one cache and one rate-limit counter set:

```bash
# in .env
REDIS_URL=redis://redis:6379
# bring up the proxy + a shared Redis
docker compose --profile redis up -d --build
```

Sessions are already stateless (encrypted cookie), so nothing else needs a
shared store. With Redis configured:

- **Cache** — guild data + per-user guild lists live in Redis (`dweeb:cache:*`),
  so every replica sees the same entries and Discord is hit once per TTL fleet-
  wide, not once per replica.
- **Rate limiting** — a shared per-IP fixed-window counter (`dweeb:rl:*`), so the
  limit is enforced across all replicas rather than per-process.

Both fail **open**: if Redis is briefly unreachable, reads degrade to a cache
miss and the limiter allows the request, so a Redis blip never takes the proxy
down. The connection is verified at boot, so a *misconfigured* `REDIS_URL` fails
fast instead.

## Configuration

All via env vars — see [`.env.example`](.env.example) for the annotated list.
