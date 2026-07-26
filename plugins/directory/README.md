# DWEEB Directory plugin

Attach it to a **button** or an options **menu**, and a click answers with a live
list of the server.

Two modes:

- **Roles & staff** — a roster. The roles you pick (or every role the server
  displays separately, or every role with moderation powers), arranged into named
  sections like _Owners_ / _Moderators_, each with a permission badge line
  (`Admin`, `Bans · Timeouts`), your own one-line description, and — where
  Discord allows it — the people who hold it.
- **Channels** — an index. Every channel (or a category, or a hand-picked
  shortlist) grouped under its category heading, each captioned with its own
  topic.

Everything is read **at click time**, so a renamed role or a rewritten channel
topic is current without anyone re-editing the message. The reply is private by
default; a directory can be made public instead.

## What it needs

**Only the shared DWEEB bot, invited to the server.** No permission bit:
`GET /guilds/{id}/roles` and `/channels` work for any bot that is a member, and
this plugin **never writes** anything to a server.

### The one optional Discord setting

"Show who holds each role" reads `GET /guilds/{id}/members`, which Discord gates
behind the privileged **Server Members Intent** (Developer Portal → Bot →
Privileged Gateway Intents). Roles and channels do not need it.

With the intent **off**, a roster still renders in full — roles, colours,
permission badges, your descriptions — and adds one line saying member lists
aren't available. The config panel probes this and tells the host before they
turn the option on, and the feature lights up by itself once the intent is
enabled. Member expansion is an enhancement here, never a requirement.

## Design notes worth knowing before changing it

- **Mentions, not names.** A role renders as `<@&id>` and a member as `<@id>`, so
  Discord paints its own colour pill, the entry is clickable, and a rename can't
  stale the message. Every reply therefore sets `allowed_mentions: {parse: []}` —
  **load-bearing**, not politeness: without it a *public* staff list would ping
  every person and role it names on every single click.
- **Only a member-expanding roster defers.** A structure read is three concurrent
  requests and answers inline; a member scan pages at 1000 at a time, so it
  answers "thinking…" and edits the real reply in. Deferring the cheap path would
  add a visible flicker for nothing.
- **The member scan is bounded three ways** and each bound matters: a page cap
  (`MEMBER_SCAN_MAX_PAGES`, the hard ceiling on what one click can cost), an index
  that keeps only the roles actually on show (so a cached scan is kilobytes, not
  megabytes, whatever the guild's size), and one permit pool
  (`MEMBER_SCAN_CONCURRENCY`) that doubles as single-flight — a burst of clicks on
  one directory performs *one* scan. A truncated scan labels its counts as a
  minimum rather than implying a complete roster.
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
| `POST /api/connect`  | Read a guild's roles/channels; reports `members_available`.    |
| `POST /api/instances`         | Create a directory; returns the edit credential once. |
| `GET|PUT /api/instances/:id`  | Read / replace one (PUT needs the credential).        |
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
(formatting + the text budget), `discord.rs` (the access gate, the defer
decision, reply envelopes), `validate.rs`, and the cache bounds in `rest.rs`.
