# DWEEB Directory plugin

Attach it to a **button** or an options **menu**, and a click answers with a live
list of the server.

Two modes:

- **Roles & staff** — a roster. The roles you pick (or every role the server
  displays separately, or every role with moderation powers — bots' own
  integration roles excluded), arranged into named sections like _Owners_ /
  _Moderators_, each with a permission badge line (`Admin`, `Bans · Timeouts`)
  and your own one-line description.
- **Channels** — an index. Every channel (or a category, or a hand-picked
  shortlist) grouped under its category heading, each captioned with its own
  topic. A sweep only names channels its readers can see — see
  [Hidden channels](#hidden-channels).

Everything is read **at click time**, so a renamed role or a rewritten channel
topic is current without anyone re-editing the message.

## Where the list appears

Two output shapes, chosen in the config panel:

- **In a reply** (default) — a click answers the clicker, privately unless you
  make it public. Best for a long roster: the reply gets its own 4000-character
  budget and the channel stays clean.
- **In the message itself** — you put `{directory}` in your own message text and
  the list is written there, so **everyone reads it without clicking**. Any click
  re-stamps it in place for everyone. Also available: `{directory_count}` and
  `{directory_updated}` (a live "5 minutes ago").

One honest limit on the second option: **Discord only lets the list refresh when
someone clicks.** A webhook-authored message is editable solely through an
interaction on it, or with the webhook token — which lives sealed in the proxy and
never reaches a plugin. There is no way for the plugin to push an update on its
own, so label the button something like *Refresh*. In exchange, the list is
readable by anyone at any time without interacting at all.

The in-message list shares the message's single 4000-character allowance with the
author's own text, so each refresh fits it into what that text leaves (at most
2000 characters), and saving refuses a message that leaves almost nothing.
`{directory}` only goes in message text — a button label or menu placeholder is a
single short line — while `{directory_count}`/`{directory_updated}` fit anywhere.
Pictures in such a message must be links: a refresh is sent from this service,
where a picture uploaded from the author's computer doesn't exist (and a File
component can't travel at all), so saving refuses those.

Whenever a refresh can't be done safely, the click is answered with the list in a
private reply and **the message is left exactly as it is**: when the server read
fails (an error sentence must never become the list everyone reads), when a stored
template still names an uploaded picture, and when the message has changed shape
since the directory was configured (see the design notes).

## Hidden channels

The bot can read every channel in a server — staff rooms, ticket channels,
anything. So a channel *sweep* ("every channel", "everything in these
categories") lists only what its readers can see:

- a reply **only the clicker sees** lists exactly the channels that clicker can
  see (`@everyone`'s permissions, their roles, the channel's overwrites, and
  administrators seeing everything — Discord's own rules);
- anything **everyone reads** — a public reply, or the list in the message
  itself — lists only channels `@everyone` can see.

A channel you **pick by hand** is your choice and is always listed. On a server
where `@everyone` can't see channels at all (a verification gate), a shared sweep
is therefore short: use a private reply, or pick the channels. `POST /api/connect`
also never returns a hidden channel's topic (its name is tagged *hidden* in the
config panel's pickers).

## What it needs

**Only the shared DWEEB bot, invited to the server. Nothing else** — no permission
bit and **no privileged intent**. `GET /guilds/{id}`, `/roles` and `/channels` all
work for any bot that is simply a member, and this plugin **never writes**
anything to a server. There is no deployment in which some of it works and the
rest doesn't.

### Why there is no "who holds each role"

Because Discord doesn't offer it without the privileged **Server Members Intent**,
and it can't be worked around:

- `GET /guilds/{id}/members` states the requirement outright.
- `GET /guilds/{id}/members/search` — the one member endpoint that isn't gated —
  requires a name prefix and **cannot filter by role**, so it enumerates nothing.
- The role object carries no member count.

An earlier version shipped this as a graceful degradation: with the intent off,
the roster rendered and added "Member lists aren't available right now." In
practice that put an apology in the middle of members' messages on every
deployment that hadn't enabled the intent, which is most of them. It was removed
rather than left to rot as a permanently dead option.

What replaced it: an optional **"1,204 members · 87 online"** line under the
heading. Those are the guild's own totals, they ride along on a request the
plugin already makes (`?with_counts=true`), and they need no intent. If Discord
doesn't send a total, the line is omitted rather than printed as `0`.

## Design notes worth knowing before changing it

- **Mentions, not names.** A role renders as `<@&id>`, so Discord paints its own
  colour pill, the entry is clickable, and a rename can't stale the message. Every
  reply therefore sets `allowed_mentions: {parse: []}` — **load-bearing**, not
  politeness: without it a *public* staff list would ping every role it names on
  every single click.
- **Nothing defers.** A read is three concurrent requests, which answers inside
  Discord's ~3s window, so every click gets a terminal response — no "thinking…"
  placeholder and no follow-up edit anywhere in the plugin. The defer path existed
  only to cover the member scan and went with it. A guard test asserts no response
  this plugin can build is type 5 or 6.
- **Channel topics are untrusted text.** Discord's inline styles cross newlines,
  so one unbalanced `*` in a topic would italicise every channel listed after it.
  Topics are markdown-escaped and collapsed to a single line. Host-written copy
  (section names, descriptions) is deliberately left as markdown.
- **The reply is budgeted while it's built**, not checked at the end: Components
  V2 caps a message at 4000 characters of text and rejects an over-budget message
  *entirely*, so lines are admitted through a budget that reserves room for the
  footnote admitting the list was cut short.
- **A directory keeps no per-member state.** Unlike a poll's ballots or a
  giveaway's entries, there is nothing to lose — which is why a replacement
  instance (the protocol-v2 cache-miss path) costs the host nothing but a
  re-save.
- **In-message output is button-only.** A menu's section pick is per-person while
  the message body is shared, so one pick would re-stamp what everyone else sees.
  It would also break: the template is captured before DWEEB wires the menu's
  options onto it, so a refresh would re-send an option-less select and Discord
  would reject it.
- **In-message output answers an immediate UPDATE (type 7), never a reply.** It
  must never become a deferred *reply* (type 5): after one, `@original` names the
  reply, so the list would land in an invisible ephemeral instead of the message
  it belongs to.
- **Re-rendering always starts from the stored raw template**, never from the live
  message. Reading back an already-substituted message would leave nothing to
  substitute, freezing the list at its first value on the second click. The host
  bakes every *foreign* token before handing the template over, so re-rendering
  can't decay someone else's `{server}` into literal text.
- **…but the bindings come from the live message.** The template is captured
  while the author is configuring — before DWEEB binds this button, or any other
  plugin's component beside it — so its `custom_id`s are the editor's
  placeholders. Re-stamping them would unbind every button on the message at the
  first refresh. `restamp_components` copies each live node's `custom_id`, a
  menu's options/bounds and a link's `url` onto the rendered template, position by
  position. That's only safe while the two trees have the same shape, so when they
  don't (the author changed the message after configuring), or the result wouldn't
  carry the clicked component, the click gets a private reply instead and the
  message is untouched. Saving the configuration again captures the new layout.
- **A list limited to certain roles only opens with its edit token.** The instance
  id is public — it's in the posted button's `custom_id` — so
  `GET /api/instances/:id` answers 403 (`locked: true`) for a role-gated list
  unless the request carries `X-DWEEB-Plugin-Edit-Token`. An open list holds
  nothing a click wouldn't show, so it reads freely.
- **A `{directory}`-less in-message setup is refused at save.** It would otherwise
  post a button that re-renders correctly and therefore appears to do nothing at
  all, with no error anywhere — the worst possible failure mode.
- Tokens are namespaced (`directory*`) rather than a bare `{roles}`, which Self
  Role already declares. The host resolves a collision first-wins in binding
  order, so two plugins on one message would silently fight over it.
- `5xx` is the paging channel. An admin opening the config panel for a server the
  bot was never invited to gets **404**, not 502 — see
  `ConnectError::status()` and the `only_our_own_faults_are_server_errors` test.

## Endpoints

| Path              | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `GET /health`     | Liveness (Gatus watches this).                                   |
| `GET /registry.json` | The plugin manifest DWEEB reads.                              |
| `GET /config.html`   | The configuration iframe DWEEB embeds.                        |
| `GET /api/meta`      | Capabilities the config UI adapts to.                         |
| `POST /api/connect`  | Read a guild's roles/channels + identify the bot.              |
| `POST /api/instances`         | Create a directory; returns the edit credential once. |
| `GET|PUT /api/instances/:id`  | Read / replace one (PUT, and GET of a role-gated list, need the credential). |
| `POST /interactions`          | Discord interactions (signature-verified).           |

## Configuration

See [`.env.example`](./.env.example) — every variable is documented there,
including the resource bounds above. A *present but unparseable* numeric value is
a hard boot error, never a silent fall back to the default.

## Development

```sh
cp .env.example .env      # fill in DISCORD_PUBLIC_KEY and BOT_TOKEN
cargo run
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
```

The interesting logic is pure and unit-tested without a network: `render.rs`
(formatting, the text budget, hidden-channel filtering), `discord.rs` (the access
gate, re-stamping with live bindings, reply envelopes), `validate.rs`, and the
visibility rules and cache bounds in `rest.rs`.
