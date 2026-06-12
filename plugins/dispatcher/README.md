# Interactions dispatcher

Not a plugin — the **front door for all of them**. A Discord application has
exactly **one** Interactions Endpoint URL, but every DWEEB plugin that puts
interactive components on a message receives its clicks through that URL. This
service is that endpoint: it verifies the signature, answers PINGs, and routes
everything else to the right plugin by `custom_id` prefix — the same
`customIdPrefix` every plugin manifest already declares.

```
Discord ──POST /──▶ dispatcher ── verifies Ed25519, answers PING + /dashboard
                                    │
                       custom_id "modalform:…" ──▶ http://modal-form:8090/interactions
                       custom_id "pingpong:…"  ──▶ http://ping-pong:8090/interactions
                       no match                ──▶ disables the component ("not wired")
```

Application commands are answered inline too (`src/commands.rs`) — they
route by name, not `custom_id`, so the prefix routing never sees them, and
every one is a pure function of the interaction payload Discord already
sent: no Discord API call, no plugin, no forward hop.

| Command | Where | Reply (always ephemeral) |
|---|---|---|
| `/dashboard` | slash | Link to `DASHBOARD_URL`. |
| **Edit in DWEEB** | message menu | Share link opening the editor pre-loaded with the message. The resolved payload from the interaction is re-encoded into the same `#s=<version>.<lz-string>` token `encodeShare` emits (`src/core/serialization`), so the deployed frontend needs no changes — and the message rides the URL fragment, which never reaches a server. Legacy messages are converted to Components V2 so *any* message opens editable: `content` becomes a leading Text Display, rich embeds become Containers (color → accent, title/description/fields → text, thumbnail → section accessory, image → gallery; lossy, and noted in the reply), and image/video attachments become a Media Gallery. Auto-generated link previews are skipped — they regenerate from the text. |
| **Export JSON** | message menu | The postable wire JSON in a code block; falls back to an editor link when it outgrows the 2000/4000-char reply budget. |
| **Message Info** | message menu | Everything the interaction payload says about the message: author (user / bot / webhook), sent + edited timestamps, channel and message ids, payload shape (content size, component / embed / attachment counts), flags (V2, silent, pinned), and its component-expiry status — expires when, already expired, or permanent including *who* granted the slot and when. **Manage Server** holders also get the permanent-slot toggle as a button on the reply (custom_id `dweeb:perm:…`, answered inline here too; the permission is re-checked on click). A successful toggle updates the info reply in place — expiry line, slot count, and button — rather than posting a separate confirmation. The pre-rename name **Make Permanent** is still answered as an alias. |
| **Use as Webhook Identity** | user menu | Editor link with the webhook username/avatar prefilled from the member (nickname + guild avatar first). |

Register the set once (global commands take up to an hour to propagate):

```powershell
$env:DISCORD_BOT_TOKEN = "your-bot-token"
node scripts/register-commands.mjs <applicationId>
```

The raw body and signature headers are forwarded untouched, so each plugin
re-verifies the exact bytes Discord signed — adding the dispatcher requires
**zero changes** to a plugin.

## Adding a plugin route

One entry in the `ROUTES` env var (see `server/compose.yml`):

```json
{ "modalform:": "http://modal-form:8090", "pingpong:": "http://ping-pong:8090" }
```

Longest prefix wins. Nothing else here changes; the public endpoint URL
(`https://interactions.dweeb.faizo.net`) is stable forever. One prefix is
reserved: `dweeb:` belongs to the dispatcher's own components (the Message
Info toggle button), answered inline ahead of the routing — no plugin
manifest may claim it.

Removing a plugin needs no cleanup either: a click on a component whose
prefix matches no route is answered with an `UPDATE_MESSAGE` that disables
it (the same mechanism the TTL below uses), so messages left behind by an
uninstalled plugin stop generating traffic after their first click.

## Env

| Var | Meaning |
|---|---|
| `DISCORD_PUBLIC_KEY` | App public key (64 hex chars), verifies signatures. Required. |
| `ROUTES` | JSON map of `custom_id` prefix → upstream base URL. Required. |
| `COMPONENT_TTL_DAYS` | Days a component stays clickable after its message was sent. Default `7`; `0` = never expires. |
| `PERMANENT_SLOTS_PER_GUILD` | TTL-exempt messages each guild may hold. Default `2`; `0` stops new grants (existing ones stay honored). |
| `CUSTOM_APPS_PER_GUILD` | Custom Discord apps each guild may register. Default `1`; `0` stops new registrations (existing ones keep working). |
| `DISPATCHER_FORWARD_SECRET` | Shared secret with every plugin, vouching for the forwarded verifying-key header. Unset = custom-app clicks fail the plugins' own verification. |
| `INTERNAL_API_TOKEN` | Bearer token gating the `/permanent` + `/custom-apps` management APIs the proxy calls. Unset = those APIs are disabled. |
| `DATABASE_PATH` | SQLite file for the permanent slots + custom-app registry. Default `./dispatcher.db` (`/data/dispatcher.db` in the image). |
| `DASHBOARD_URL` | URL `/dashboard` replies with. Default `https://dweeb.faizo.net`. |
| `PORT` | Bind port, default `8095`. |

