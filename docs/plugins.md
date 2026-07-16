# DWEEB plugins

A **plugin** gives an interactive component (a button with a `custom_id`, or a
select menu) its behavior. Plugins are independent **microservices**: DWEEB
never runs your code. It reads your manifest from a registry, embeds your
configuration UI in a sandboxed iframe, and stores exactly one thing on the
message — the component's `custom_id`. Your service receives the Discord
interaction for that `custom_id` and does the rest.

This decoupling means a new plugin is added by **listing its manifest** in the
bundled registry — no plugin code runs in DWEEB, you only edit one JSON file and
rebuild. (A second, URL-only kind exists for **Link buttons** — see
[Link plugins](#link-plugins--url-based-for-link-buttons) below.)

```
┌──────────────┐   manifest    ┌──────────────┐   custom_id    ┌──────────────┐
│   Registry   │ ────────────▶ │    DWEEB     │ ─────────────▶ │   Discord    │
│ (your JSON)  │               │  (the host)  │   in message   │              │
└──────────────┘               └──────┬───────┘                └──────┬───────┘
                                      │ iframe + postMessage           │ interaction
                                      ▼                                ▼
                               ┌──────────────────────────────────────────────┐
                               │      Your plugin microservice                 │
                               │  • config iframe (configUrl)                  │
                               │  • interaction handler (by custom_id)         │
                               │  • its own config storage                     │
                               └──────────────────────────────────────────────┘
```

## 1. List the plugin in the registry

The registry is **bundled into the build**, not fetched at runtime. Add your
plugin's manifest to [`src/core/plugins/registry.json`](../src/core/plugins/registry.json)
and rebuild the web app. Removing a plugin is the same: delete its entry and
rebuild. An empty `plugins` array disables the whole feature (the PluginPanel
renders nothing). `configUrl` (and any `icon`/`homepage`) must be `https://`, or
`http://localhost` for local dev.

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "schemaVersion": 1,
      "id": "role-menu",
      "name": "Role Menu",
      "description": "Let members self-assign roles from this select.",
      "version": "1.0.0",
      "icon": "https://plugins.example.com/role-menu/icon.png",
      "homepage": "https://plugins.example.com/role-menu",
      "publisher": "Example Co.",
      "targets": ["string_select", "role_select"],
      "configUrl": "https://plugins.example.com/role-menu/config",
      "customIdPrefix": "rolemenu:"
    }
  ]
}
```

> A malformed or duplicate entry is silently dropped at parse time, so a typo in
> `registry.json` just makes that plugin not appear — it never breaks the app.

### Manifest fields

| Field                  | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`        | yes      | Must be `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `id`                   | yes      | Stable kebab id, unique in the registry. First wins on duplicate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `name`                 | yes      | Shown in the picker and the attached chip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `description`          | no       | One line under the name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `version`              | no       | Your plugin's semver. Informational.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `icon`                 | no       | `https` image URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `homepage`             | no       | `https` docs/support link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `publisher`            | no       | Author/brand label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `defaultEmoji`         | no       | A unicode emoji (or `<:name:id>` token) the editor stamps onto a **button** when your plugin is freshly attached to a blank one, so a picked action arrives already labelled + emojied. A preset's own `emoji` wins over it; an emoji the user already set is never overwritten.                                                                                                                                                                                                                                                            |
| `targets`              | yes      | Which component kinds you support (see below). At least one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `resources`            | no       | Editor-data resources the config iframe may request. Access is default-deny; every requested resource must be declared here. See “Reading editor data.”                                                                                                                                                                                                                                                                                                                                                                                     |
| `configUrl`            | yes      | `https` (or `http://localhost`) iframe URL for configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `customIdPrefix`       | yes      | Every `custom_id` you mint must start with this. How DWEEB re-binds on reload and how it validates your saves. Keep it short and unique, e.g. `"rolemenu:"`.                                                                                                                                                                                                                                                                                                                                                                                |
| `apiVersion`           | no       | Highest protocol version you speak. Defaults to `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `managesSelectOptions` | no       | `string_select` plugins only. Set `true` to own the menu's option list: your `save` may return `options`, and DWEEB **wires them onto the select and locks the options editor** (see §3). Omit for a select plugin that leaves options to the user.                                                                                                                                                                                                                                                                                         |
| `managesFields`        | no       | Component fields you own beyond `custom_id`/options, as a string array. Each named field is set from your `save` payload's `fields` and **locked** in the inspector, so the user can't edit it and break your binding — e.g. a menu that grants exactly one role declares `["min_values", "max_values"]` and saves `fields: { min_values: 1, max_values: 1 }`. Lockable today: `min_values`, `max_values`, `placeholder`, `disabled`. Unknown names are dropped.                                                                            |
| `presets`              | no       | Ready-made configurations of your plugin shown as their own entries in the plugin library (and pickable on a template). Each is `{ id, name, description?, emoji?, targets? }`. DWEEB shows the display fields and, when the user picks one, passes the `id` to your iframe in `init.preset` — your iframe owns the actual field data and applies it (see §3). `targets` restricts a preset to certain component kinds (a topic-menu preset only on `string_select`); omit to apply to all your targets. Unknown/duplicate ids are dropped. |

A manifest that fails validation is silently dropped — it just won't appear in
the picker.

### Targets

Stable, Discord-agnostic names for the components a plugin can attach to:

`button` · `string_select` · `user_select` · `role_select` ·
`mentionable_select` · `channel_select`

(`button` means an **interactive** button — Link and Premium buttons carry no
`custom_id`, so these plugins can't attach to them. Link buttons instead take
the URL-based **link plugins** below.)

## Link plugins — URL-based, for Link buttons

Everything above describes the interactive kind of plugin. The registry also
accepts a second, much smaller kind: a **link plugin** (`"kind": "link"`),
which gives a _Link button_ its destination. It is nothing but an `https` URL
template served by an external service — clicking the button opens that URL in
the member's browser, and everything after the click (identifying the member,
acting on the server) happens on the external service. DWEEB is not involved
at all past the click, which buys three properties the interactive plugins
can't have:

- **No DWEEB backend footprint.** No dispatcher route, no Caddy site, no
  compose service, no health check. The §5 six-edit table collapses to _one_
  edit: list the manifest in `registry.json` and rebuild the web app.
- **Works through any webhook.** No `custom_id` means no interaction to route,
  so the message doesn't need an app-owned webhook.
- **Never expires.** The component-TTL rules only govern interactions; a link
  keeps working for the life of the message.

```json
{
  "schemaVersion": 1,
  "kind": "link",
  "id": "rolelogic-member-origin-role",
  "name": "Member Origin Role",
  "description": "Send members to RoleLogic to verify where they joined from and receive the matching origin role.",
  "version": "1.0.0",
  "publisher": "RoleLogic",
  "homepage": "https://rolelogic.faizo.net/integrations/member-origin-role",
  "url": "https://plugin-rolelogic.faizo.net/member-origin-role/verify?guild={server_id}",
  "setupUrl": "https://rolelogic.faizo.net/dashboard?plugin_select=https%3A%2F%2Fplugin-rolelogic.faizo.net%2Fmember-origin-role",
  "setupHint": "Set up RoleLogic for your server once from its dashboard — until then the verify link does nothing."
}
```

### Manifest fields (link kind)

| Field                                         | Required | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                               | yes      | Must be `1`.                                                                                                                                                                                                                                                                                                                                                          |
| `kind`                                        | yes      | Must be `"link"`. (Entries without a `kind` are the interactive plugins above.)                                                                                                                                                                                                                                                                                       |
| `id`                                          | yes      | Stable kebab id, unique in the registry.                                                                                                                                                                                                                                                                                                                              |
| `name`                                        | yes      | Shown in the library and the attached chip.                                                                                                                                                                                                                                                                                                                           |
| `description`                                 | no       | One line under the name.                                                                                                                                                                                                                                                                                                                                              |
| `version` / `icon` / `homepage` / `publisher` | no       | Same meaning as the interactive manifest.                                                                                                                                                                                                                                                                                                                             |
| `defaultEmoji`                                | no       | Unicode emoji (or `<:name:id>` token) stamped onto the Link button on a fresh attach — same behaviour as the interactive manifest's `defaultEmoji`. Never overwrites an emoji the user set.                                                                                                                                                                           |
| `url`                                         | yes      | The URL template written onto the button — see below.                                                                                                                                                                                                                                                                                                                 |
| `setupUrl`                                    | no       | The service's admin page where a server manager registers their server (invites your bot, configures the feature). Surfaced as a **Set up** action on the chip and a _Needs setup_ tag in the library.                                                                                                                                                                |
| `setupHint`                                   | no       | One line shown under the chip instead of the stock "set it up first" note.                                                                                                                                                                                                                                                                                            |
| `statusUrl`                                   | no       | Public, CORS-open probe URL template (may carry `{server_id}`) the editor fetches to turn the chip's static warning into a live **Ready / Needs setup** state. See [Setup status probe](#setup-status-probe-statusurl).                                                                                                                                               |
| `manageUrl`                                   | no       | Per-server management page URL template (may carry `{server_id}`). With a server connected, the chip's action deep-links here — labeled **Manage** when the probe says the server is set up, **Set up** otherwise — instead of the generic `setupUrl`, which typically lands on a create-from-scratch flow. `setupUrl` remains the fallback with no connected server. |
| `configUrl`                                   | no       | `https` config-iframe URL, the link analogue of the interactive `configUrl` — its `save` returns a **`url`** instead of a `customId`. Adds a **Configure** action to the chip. See [Config iframes for link plugins](#config-iframes-for-link-plugins-configurl).                                                                                                     |
| `resources`                                   | no       | Editor data the config iframe may request. For link plugins the allow-list is capped at content-free context — currently just `guild`; credentials and message content can never be declared.                                                                                                                                                                         |

### The `url` template is the whole binding

Exactly as the interactive plugins own a `custom_id`, a link plugin owns the
button's `url` — DWEEB stores nothing else. The owning plugin is re-derived by
prefix-matching the URL against the template's literal prefix (everything
before the first `{token}`) — on reload of a draft or share link, and _live as
the URL is edited_: unlike an opaque custom_id, a URL is human-meaningful, so
the field stays freely editable and the attachment simply follows it. Paste a
finished link and the matching chip (and its param fields) fill in by
themselves; paste another plugin's URL and the chip swaps; edit away from any
template and the button is a plain link again. Two rules follow:

- **Scheme and host must be literal `https`.** A token may parameterize the
  path or query, never where the link points. (`http://localhost` is allowed
  for local development.)
