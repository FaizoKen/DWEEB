# DWEEB plugins

A **plugin** gives an interactive component (a button with a `custom_id`, or a
select menu) its behavior. Plugins are independent **microservices**: DWEEB
never runs your code. It reads your manifest from a registry, embeds your
configuration UI in a sandboxed iframe, and stores exactly one thing on the
message — the component's `custom_id`. Your service receives the Discord
interaction for that `custom_id` and does the rest.

This decoupling means a new plugin is added by **listing its manifest** in the
bundled registry — no plugin code runs in DWEEB, you only edit one JSON file and
rebuild.

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

| Field            | Required | Notes |
|------------------|----------|-------|
| `schemaVersion`  | yes      | Must be `1`. |
| `id`             | yes      | Stable kebab id, unique in the registry. First wins on duplicate. |
| `name`           | yes      | Shown in the picker and the attached chip. |
| `description`    | no       | One line under the name. |
| `version`        | no       | Your plugin's semver. Informational. |
| `icon`           | no       | `https` image URL. |
| `homepage`       | no       | `https` docs/support link. |
| `publisher`      | no       | Author/brand label. |
| `targets`        | yes      | Which component kinds you support (see below). At least one. |
| `configUrl`      | yes      | `https` (or `http://localhost`) iframe URL for configuration. |
| `customIdPrefix` | yes      | Every `custom_id` you mint must start with this. How DWEEB re-binds on reload and how it validates your saves. Keep it short and unique, e.g. `"rolemenu:"`. |
| `apiVersion`     | no       | Highest protocol version you speak. Defaults to `1`. |

A manifest that fails validation is silently dropped — it just won't appear in
the picker.

### Targets

Stable, Discord-agnostic names for the components a plugin can attach to:

`button` · `string_select` · `user_select` · `role_select` ·
`mentionable_select` · `channel_select`

