# DWEEB as a Discord Activity

DWEEB also runs **inside Discord** as an [Activity](https://discord.com/developers/docs/activities/overview):
the same visual builder, launched from a server channel (scoped to it) or from a
DM (publishing to a server you manage), with **real-time co-editing** and
**one-click publishing** — no tab-switching, no re-auth, no "which server am I in
again".

This is the embedded counterpart to the web app. It reuses the editor, the
pixel-accurate preview, and the proxy; only three things differ, and all of them
live in `server/src/activity.rs` and `src/core/activity/`:

| Concern | Web app | Activity |
| --- | --- | --- |
| **Auth** | session cookie | `Authorization: Bearer <Discord token>` (the iframe gets no cookie) |
| **Publishing** | browser → webhook | proxy posts on the browser's behalf (a sandboxed iframe can't reach discord.com directly) |
| **Collaboration** | n/a | a WebSocket room per Activity instance (last-write-wins draft sync + presence) |

### Server launch vs. DM launch

An Activity can be launched **from a server channel** or **from a DM / group DM**.
The builder, preview, and collaboration are identical; only the publish
destination differs:

- **Server launch.** The launching guild + channel are the default destination
  (re-pointable to any channel in that server). The preview resolves the
  server's mentions and emoji immediately.
- **DM launch.** A DM has no guild, and DMs **can't host webhooks** — so there's
  nothing to post into the DM itself. Instead the bar shows a **server picker**:
  the user chooses one of the servers they manage (the DWEEB bot is present and
  they hold Manage Webhooks — the same gate the post enforces), then a channel
  in it. Picking a server also loads its data, so the preview resolves against
  the chosen destination. Publishing then goes through the exact same
  `POST /api/activity/post` path. The collaboration room still works (handy in a
  group DM) — it's keyed by Discord's unguessable, ephemeral instance id rather
  than a guild, since there's no membership to gate on.

## How it works

```
 Discord client
   └─ iframe: <app-id>.discordsays.com/.proxy/…  (serves the site; ?frame_id ⇒ Activity)
        │  Embedded App SDK: ready → authorize → authenticate
        │
        ├── POST /api/activity/token   code → access_token   (proxy holds the secret)
        ├── GET  /api/guilds/:id/bootstrap   roles/channels/emoji  (Bearer)
        ├── POST /api/activity/post    message → posted to the chosen channel via a DWEEB webhook (Bearer)
        ├── POST /api/activity/edit    message → PATCH a message already posted, via the same webhook (Bearer)
        ├── POST /api/activity/schedule message + fire time → stored sealed, posted later by the schedule worker (Bearer)
        ├── POST /api/activity/restore message id → the message DWEEB posted, read back via the same webhook (Bearer)
        ├── GET  /api/activity/identities    who this server can post as: DWEEB + its custom bots (Bearer)
        ├── POST /api/activity/connect-bot   authorize URL for the one-time custom-bot connect flow (Bearer)
        └── WS   /api/activity/room/:instance   draft + presence relay
```

Inside Discord every request must go through the client's proxy. The SDK's
`patchUrlMappings` rewrites the proxy's absolute URLs (HTTP **and** WebSocket) to
a same-origin `/.proxy/<prefix>/…` path, which Discord forwards to the real host.
So the existing `core/guild` client works unchanged — it just gains a bearer
header (`core/net/proxyFetch`) and a URL remap.

### After you post: update, view, invite

The bar's primary action is **Post** — a new message via a DWEEB-owned webhook.
Once you've posted to the chosen destination it flips to **Update**: the current
draft PATCHes the message you just posted (`POST /api/activity/edit`, through the
*same* webhook), with **New** alongside to post a separate copy and a **↗** to open
the posted message. The sandboxed iframe can't navigate to discord.com itself, so
the ↗ opens it through the SDK's `openExternalLink`. Re-point the channel and the
primary reverts to **Post** (a fresh post into the new destination).

### Schedule a post

A brand-new post's confirm dialog also chooses **when**: *Now* (the default) or
*Schedule* — a one-time post at a picked local date & time. The web app schedules
by handing over a webhook URL the browser holds; the Activity never sees webhook
credentials, so `POST /api/activity/schedule` resolves the destination webhook
server-side (the same reuse-or-mint DWEEB webhook a live post rides) and stores
the message through the same schedule store/worker as the web — sealed at rest,
fired with the browser closed, counted against the same per-server plan quota.
"Never expire" carries over too (the worker spends the slot when it fires).
Always the standard DWEEB identity, never a custom bot: a custom bot's single
Activity webhook roams between channels on demand, so by fire time it could sit
somewhere else. Listing/cancelling schedules stays on the web (gallery →
Scheduled); the success toast says so.

