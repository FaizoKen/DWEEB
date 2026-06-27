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

## Limitations (v1)

- **Last-write-wins.** Concurrent edits to the same field resolve to whoever
  typed last — it's not a CRDT. Fine for a small group co-writing one message.
- **No uploaded files.** Use image/media URLs (the same constraint as scheduled
  posts — uploaded blobs only live in one browser).
- **Manage Webhooks required** to publish (the post goes through a webhook).
- **Rooms are ephemeral.** The shared draft lives only while someone is
  connected; nothing is persisted server-side.