(`button` means an **interactive** button — Link and Premium buttons carry no
`custom_id`, so plugins can't attach to them.)

## 2. The `custom_id` is the whole binding

DWEEB stores **nothing** plugin-specific on the message. The binding *is* the
component's `custom_id`, which you mint. Because it ships to Discord, it must:

- start with your `customIdPrefix`,
- be ≤ 100 characters,
- encode whatever **your** service needs to route and load config — typically
  an opaque instance reference, e.g. `rolemenu:7f3a9c`.

On reload (draft, share link), DWEEB recognizes the owning plugin purely by
prefix-matching the `custom_id`, and "Reconfigure" reopens your iframe with that
same `custom_id` so you can reload the instance's saved config.

> Your service owns config storage. DWEEB does not persist or proxy it. The only
> cosmetic thing DWEEB caches locally is the optional `summary` you return on
> save, to label the chip nicely — it's expendable.

## 3. Build the config iframe (`configUrl`)

Your page runs sandboxed (`allow-scripts allow-forms allow-same-origin`) and
talks to DWEEB only through `postMessage`. All messages are namespaced
`dweeb:plugin:*`.

### Handshake

```
your iframe → DWEEB : "dweeb:plugin:ready"    { apiVersion? }
DWEEB → your iframe : "dweeb:plugin:init"     { nonce, apiVersion, target, customId?, theme, locale }
your iframe → DWEEB : "dweeb:plugin:save"     { nonce, customId, summary? }   // adopt this id
your iframe → DWEEB : "dweeb:plugin:cancel"   { nonce }                       // user backed out
your iframe → DWEEB : "dweeb:plugin:resize"   { nonce, height }              // optional auto-height
your iframe → DWEEB : "dweeb:plugin:request"  { nonce, requestId, resource }  // read editor data
DWEEB → your iframe : "dweeb:plugin:response" { nonce, requestId, resource, ok, data?, error? }
```

Rules:

- **Post `ready` once your UI has booted.** DWEEB replies with `init`.
- **Echo the `nonce`** from `init` on every message you send back. DWEEB ignores
  any message without the current nonce, or from the wrong origin.
- Use `init.customId` (when present) to load the instance being edited; absent
  means the user is attaching fresh.
- On `save`, DWEEB validates `customId` (prefix + length) before adopting it. A
  mismatch is rejected and the modal stays open.
- `summary` is optional: `{ label, description?, icon? }` for a nicer chip.
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

A full, real plugin (Rust backend + Discord modal flow) lives in
[`plugins/modal-form/`](../plugins/modal-form/).

### Reading editor data (optional)

Some plugins need the user's own builder content to configure themselves. Ask
for it with a `request`; DWEEB replies with a matching `response` (same
`requestId`). Resources are a fixed allow-list. Most return pure *content*; the
one exception is `savedWebhooks`, which returns saved webhook execute URLs (a
credential) so a forwarding plugin can post to them — see the note below. The
OAuth session and AI provider keys are **never** exposed.

| `resource`      | `data` returned |
|-----------------|-----------------|
| `savedMessages` | `[{ id, name, savedAt, payload }]` — the user's named saved messages (Components V2 wire payloads). |
| `savedWebhooks` | `[{ id, name, url, channelName?, guildName? }]` — webhooks saved in this browser, including the execute `url`. For forwarding plugins (e.g. Modal Form) so the user can pick a destination instead of re-pasting a URL. |
| `message`       | The message currently being built, as a clean Discord wire payload. |
| `component`     | `{ target, customId }` for the component you're attached to. |

> **`savedWebhooks` hands over a credential.** A webhook URL embeds a token;
> this gate auto-answers any plugin iframe with no per-request user gesture, so a
> plugin can read every saved webhook URL the moment its config opens. That's why
> the registry is bundled and curated — only ship plugins you trust with it.

```js
// Ask for the user's saved messages, e.g. to offer a "reply with…" picker.
const requestId = crypto.randomUUID();
parent.postMessage({ type: "dweeb:plugin:request", nonce, requestId, resource: "savedMessages" }, hostOrigin);

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
> account menu's **Managed messages** dialog lists the occupying
> messages so slots can be freed (including ones held by deleted
> messages). See the [dispatcher README](../plugins/dispatcher/README.md).

## 5. Hosting a plugin on the DWEEB production stack

A Discord application has exactly **one** Interactions Endpoint URL, so all
plugins share it: the [interactions dispatcher](../plugins/dispatcher) sits at
`https://interactions.dweeb.faizo.net` (stable forever) and routes
each interaction to a plugin by its `customIdPrefix`. Every plugin is served at its
own origin, `https://<id>.dweeb.faizo.net` — covered by ONE wildcard DNS record
(`*.dweeb.faizo.net` → the server, DNS only) and ONE CSP wildcard
(`frame-src https://*.dweeb.faizo.net` in the CSP built from `vite.config.ts`), so none of that
recurs per plugin.

Adding a plugin (say `ping-pong`, prefix `pingpong:`) is four edits:

| # | File | Edit |
|---|---|---|
| 1 | `server/compose.yml` | Copy the `modal-form` service block: new image (CI workflow publishes `ghcr.io/<owner>/dweeb-<id>`), own volume if it has state. |
| 2 | `server/Caddyfile` | Copy a plugin block: `pingpong.{$PLUGINS_DOMAIN} { import site_defaults; reverse_proxy ping-pong:8090 }`. |
| 3 | `server/compose.yml` (dispatcher) | Add `"pingpong:": "http://ping-pong:8090"` to `ROUTES`. |
| 4 | `src/core/plugins/registry.json` | Add the manifest with `configUrl: https://pingpong.dweeb.faizo.net/config.html`. |

Then `docker compose pull && docker compose up -d` on the server (Caddy issues
the new subdomain's certificate automatically) and push so the frontend
rebuilds with the new registry. The plugin itself just implements this
document's protocol plus `GET /health` and a signature-verified
`POST /interactions` — the dispatcher forwards the raw body and signature
headers untouched, so verification works exactly as if Discord called the
plugin directly.