- **End the literal prefix at an unambiguous boundary** — a `/`, `?` or `=`,
  as in `…/verify?guild={server_id}` — so the prefix can't accidentally match
  another URL on the same host.

The template may carry any of the **core tokens** from the placeholders
section (`{server_id}`, `{channel_id}`, `{server}`, …). They substitute at
send time from the destination webhook, so one registry entry serves every
server — the service receives e.g. `?guild=812…` with the real guild id, with
no per-guild URL to configure. Discord's 512-character button-URL cap applies
to the template.

**When the destination isn't on your host**, put the token right after the
foreign host so the literal prefix is the host itself — the Top.gg entry is
`https://top.gg/{vote_page}`, which makes the chip claim _any_ top.gg URL:
the admin pastes their server's or bot's vote page and the binding follows.
(Trade-off: every top.gg link button shows that chip, which is the point —
the plugin _is_ "a top.gg link, rewarded".) Alternatively, if the unknown
part is per-server config your service already holds, a page on your own
host (`…/vote?guild={server_id}`) that 302s to the real destination keeps
the URL fully predictable with nothing to paste at all.

### Fill-me slots

A value only the admin placing the button knows — which form, which page —
can't come from the webhook. Leave it in the template as a non-core `{token}`:

```json
"url": "https://plugin-rolelogic.faizo.net/form-respondent-role/f/{form_id}",
"setupHint": "Build your form on the RoleLogic dashboard, then paste its link (…/f/YOUR-FORM-ID) over the button URL below."
```