### Restore a posted message

The bar's **⟲ Restore** opens a one-field dialog: paste the message ID (or a
Discord message link) of something DWEEB posted in the target channel and it
loads straight into the shared editor, broadcast to everyone in the room. The web
app's Restore needs the webhook URL that authored the message — a secret only that
browser holds — but inside the Activity the proxy already knows the DWEEB-owned
webhook for the channel, so it resolves it itself (`POST /api/activity/restore`
finds the hook, then GETs the message through it). The user supplies only the id.

Discord only returns a message to the webhook that authored it, so a 404 means the
id isn't a message DWEEB posted in that channel (a user/bot/other-webhook message
never restores, even in the same channel). On success `lastPost` is set to the
restored message, so the bar immediately shows **Update** — editing PATCHes that
message in place, exactly as if you'd just posted it. Restore needs a destination
channel (the webhook lives there), so it's disabled until one is picked.

The presence bar's **"+"** pulls more people straight into the same collaboration
room instead of everyone launching separately, and it works wherever the Activity
runs. A **server** launch opens Discord's native invite dialog (`openInviteDialog`),
which drops an activity invite in the channel. That dialog is server-only — it
throws in a DM / group DM — so a **DM / group-DM** launch opens the share-link
modal (`shareLink`) instead: the user sends the Activity link to the group / a
friend or copies it, and opening it joins this same instance (same room). The
store's `invite()` picks the route off `context.guildId`; the button is no longer
hidden in DMs.

The Activity also sets a best-effort **rich presence** ("Building a message") via
`setActivity`. That command needs the `rpc.activities.write` scope, which the
handshake deliberately does **not** request (a new scope risks breaking the
`prompt:"none"` authorize), so it silently no-ops unless the scope is granted.

### Post as the server's own bot (custom bots)

A server can post and update from the Activity under one of its **custom bots**:
the pre-post confirm's **Post as** row shows `DWEEB`, each registered bot, and a
trailing **+**. The + opens the full web app directly on that destination guild's
Custom bot configuration (`?custom-bot=<guildId>`, signing in first if needed),
because app credentials should never be entered inside the Activity iframe. When
the user returns, the open dialog refreshes its identities so a newly registered
bot appears without being reopened. Posts under a custom bot carry that bot's
identity, with components routed to its app (which the dispatcher serves, so
DWEEB plugins keep working on it).

The mechanism is a per-bot **Activity webhook**. Discord only reveals a webhook's
execute token to the app that owns it, so DWEEB's bot can never recover a
custom-bot webhook the way it does its own — on the web that token lives in the
creating browser's history, which a sandboxed iframe doesn't have. Instead:

- **Connect once** — tapping *Connect \<bot\>* in the Post as row asks the proxy
  for an authorize URL (`POST /api/activity/connect-bot`, carrying the Activity
  `instance_id`) and opens it in the user's external browser via
  `openExternalLink`. That browser carries none of our cookies, so the flow's
  context (custom app credentials, destination guild, 10-minute expiry, and that
  instance id) travels **sealed inside the OAuth `state` itself** (AES-GCM under
  the proxy key, its own AAD domain). Discord shows its `webhook.incoming`
  consent under the *custom* app; the callback opens the state, refuses a webhook
  created outside the pinned guild (best-effort deleting the stray), seals the
  webhook token, and stores it on the app's row in the dispatcher registry —
  right next to the sealed client secret.
