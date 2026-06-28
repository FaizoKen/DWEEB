# DWEEB as a Discord Activity

DWEEB also runs **inside Discord** as an [Activity](https://discord.com/developers/docs/activities/overview):
the same visual builder, launched in a server, scoped to the current channel,
with **real-time co-editing** and **one-click publishing** — no tab-switching,
no re-auth, no "which server am I in again".

This is the embedded counterpart to the web app. It reuses the editor, the
pixel-accurate preview, and the proxy; only three things differ, and all of them
live in `server/src/activity.rs` and `src/core/activity/`:

| Concern | Web app | Activity |
| --- | --- | --- |
| **Auth** | session cookie | `Authorization: Bearer <Discord token>` (the iframe gets no cookie) |
| **Publishing** | browser → webhook | proxy posts on the browser's behalf (a sandboxed iframe can't reach discord.com directly) |
| **Collaboration** | n/a | a WebSocket room per Activity instance (last-write-wins draft sync + presence) |

## How it works

```
 Discord client
   └─ iframe: <app-id>.discordsays.com/.proxy/…  (serves the site; ?frame_id ⇒ Activity)
        │  Embedded App SDK: ready → authorize → authenticate
        │
        ├── POST /api/activity/token   code → access_token   (proxy holds the secret)
        ├── GET  /api/guilds/:id/bootstrap   roles/channels/emoji  (Bearer)
        ├── POST /api/activity/post    message → posted via a DWEEB webhook (Bearer)
        └── WS   /api/activity/room/:instance   draft + presence relay
```

Inside Discord every request must go through the client's proxy. The SDK's
`patchUrlMappings` rewrites the proxy's absolute URLs (HTTP **and** WebSocket) to
a same-origin `/.proxy/<prefix>/…` path, which Discord forwards to the real host.
So the existing `core/guild` client works unchanged — it just gains a bearer
header (`core/net/proxyFetch`) and a URL remap.

## One-time setup

You need: the DWEEB **proxy** running (it already holds the OAuth client +
secret and the bot token), and a few settings in the **Developer Portal**.

### 1. Proxy