There is no per-plugin UI for this — every link plugin gets the exact same
editor surface (chip, **Set up**, **Detach**, and the freely-editable URL
field the attachment follows). The admin finishes the button by pasting the
real link from your dashboard over the URL; your `setupHint` should say
exactly that. While a non-core `{token}` remains in a plugin-bound URL the
message **validator blocks send**, so a half-configured button can't post as
a dead link. Core tokens are exempt (they resolve at send), and the token
shape is the placeholder one (`^[a-z0-9_]{1,32}$`).

### What the external service implements

No DWEEB protocol at all — just the destination page. The recommended shape,
using the guild id the URL carries:

1. **Treat the `guild` query parameter as an untrusted hint**, not an
   authorization. Anyone can edit a URL.
2. **Identify the visitor yourself** — typically your own Discord OAuth
   (`identify` + `guilds`/`guilds.members.read`) — and verify they are
   actually a member of that guild before acting.
3. **Act with your own bot** (assign the role, record the verification) and
   show a human result page: what happened, or what to do if the server isn't
   set up yet.
4. **Serve a setup dashboard** (`setupUrl`) where a server manager can
   register the guild — invite your bot, map your settings. Until that's done
   the verify page should say so plainly rather than fail silently; DWEEB
   repeats the same warning next to the attached chip because it has no way to
   check your per-server state.

Fill-me slots are the zero-backend floor. A service that can do better has
two additive upgrades: a `statusUrl` probe (below) so the editor can _see_
per-server state, and a `configUrl` iframe (below) whose `save` returns the
finished `url` so the admin never hand-pastes at all.

### Setup status probe (`statusUrl`)

DWEEB has no way to check an external service's per-server state, so the
attached chip historically showed a _permanent_ "set it up first" warning.
A manifest `statusUrl` closes that gap. It's a URL template (same rules as
`url`; in practice it carries `{server_id}`) pointing at a **public,
credential-less** endpoint on your service:

```json
"statusUrl": "https://plugins.example.com/role-menu/dweeb/status?guild={server_id}"
```

When the editor has a connected server, it substitutes the guild id and
fetches the URL (no cookies, 8s timeout). Your service answers:

```json
{ "configured": true }
```

with `Access-Control-Allow-Origin: *` and a short `Cache-Control`
(`public, max-age=60` is right). `configured: true` renders the chip line
**"Set up for <server> — the link is live"** and hides the stock warning;
`false` renders a **"Not set up … yet"** caution. An optional integer
`role_count` enriches the ready line ("2 linked roles live"). Anything
else — non-200, bad JSON, a non-boolean `configured`, the service being
down, or CORS refused (as inside a Discord Activity, whose CSP blocks
external hosts) — degrades to exactly the pre-probe chip. The probe is
strictly best-effort display; it never gates editing or sending.

The editor re-probes (cache-bypassing) when its window regains focus, so
the expected loop — chip says _Needs setup_, admin opens your dashboard in
a new tab, sets it up, comes back — flips the chip on return rather than a
TTL later. Pair the probe with a `manageUrl` (see the manifest table) so
that dashboard trip lands on the _connected server's_ management page
instead of a generic create flow.

Because the endpoint is public, return only what any visitor could already
observe by loading your verify page with that guild id — a boolean (and, if
you like, a count), never configuration contents. Validate the `guild`
query as a snowflake. Extra response fields are ignored today; the host only
reads `configured` and `role_count`.

### Config iframes for link plugins (`configUrl`)

A value the admin must supply (which form? which page?) doesn't have to be
a hand-pasted fill-me slot: a link plugin may declare a `configUrl` and get
the same sandboxed config iframe as the interactive plugins — the chip
gains **Configure**, and picking the plugin in the library opens the iframe
immediately. The page speaks the exact same `dweeb:plugin:*` protocol
(§3), with three differences:

- `init` carries `kind: "link"`, and — when the button already holds a
  finished binding — `linkUrl` (the current URL) instead of `customId`, so
  the iframe can pre-select the current configuration.
- `save` returns a **`url`** instead of a `customId`. The host validates it
  the way it validates a returned custom_id: it must be within Discord's
  512-char cap, start with **your manifest's own literal template prefix**
  (a config iframe can refine its binding, never repoint the button at a
  foreign host), and carry no unfilled non-core `{token}`. `summary` and
  `guildId` work as in §3; the interactive-only fields (`options`,
  `fields`, `values`, `managementToken`) don't apply to a Link button.
- Editor-data requests are capped at content-free context: a link manifest
  may declare only `guild`. Credentials (`savedWebhook*`) and message
  content can't be declared and are refused.

One flow the sandbox shapes: the iframe has no first-party cookie context,
so if your picker needs the admin's identity, run your sign-in through a
**popup to your own origin** (`allow-popups` is granted) and hand a
short-lived bearer back to the iframe over `postMessage` — then keep a
paste-the-link fallback in the page for popup-blocked environments. The
worked example is RoleLogic's Form-Respondent-Role picker
(`/dweeb/picker` + `/dweeb/bridge` + `/dweeb/forms` in that service).

## 2. The `custom_id` is the whole binding

DWEEB stores **nothing** plugin-specific on the message. The binding _is_ the
component's `custom_id`, which you mint. Because it ships to Discord, it must:

- start with your `customIdPrefix`,
- be ≤ 100 characters,
- encode whatever **your** service needs to route and load config — typically
  an opaque instance reference, e.g. `rolemenu:7f3a9c`.

On reload (draft, share link), DWEEB recognizes the owning plugin purely by
prefix-matching the `custom_id`, and "Reconfigure" reopens your iframe with that
same `custom_id` so you can reload the instance's saved config.

> Your service owns authoritative config storage. DWEEB may proxy the config API
> inside a Discord Activity. The web host caches display metadata and, for a
> protocol-v2 stateful plugin, its separate edit credential in this browser.
> That credential never enters `custom_id`, a draft/share token, or a Discord
> message. Losing the browser cache must produce a new instance and rebind, not
> an unauthenticated update of the public instance id.

## 3. Build the config iframe (`configUrl`)

Your page runs sandboxed (`allow-scripts allow-forms allow-same-origin
allow-popups allow-popups-to-escape-sandbox`) and talks to DWEEB only through
`postMessage`. All messages are namespaced `dweeb:plugin:*`. Popups are allowed
so an external link (e.g. an OAuth invite) can open in a new tab via
`target="_blank"`; the host frame itself can't be navigated.

### Handshake

```
your iframe → DWEEB : "dweeb:plugin:ready"    { apiVersion }
DWEEB → your iframe : "dweeb:plugin:init"     { nonce, apiVersion, target, customId?, managementToken?, preset?, theme, locale }
your iframe → DWEEB : "dweeb:plugin:save"     { nonce, customId, managementToken?, summary?, options?, fields?, guildId? }
your iframe → DWEEB : "dweeb:plugin:cancel"   { nonce }                       // user backed out
your iframe → DWEEB : "dweeb:plugin:resize"   { nonce, height }              // optional auto-height
your iframe → DWEEB : "dweeb:plugin:request"  { nonce, requestId, resource, resourceId? }  // read declared editor data
DWEEB → your iframe : "dweeb:plugin:response" { nonce, requestId, resource, ok, data?, error? }
```

Rules:

- **Post `ready` once your UI has booted.** DWEEB compares it with the manifest's
  declared `apiVersion` and sends `init` only after a compatible version is
  negotiated. A declared v2 plugin whose deployed iframe still reports v1 gets
  a visible compatibility error rather than partial initialization.
- **Echo the `nonce`** from `init` on every message you send back. DWEEB ignores
  any message without the current nonce, or from the wrong origin.
- Use `init.customId` (when present) to load the instance being edited; absent
  means the user is attaching fresh.
- `init.preset` (optional, only on a fresh attach) is one of your manifest
  `presets` ids the user picked in the library or a template carried. Look it up
  in your own preset table and pre-fill the config form, so the user customizes a
  working setup instead of a blank one. An id you don't recognize: ignore it and
  open blank.
- On `save`, DWEEB validates `customId` (prefix + length) before adopting it. A
  mismatch is rejected and the modal stays open.
- Protocol v2 stateful plugins return a fresh 256-bit `managementToken` once from
  create and echo it in `save`. DWEEB validates and keeps it browser-local, then
  sends it back in a later `init` for that exact plugin + `customId`. Store only a
  SHA-256 hash server-side and require the raw token in
  `X-DWEEB-Plugin-Edit-Token` for `PUT`. If `init.managementToken` is absent,
  `POST` a new instance and return its new id/token so DWEEB rebinds safely.
- `summary` is optional: `{ label, description?, icon? }` for a nicer chip.
- `guildId` is optional: the Discord guild this binding targets, if your plugin
  is guild-scoped (it only works in the server it was configured for). DWEEB
  caches it per binding and warns before the message is posted to a webhook in a
  different server, where the component would be dead on arrival. A snowflake;
  anything else is dropped.
