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
| GET    | `/auth/callback`              | —    | exchanges code, sets session, → frontend |
| POST   | `/auth/logout`                | —    | clears the session                       |
| GET    | `/auth/me`                    | ✓    | `{ id, name, avatar_url }`               |
| GET    | `/api/guilds`                 | ✓    | `{ guilds: [{ id, name, icon, bot_present }] }` |
| GET    | `/api/guilds/:id/roles`       | ✓    | `[{ id, name, color, position, … }]`     |
| GET    | `/api/guilds/:id/channels`    | ✓    | `[{ id, name, type, position, … }]`      |
| GET    | `/api/guilds/:id/emojis`      | ✓    | `[{ id, name, animated, available }]`    |
| GET    | `/api/guilds/:id/bootstrap`   | ✓    | `{ roles, channels, emojis }` (one call) |

`✓` = requires the session cookie **and** membership of `:id`.

## Hardening (built in)

- **Login + membership authorization** on every read (above).
- **Per-IP rate limiting** (token bucket) on `/api` + `/auth`
  (`RATE_LIMIT_PER_MIN` / `RATE_LIMIT_BURST`). Behind Cloudflare/Tunnel the real
  client IP is read from `CF-Connecting-IP` / `X-Forwarded-For`.
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

## Deploy (Docker behind Cloudflare Tunnel)

```bash
cp .env.example .env          # production values; COOKIE_SECURE=true
docker compose up -d --build
```

The compose file publishes the proxy on the loopback address `127.0.0.1:8080`
only — not reachable from the public internet, only by the host (where your
cloudflared runs). Point your tunnel ingress at `http://localhost:8080`.

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