Nothing new is required — Activities reuse `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, and the bot's **Manage Webhooks**
permission (the same one the web app's webhook picker uses). The only knob is:

```bash
ACTIVITIES_ENABLED=true   # default; set false to disable /api/activity/*
```

Publishing reuses (or mints) a DWEEB-owned webhook in the target channel, so the
posting user must hold **Manage Webhooks** there — exactly like every other
webhook feature.

### 2. Developer Portal → your DWEEB application

1. **Activities → Settings → Enable Activities.** Set Supported Platforms to at
   least **Web** (covers desktop + browser). There's no separate "entry point"
   field — the Root Mapping below is the entry point.

2. **Activities → URL Mappings.** Two mappings:

   | Prefix | Target | Purpose |
   | --- | --- | --- |
   | `/` (Root Mapping) | `dweeb.example.com` | serves the site + JS/CSS assets |
   | `/proxy` (Proxy Path) | `api.dweeb.example.com` | the DWEEB proxy (API + collaboration WS) |

   Discord loads the Root Mapping target's root — i.e. `dweeb.example.com/`,
   which is the normal site's `index.html`. That's intended: the app **detects
   the Activity launch** (Discord appends `?frame_id=…`) and boots the embedded
   surface instead of the web app, dynamically importing it so the SDK never
   loads on the public site. So no separate page or entry-point URL is needed.

   The `/proxy` prefix **must** match `PROXY_MAPPING_PREFIX` in
   `src/core/activity/sdk.ts`. The target is the host of `VITE_PROXY_BASE_URL`.

   > Optional polish: add mappings for `cdn.discordapp.com` /
   > `media.discordapp.net` if you want avatar/emoji **images** to render in the
   > preview. Mentions, names, and message text resolve from the bootstrap data
   > and work without them.

3. **OAuth2 → Scopes** used by the SDK handshake: `identify` (who's editing) and
   `guilds` (membership + permission gate). No redirect URI is needed for the
   embedded flow — the code comes over RPC, not a browser redirect.

### 3. Build & deploy

The Activity ships from the same build as the web app — there's nothing extra to
build or deploy:

```bash
bun run build   # the embedded surface + SDK are lazy chunks of the one entry
```

`src/main.tsx` boots `App` normally, or dynamically imports `ActivityApp` when
`frame_id` is present. The Embedded App SDK lands in its own `activity-sdk`
chunk, fetched only inside Discord, so the public site's first paint is
untouched.

## Trying it

Use Discord's **Activity test mode** (Developer Portal → your app → Activities →
"Launch in a channel"), or run `bun run dev` and point a local tunnel at the URL
mappings. Launch it from a server channel — DWEEB reads `guildId`/`channelId`
off the SDK, loads that server's data, and opens the shared room. Open it from a
second account in the same channel to see live co-editing.

### Local dev with the URL Override

For iterating on the **frontend** (the embedded surface, editor, preview) the
fastest loop is Discord's **URL Override**: in the activity launch dialog, tick
**Use Activity URL Override** and point it at your local dev server.

**HTTPS is required.** Discord's client embeds the Activity in an iframe whose
`frame-src` CSP only whitelists `https://localhost:*` — a plain
`http://localhost` override is blocked outright (the iframe renders "This content
is blocked"). A self-signed cert won't do either: its warning can't be
click-accepted inside an iframe. So serve the dev server over a **locally-trusted**
cert with [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install                                              # once: trust a local CA
mkdir -p certs && cd certs
mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1
```

`vite.config.ts` auto-detects `certs/localhost*.pem` and serves HTTPS when
present (absent the files it stays on HTTP, so the normal web-app dev loop and CI
are untouched). The `certs/` folder is gitignored. Then:

```bash
bun run dev                       # now https://localhost:5173
```

Set the override to `https://localhost:5173`. Launch from a server channel —
Discord appends `?frame_id=…`, so `main.tsx` boots `ActivityApp` and HMR reloads
as you edit.

#### The override can't do proxied backend calls — and how dev works anyway

The override **only** swaps the Root Mapping (where the HTML/JS/CSS loads), and
launches via the **developer shelf** carry a *faux* proxy ticket
(`discord_proxy_ticket=faux-proxy-ticket` in the iframe URL). Discord's edge does
**not** forward `/.proxy/…` requests for such launches, so every proxied backend
call — token exchange, guild bootstrap, publish, the collaboration WS — returns
**404**. The real SDK handshake therefore can't complete under the override.

To still iterate the **frontend** end-to-end, the app has a **dev-only bypass**
(`devOverrideSession()` in `core/activity/activityStore.ts`): when a *development*
build detects the faux ticket, it skips the proxy-bound handshake and seeds a stub
session from the launch query params (`guild_id`/`channel_id`/`instance_id`), so
the builder renders immediately. This never runs in a production build. Point the
dev build at the deployed app/proxy so the rest matches the launching app — create
a gitignored **`.env.local`**:

```bash
# .env.local — local Activity dev against the deployed (prod) app + proxy
VITE_DISCORD_CLIENT_ID=<prod app id, the one the override launches under>
VITE_PROXY_BASE_URL=https://api.dweeb.example.com
```

(The default `.env` points at a local proxy + the DWEEB DEV app, which is for the
local-proxy + tunnel setup below — not the override.)

What works under the override: the full editor, preview, and `ActivityBar`
chrome, with HMR. What doesn't: publish, live collaboration, and guild-resolved
mentions/emoji in the preview (all need the proxy). For those, use a **real**
launch — a deployed build, or the Developer Portal's "Launch in a channel" test
mode — not the override.

To iterate on the **backend** (`server/src/activity.rs`) locally, run the proxy,
expose it over a tunnel, and repoint the `/proxy` URL Mapping at the tunnel (this
dialog can't change that mapping).

## Limitations (v1)

- **Last-write-wins.** Concurrent edits to the same field resolve to whoever
  typed last — it's not a CRDT. Fine for a small group co-writing one message.
- **No uploaded files.** Use image/media URLs (the same constraint as scheduled
  posts — uploaded blobs only live in one browser).
- **Manage Webhooks required** to publish (the post goes through a webhook).
- **Rooms are ephemeral.** The shared draft lives only while someone is
  connected; nothing is persisted server-side.