- `options` is optional and only honored when `target === "string_select"` **and**
  your manifest sets `managesSelectOptions`. Each entry is
  `{ label, value, description?, emoji? }`; DWEEB sanitizes them (trims, clamps to
  Discord's caps, dedupes by `value`, max 25), wires them onto the select, and
  **locks** the options editor so the user can't break the `value` contract your
  service matches on. It's the select analogue of owning the `custom_id`: stop
  making users hand-map each option's value (e.g. a role id) by copy-paste.
- `fields` is optional: values for the component fields your manifest declared in
  `managesFields` (e.g. `{ min_values: 1, max_values: 1 }`). DWEEB accepts only
  declared fields, clamps each to Discord's limits, writes them onto the
  component, and **locks** them in the inspector — so the user can't widen
  `max_values` and break a menu you built for a single pick. Fields you didn't
  declare are ignored.
- Always target DWEEB's origin in `postMessage` (use `event.origin` from the
  `init` message), never `"*"`.

### Minimal example

```html
<script>
  let nonce = null;

  // 1) Tell the host we're ready.
  parent.postMessage({ type: "dweeb:plugin:ready", apiVersion: 1 }, "*");

  // 2) Receive context.
  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg?.type !== "dweeb:plugin:init") return;
    nonce = msg.nonce;
    hostOrigin = e.origin;
    // msg.customId is set when reconfiguring → load saved config from your API.
    render(msg);
  });

  // 3) Save: mint a custom_id under your prefix and hand it back.
  function save(instanceRef) {
    parent.postMessage(
      {
        type: "dweeb:plugin:save",
        nonce,
        customId: "rolemenu:" + instanceRef,
        summary: { label: "Role Menu", description: "3 roles" },
      },
      hostOrigin,
    );
  }
</script>
```

### Deploying a protocol-v2 stateful plugin

Use a two-stage rollout, in this order:

1. Deploy the plugin services and their embedded/static config pages first. The
   new iframe must remain safe under an old v1 host: it may load public masked
   config, but without `init.managementToken` it uses `POST` to create and rebind
   instead of attempting `PUT`.
2. After both plugin services are healthy and their iframes report v2, deploy the
   web host with the v2 manifests and token cache. Deploying the web host first is
   intentionally fail-closed: it shows the compatibility error until the plugin
   iframe is upgraded.

A full, real plugin (Rust backend + Discord modal flow) lives in
[`plugins/modal-form/`](../plugins/modal-form/).

### Reading editor data (optional)

Some plugins need the user's own builder content to configure themselves. Ask
for it with a `request`; DWEEB replies with a matching `response` (same
`requestId`). Resources are a fixed allow-list and must also appear in the
plugin's manifest `resources` array. The OAuth session and AI provider keys are
**never** exposed.

| `resource`      | `data` returned                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `savedMessages` | `[{ id, name, savedAt, payload }]` — the user's named saved messages (Components V2 wire payloads).                                                                                                                   |
| `savedWebhooks` | `[{ id, name, channelName?, guildName? }]` — safe labels for webhooks saved in this browser. Execute URLs are deliberately omitted.                                                                                   |
| `savedWebhook`  | `{ id, url }` for one `resourceId`. DWEEB shows a host-controlled confirmation naming the plugin and destination before releasing this credential. Declare both `savedWebhooks` and `savedWebhook` for a picker.      |
| `message`       | The message currently being built, as a clean Discord wire payload.                                                                                                                                                   |
| `component`     | `{ target, customId }` for the component you're attached to.                                                                                                                                                          |
| `guild`         | `{ id, name }` of the server the editor is connected to, or `null` if none. Lets a plugin target "this server" without the user pasting an id (e.g. Self Role auto-fills it). A guild id is public, not a credential. |

> A webhook URL embeds a token. Never place URLs in picker option data. Request
> safe `savedWebhooks` labels first, then request singular `savedWebhook` with the
> selected id. For `savedWebhook`, the requesting iframe document creates a
> `MessageChannel` and transfers one port with the original request; DWEEB sends
> the approval result only over that document-bound port, never through the
> iframe's navigation-stable `contentWindow`. The host owns the confirmation. A
> declined request returns `{ ok: false }` and further credential prompts are
> refused until the config modal is reopened.

```js
// Ask for the user's saved messages, e.g. to offer a "reply with…" picker.
const requestId = crypto.randomUUID();
parent.postMessage(
  { type: "dweeb:plugin:request", nonce, requestId, resource: "savedMessages" },
  hostOrigin,
);

window.addEventListener("message", (e) => {
  const m = e.data;
  if (m?.type !== "dweeb:plugin:response" || m.requestId !== requestId) return;
  if (m.ok) populatePicker(m.data); // [{ id, name, savedAt, payload }]
});
```

Anything not in the table is refused with `{ ok: false, error }`.

## 4. Handle the interaction

When a user clicks the button / uses the select in Discord, your application
receives an interaction whose `custom_id` is the one you minted. Parse your
instance reference out of it, load the config your iframe saved, and respond.
That half lives entirely in your service and is outside DWEEB's scope.

> Interactive components only fire when the message is sent through an
> **application-owned** webhook. DWEEB surfaces this requirement in the editor;
> your plugin's documentation should explain how users wire your app up.