## Component TTL

Components expire by default: a click on a message older than
`COMPONENT_TTL_DAYS` (the message id snowflake carries its send time, so no
per-instance registry is needed) is answered here with an `UPDATE_MESSAGE`
that **disables the clicked component**, and is never forwarded to a plugin.
Discord sends no interactions for a disabled component, so that first expired
click is the last traffic the component ever generates — old messages can't
accumulate into unbounded long-tail load.

Modal submits are exempt: opening the modal already passed this gate, so a
form a user is mid-way through filling in still lands.

## Permanent slots

Some messages are *meant* to live forever — a role menu pinned in #welcome.
Each guild gets `PERMANENT_SLOTS_PER_GUILD` exemptions, managed two ways:
from the **dashboard** (the pre-send confirmation offers *Make permanent* on
messages with plugin components, and the account menu's *Managed messages*
dialog lists the occupying messages so slots can be freed), or by a **Manage
Server** holder right-clicking the message in Discord → Apps → **Message
Info** and clicking the toggle button on the reply — the same button on an
already-permanent message releases its slot. That path is served inline here
(the interaction carries the guild, channel + message ids, and the invoker's
computed permissions — all the `/permanent` API needs) against the same
SQLite store.

The authorization chain: browser → **proxy** (Discord login; the user must
manage the guild) → **this service's `/permanent` API** (bearer
`INTERNAL_API_TOKEN`), which owns the slots in one SQLite file
(`DATABASE_PATH`; mount `/data` so they survive restarts). The TTL gate above
consults the same store, and only for already-expired clicks — fresh traffic
never touches the database.

```
GET    /permanent/:guild_id              → { cap, used, ttl_days, items }
POST   /permanent/:guild_id              { message_id, channel_id, added_by }
                                          → 200 state | 409 slots_full + state
DELETE /permanent/:guild_id/:message_id  → 200 state | 404 not_permanent
```

Caddy refuses `/permanent*` on the public hostname; the API is reachable only
over the compose network, and the token is required even there.

## Custom apps (bring your own bot)

A guild may register its **own Discord application** so this dispatcher
serves *its* interactions too — messages sent under their app (via an
app-owned webhook) then carry working DWEEB plugin components, with the
bot's own name and avatar. Each guild gets `CUSTOM_APPS_PER_GUILD`
registrations (default 1; the responses carry `cap`, so per-guild plan caps
can replace the env later without an API change).

Verification order on `POST /`: the primary `DISCORD_PUBLIC_KEY` is tried
first (virtually all traffic, precomputed key, no allocation). Only when it
fails is the body parsed for its `application_id`, which selects the
registered app's key from an in-memory map — seeded from SQLite at boot and
kept in sync by the API below, so the hot path never touches the database.
No registered key verifying = 401, exactly what Discord's endpoint
validation expects. **Register the app first, then set its Interactions
Endpoint URL** — Discord PINGs the URL the moment it's saved.

Because plugins re-verify the raw bytes themselves, the dispatcher forwards
*which* key verified (`x-dweeb-public-key`), vouched for by the shared
`DISPATCHER_FORWARD_SECRET` (`x-dweeb-forward-auth`). A plugin ignores the
key header without a valid secret, so nothing reaching a plugin directly can
substitute a key; the signature check itself always happens in the plugin.

Registration proves portal access: the app's public key is only visible to
its owner/team in the Developer Portal. (A wrong key simply never verifies —
re-registering the same app from the same guild updates the key in place.)
An application id can only be registered by one guild at a time
(`409 app_taken`).

```
GET    /custom-apps/:guild_id                  → { cap, used, items }   (items carry has_secret)
POST   /custom-apps/:guild_id                  { application_id, public_key, name?,
                                                 client_secret_enc?, added_by }
                                                → 200 state | 409 quota_full | 409 app_taken
DELETE /custom-apps/:guild_id/:application_id  → 200 state | 404 not_registered
GET    /custom-apps/:guild_id/:application_id/secret → { client_secret_enc } | 404
```

`client_secret_enc` is the app's OAuth client secret **already sealed by the
proxy** (AES-GCM under the proxy's key) — opaque ciphertext here, so neither
this API nor a leak of the SQLite file yields a usable secret. The proxy
stores it at registration and fetches it back to run the one-click
"create a webhook from this bot" flow.

When a secret is provided, the proxy also installs the same application
commands on the custom app (a client-credentials grant with the
`applications.commands.update` scope — the secret alone suffices, no bot
token), so its bot carries the same right-click menus as the main app;
unregistering clears them again. Both are best-effort and off the request
path — a failure only means that bot lacks the menus, and re-registering
retries.

Same trust chain and edge rules as `/permanent`: proxy-only, bearer
`INTERNAL_API_TOKEN`, and Caddy refuses `/custom-apps*` publicly.

## Latency

The forward hop runs over the compose network with a warm connection pool —
sub-millisecond. Upstream calls time out at 2.5s so the dispatcher can still
answer Discord inside its 3s window (an ephemeral error instead of
"This interaction failed").