- **The Activity finds out instantly** — the callback then pushes a
  `{ type: "bot_connected", application_id }` frame straight into that instance's
  live collaboration room (`ActivityRooms::notify`). WebSocket messages are
  delivered even to a backgrounded iframe, so the dialog selects the bot the
  moment OAuth completes — no polling, and no dependence on a focus/visibility
  event the sandboxed iframe often never sees when you switch back from a
  separate browser window (the friction that used to force a close-and-reopen of
  the dialog). A focus/visibility re-fetch remains only as a fallback for a push
  missed during a socket reconnect; reopening the dialog also re-reads fresh.
  Because the Activity has already updated itself, the browser tab is pure
  confirmation: its success page best-effort auto-closes (`window.close()`, a
  nicety since it usually isn't a script-opened window) and just says "you can
  close this tab" — nothing to return to. Only the OAuth *authorize* step still
  needs the external browser, and can't be avoided: the sandboxed iframe can't
  run an OAuth flow, and it must authorize the *custom* app (not DWEEB), which
  the Embedded SDK's `authorize` can't do.
- **Post anywhere** — one webhook serves the whole server. Before each use the
  proxy reads the webhook's live channel (`GET /webhooks/{id}/{token}`) and, when
  the destination differs, **moves it there** with the bot's Manage Webhooks
  (an incoming webhook is re-pointable at any channel in its guild), then
  executes with the webhook's own token. Updates and Restore bring the webhook
  back to the message's channel the same way first, since Discord resolves
  webhook-message reads/edits within the webhook's current channel.
- **Identity sticks to the message** — `lastPost` carries `application_id`, so
  Update always rides the identity that authored the message, regardless of the
  current Post as selection (which only applies to a new post / new copy).

Failure modes stay actionable: a webhook deleted in Discord (or sealed under a
rotated `SESSION_SECRET`) is dropped from the registry and the post errors with
"reconnect it from the post dialog"; a bot registered without a client secret
shows a disabled pill pointing at re-registering on the web; a plan-suspended
bot is excluded from the list and refused server-side. The web app's own
custom-bot webhooks are untouched — the Activity never captures or moves them
(a scheduled post may pin one to a channel), only its own dedicated webhook.

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
webhook feature. The bar's channel picker defaults to the launching channel but
can re-point a post at any webhook-hostable channel in the same server (the
proxy validates the channel belongs to the guild before posting).

### 2. Developer Portal → your DWEEB application

1. **Activities → Settings → Enable Activities.** Set Supported Platforms to at
   least **Web** (covers desktop + browser). There's no separate "entry point"
   field — the Root Mapping below is the entry point.

   To offer **Launch in DM** (the second button on the launch card), the app must
   be launchable in a private channel. Enable **Installation → Installation
   Contexts → User Install** (in addition to Guild Install) so DWEEB can be used
   in DMs and group DMs; the OAuth2 scopes below already cover the handshake. The
   app handles a guild-less launch gracefully (see *Server launch vs. DM launch*
   above) — without User Install, only the in-server **Launch** button shows.

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
   `src/core/activity/runtime.ts`. The target is the host of
   `VITE_PROXY_BASE_URL`. These two mappings are all you need — the preview's
   **images** render without any extra mappings: external/user-pasted media is
   fetched on the browser's behalf by the proxy (`GET /api/activity/image`,
   reached over the same `/proxy` mapping), since the iframe's CSP blocks loading
   arbitrary hosts as `<img>`/`<video>` directly. Discord's own CDN media
   (`cdn.discordapp.com` / `media.discordapp.net`, e.g. custom emoji) is already
   CSP-allowed and loads natively.

   **Plugin config UIs** work the same way, also without an extra mapping. A
   plugin's configuration iframe normally loads straight from its own
   `*.dweeb.faizo.net` host, but that cross-origin frame is CSP-blocked inside the
   Activity (it renders blank). So in a real Activity the editor points the frame
   at the proxy's `GET /api/activity/plugin?url=…` loader (over the same `/proxy`
   mapping): the proxy fetches the page and injects a tiny shim that re-routes the
   plugin's own `/api/*` calls through `/api/activity/plugin-fetch`. The frame is
   then same-origin, so it's sandboxed to an **opaque** origin (no `allow-same-origin`)
   to keep the untrusted plugin out of the host — its `postMessage`s arrive as
   origin `"null"` and the `event.source` check is the gate. Both endpoints are
   allow-listed by `ACTIVITY_PLUGIN_HOSTS` (default `dweeb.faizo.net`) so they
   can't be abused as an open proxy. See `server/src/activity.rs`.

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

`vite.config.ts` auto-detects `certs/localhost*.pem` in the explicit Activity
mode. Ordinary `bun run dev` stays on HTTP even when those files exist, so it
can safely call the local HTTP proxy. The `certs/` folder is gitignored. Then:

```bash
bun run dev:activity              # https://localhost:5173
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
a gitignored **`.env.activity.local`**:

```bash
# .env.activity.local — local Activity dev against the deployed app + proxy
# Activity mode: local UI against the deployed app and proxy.
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