> **Components expire after 7 days by default.** On the production stack the
> dispatcher rejects clicks on messages older than `COMPONENT_TTL_DAYS`
> (default 7, counted from the message's send time via its snowflake id): the
> first expired click disables the component on the message itself and is
> never forwarded to your plugin, and a disabled component fires no further
> interactions. This caps the lifetime traffic any one message can generate.
> Operators can change the window or set `0` for no expiry.
>
> **Each guild can exempt 2 messages** (`PERMANENT_SLOTS_PER_GUILD`),
> managed from the dashboard: the pre-send confirmation offers
> **Make permanent** to a signed-in user who manages the server, and the
> gallery's **Message directory → Posted** tab carries an assign/free
> control on every posted card (plus a recovery list for slots whose
> message has left the history). Making a message never-expire also **switches its disabled
> components back on** — the dispatcher asks the proxy (which holds the
> webhook token) to clear the flags an expired click stamped on.
> See the [dispatcher README](../plugins/dispatcher/README.md).

## Placeholders: message text that follows your values

A plugin can let the user drop **placeholders** into their _own_ message text —
`{prize}`, `{entries}`, `{winners}` — and have them filled with the plugin's
values, both at send time and **live** after the message is posted (the Giveaway
plugin's `{winners}` settles in once a draw happens). It's opt-in and additive: a
plugin that declares none behaves exactly as before.

There are two substitution moments, and they belong to different owners:

| Moment          | Who          | What                                                                                                                                                                                                                     |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **First paint** | DWEEB (host) | At send + in the live preview, DWEEB replaces each declared `{token}` with the value your `save` returned, falling back to the manifest `sample`. So no raw `{token}` ever reaches Discord.                              |
| **Live render** | your plugin  | Once posted, only you can keep the message current — a webhook message is editable solely via an `UPDATE_MESSAGE` reply to a click on it. You re-render your own stored copy on each interaction. DWEEB is not involved. |

This split is forced by the platform: DWEEB stores nothing on the message but the
`custom_id`, and a bot can't edit a webhook-authored message out of band. So
**values that change after posting refresh on the next interaction, not
instantly** — design for that (e.g. Giveaway fills `{winners}` on the first click
after the draw; the public announcement carries the instant news).

### Core (server/channel) tokens are always available

Independent of any plugin, DWEEB offers a built-in **core** set of server/channel
tokens on every message:

| Token                | Resolves to                                 |
| -------------------- | ------------------------------------------- |
| `{server}`           | Server name                                 |
| `{server_id}`        | Server ID                                   |
| `{server_icon}`      | Server icon URL (usable as an avatar/image) |
| `{channel}`          | Channel name                                |
| `{channel_id}`       | Channel ID                                  |
| `{channel_mention}`  | Clickable `<#id>`                           |
| `{channel_category}` | Name of the channel's parent category       |

Server tokens resolve from the connected guild in the preview; channel tokens
resolve from the destination webhook at send. This namespace is **reserved** — a
plugin that declares a token with one of those names has it dropped on parse, so
`{server}` always means the server.

These tokens (and a plugin's own) substitute into far more than message text:
besides Text Display content they fill **button labels and link URLs**, **select
placeholders**, **string-select option label/value/description**, **thumbnail and
gallery alt-text and media URLs**, and the message-level **username / avatar URL /
forum thread name**. A field that's normally format-checked (a URL, a SKU id) is
**not** flagged for its raw `{token}` shape — the validator recognises the
placeholder and waits for substitution to produce the real value. Bot-facing
identifiers (`custom_id`, snowflake lists) are intentionally left alone.

### More than one provider on a message

A message can carry the core tokens **and** one or more plugins' tokens at once.
Resolution is deterministic: providers are walked **core first, then each plugin
in binding order**, and the _first_ to claim a token wins. The `{}` insert palette
groups tokens under their provider's name and dedupes against that same order, so
what the user inserts is what resolves. Keep your token names specific (`raffle_status`,
not `status`) to avoid colliding with another plugin on the same message.

Because your live re-render rebuilds the **whole** message from your stored template
but only knows your _own_ tokens, DWEEB hands you a template in which every token
you don't own — the core tokens and any other plugin's — is **already baked to its
first-paint value**; only your own tokens stay raw. So a `{server}` sitting next to
your `{winners}` keeps its value on your lazy refresh instead of decaying to a
literal `{server}`. You don't have to do anything for this — just request the
`message` resource as usual (below) and store what you receive.

### Declare them in the manifest

```json
"placeholders": [
  { "token": "prize",   "label": "Prize",   "sample": "the prize" },
  { "token": "entries", "label": "Entries", "sample": "0" },
  { "token": "winners", "label": "Winners", "sample": "TBD" }
]
```

| Field    | Notes                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `token`  | `^[a-z0-9_]{1,32}$`. Written `{token}` in message text.                                                                                                                                    |
| `label`  | Human name for the authoring UI.                                                                                                                                                           |
| `sample` | Optional. Shown at first paint before a live value exists (dynamic tokens), or as a fallback when no per-instance value was cached. A token with no value and no sample renders literally. |

Unknown/malformed `{…}` is left **verbatim** everywhere, so stray braces in prose
are safe.

### Send the values on save

Your `save` message may carry a `values` map (token → string) for the values you
know at config time (the real prize, the winner count). DWEEB sanitizes them
(string-typed, length-clamped, `@everyone`/`@here` defanged so a value can't smuggle
a mass ping) and caches them per binding next to the `summary`. Omit a token and it
falls back to the manifest `sample` — that's how a _dynamic_ value (`{winners}`)
shows a friendly stand-in until your service renders it for real.

```js
parent.postMessage(
  {
    type: "dweeb:plugin:save",
    nonce,
    customId,
    values: { prize: "a Nitro month", winner_count: "3" },
  },
  hostOrigin,
);
```

### Render it live (your service)

To re-render after posting you need a stable, raw-token **template**, because
substituting `{winners}` → mentions is irreversible (and changes again on a
reroll). Capture the user's message once on save — request the `message` resource
(§3) and keep its `components`, with **your** `{tokens}` intact (other providers'
tokens arrive already baked, as above) — store it, and on every interaction
re-render it with the current values, replying `UPDATE_MESSAGE`.
Render from the _template_ each time, never from the already-rendered message, so
the result is idempotent (the count restamps, winners swap on a reroll). Set
`allowed_mentions.parse = []` on that edit so a re-render can never ping
`@everyone`. The Giveaway plugin (`render_bound_message` / `substitute` in
`plugins/giveaway/src/discord.rs`) is the worked example.

> **Drift:** the template is captured at _save_ time. If the user edits the
> message text afterward without reopening your config, your first re-render uses
> the stale copy. Re-capture on every save; treat it as the same expendable,
> same-device convenience as the summary cache.

### You often don't need a live render at all

Live re-rendering is only worth it for values that **change after posting** _and_
whose change is driven by **a click on that same message** (the giveaway's entrant
count and winners). Two cases that are simpler:

- **Static values** — known at config time and fixed thereafter (Self Role's
  `{roles}`). Just send them in `values` on save; DWEEB paints them at first
  paint and you store no template, render nothing. This is the common, easy case.
- **Values whose change isn't a click on the message** — e.g. a count that moves
  on an action taken _elsewhere_ (a ticket closed from inside its own channel, a
  form submitted in a modal). A webhook message can only be edited in reply to a
  click on it, so such a placeholder would drift out of sync and mislead. Don't
  offer it; the universal `{server}`/`{channel}` tokens still work in the message.

So a plugin's three honest options are: **live** (giveaway), **static** (self
role), or **none of its own** (it still inherits the core server/channel tokens).

## 5. Hosting a plugin on the DWEEB production stack

A Discord application has exactly **one** Interactions Endpoint URL, so all
plugins share it: the [interactions dispatcher](../plugins/dispatcher) sits at
`https://interactions.dweeb.faizo.net` (stable forever) and routes
each interaction to a plugin by its `customIdPrefix`. Every plugin is served at its
own origin, `https://<id>.dweeb.faizo.net` — covered by ONE wildcard DNS record
(`*.dweeb.faizo.net` → the server, DNS only) and ONE CSP wildcard
(`frame-src https://*.dweeb.faizo.net` in the CSP built from `vite.config.ts`), so none of that
recurs per plugin.

Adding a plugin (say `ping-pong`, prefix `pingpong:`) is six edits:

| #   | File                               | Edit                                                                                                                                                   |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `server/compose.yml`               | Copy the `modal-form` service block: new image (CI workflow publishes `ghcr.io/<owner>/dweeb-<id>`), own volume if it has state.                       |
| 2   | `server/Caddyfile`                 | Copy a plugin block: `pingpong.{$PLUGINS_DOMAIN} { import site_defaults; reverse_proxy ping-pong:8090 }`.                                              |
| 3   | `server/compose.yml` (dispatcher)  | Add `"pingpong:": "http://ping-pong:8090"` to `ROUTES`.                                                                                                |
| 4   | `src/core/plugins/registry.json`   | Add the manifest with `configUrl: https://pingpong.dweeb.faizo.net/config.html`.                                                                       |
| 5   | `server/gatus/config.yaml`         | Copy a `plugins`-group endpoint hitting `https://pingpong.{$PLUGINS_DOMAIN}/health`, so the new plugin shows on the status page and alerts on failure. |
| 6   | `.github/workflows/plugins-ci.yml` | Add the plugin id to the `matrix.plugin` list so fmt/clippy/tests gate it like every other crate.                                                      |

Then `docker compose pull && docker compose up -d` on the server (Caddy issues
the new subdomain's certificate automatically) and push so the frontend
rebuilds with the new registry. Note that CD only pulls images — the
bind-mounted `server/` config files (`Caddyfile`, `compose.yml`,
`gatus/config.yaml`) must be copied to the host yourself: reload Caddy after a
`Caddyfile` change and restart Gatus (`docker compose restart gatus`) after a
`gatus/config.yaml` change, since neither picks up a content-only edit on its
own. The plugin itself just implements this
document's protocol plus `GET /health` and a signature-verified
`POST /interactions` — the dispatcher forwards the raw body and signature
headers untouched, so verification works exactly as if Discord called the
plugin directly.

One wrinkle since **custom bots**: a guild may register its own Discord app
(dashboard → _Custom bot_), and those interactions are signed with _that_
app's key, not the deployment's `DISCORD_PUBLIC_KEY`. The dispatcher
therefore forwards which key verified the request in `x-dweeb-public-key`,
vouched for by the shared `DISPATCHER_FORWARD_SECRET` in
`x-dweeb-forward-auth`. A plugin should verify with the forwarded key **only
when the secret matches** (constant-time compare) and fall back to its
configured key otherwise — see `attested_key` in any bundled plugin. A
plugin that skips this still works for the main app; custom-app clicks just
fail its verification.

## 6. The quality bar (the reference plugin)

§1–5 are the _minimum_ to make a plugin function. They are not the bar for
adding one to the bundled registry. Because the registry is curated, a listed
plugin can receive real credentials (a singular `savedWebhook` only after the
host-owned user confirmation) and, if it touches Discord, may use a shared bot
token. A plugin that ships is held to the standard below.

**[`plugins/self-role/`](../plugins/self-role/) is the reference
implementation — start there and copy its shape.** It is the smallest plugin
that exercises _everything_: stateful config, the config iframe with editor-data
reads, signature verification, custom-app attestation, and Discord REST calls
under a hard latency budget. Its file layout is the suggested skeleton:

| File                 | Responsibility                                                     |
| -------------------- | ------------------------------------------------------------------ |
| `main.rs`            | Wiring only: env → router → listen, plus graceful shutdown.        |
| `config.rs`          | Parse env once at startup; fail fast with a clear message.         |
| `store.rs`           | Persistence. Small surface (`create` / `get` / `update`).          |
| `discord.rs`         | Signature verify, request shapes, and the **pure** decision logic. |
| `rest.rs`            | The thin outbound HTTP layer (the only I/O that can fail slowly).  |
| `validate.rs`        | Validate everything the browser sends before it is stored.         |
| `routes.rs`          | HTTP handlers — the imperative shell that glues the above.         |
| `static/config.html` | The config iframe, embedded in the binary (`include_str!`).        |

The other bundled plugins are narrower references: [`ping-pong`](../plugins/ping-pong/)
(minimal stateless), [`modal-form`](../plugins/modal-form/) (the iframe + a
forwarding flow), [`dispatcher`](../plugins/dispatcher/) (routing).

### Checklist

**Security**

- [ ] Verify the Ed25519 signature on the **raw body, before JSON parsing**;
      missing/bad signature → `401`, fail closed.
- [ ] Honor custom-app attestation: prefer the forwarded `x-dweeb-public-key`
      **only** when `x-dweeb-forward-auth` matches in **constant time** (§5).
- [ ] Treat the iframe as untrusted input: `validate.rs` rejects anything
      malformed _before_ it is stored; the interaction path re-derives trust from
      the payload (e.g. intersect a select's submitted values with the menu's
      managed set — never act on a raw client-supplied id).
- [ ] Keep secrets in env, never in the database, never in a browser response.
      If you call a third party, pin the host so there is no SSRF surface.
- [ ] Never use the id published in Discord `custom_id` as edit authorization.
      Return a separate 256-bit random edit token once on create, persist only
      its SHA-256 hash, and require it for updates. A missing token must create a
      replacement instance/rebind rather than weaken authorization.
- [ ] In the config iframe, render any Discord-supplied string (role/channel
      names) with `textContent` / `createElement`; `escapeHtml` before any
      `innerHTML`.

**Robustness**

- [ ] An interaction must answer inside Discord's ~3s window _after_ the
      dispatcher hop — give the outbound HTTP client a sub-3s timeout (self-role
      uses 2.5s) and fan out independent calls concurrently.
- [ ] Map failure causes to **distinct, actionable** replies. Don't collapse
      "Discord refused this (fix hierarchy)" with "Discord was busy (try again)".
- [ ] Bound every resource the user controls (counts, string lengths) and clamp
      values that must satisfy a downstream contract (e.g. audit-log reasons are
      ASCII-only header values).
- [ ] Serve `GET /health`. Exit non-zero on a fatal config error at startup.

**UX & footprint**

- [ ] User-facing strings name the problem _and_ the fix in plain language.
- [ ] Optimize the release binary for size (`opt-level="z"`, `lto`, `strip`) and
      ship a multi-stage `debian-slim` image — plugins target the cheapest tiers.

### Design & testing

Keep the **decision** pure and the **I/O** thin — a pure-core / imperative-shell
split. In self-role the entire "which roles change" rule is one pure function
(`plan_changes`) with no I/O, so it is exhaustively unit-tested while `rest.rs`
and `routes.rs` stay glue. **That pure core is the part you are expected to
cover with tests**; mocking Discord is not.

### Storage: SQLite by default

A plugin's state is almost always a **bag of config blobs keyed by an
unguessable id** — written once on Save, read once per interaction. That is a
three-method store (`create` / `get` / `update`), and the right backend is an
**embedded SQLite file** (`rusqlite` with `bundled`, WAL mode): no DB server to
run, secure, or pay for; it compiles into the binary; the whole datastore is one
file on a small volume. This is what lets a plugin run on a free tier or a $5
VPS, and it is the default every new plugin should use.

> **Reach for Postgres only to run multiple replicas of one plugin behind a load
> balancer (horizontal scale / HA).** Local-file SQLite breaks there because each
> replica gets its own file — that, or a shared/relational data model across
> plugins, is the _only_ reason to take on an external database. It is not
> warranted by data size or write rate at this scale: a config read is an
> in-process microsecond lookup, and a network round-trip to Postgres would eat
> into the 3s interaction budget for nothing. Don't pre-migrate; the `store.rs`
> surface is small enough to swap a backend behind if that day ever comes.
