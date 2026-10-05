# Poll — a DWEEB plugin

Attach this to an **interactive button or select menu** in DWEEB and you've got
a live poll. Members vote (one ballot each, changeable or locked), the **live
tallies restamp on the message itself** — bars, percentages, counts — and a host
closes it with a public results announcement. Optional extras: multi-pick
ballots, hidden-until-close results, role gates, an account-age floor, a
deadline, and a custom close announcement.

Classic uses: community decisions, event RSVPs, feedback forms with secret
results, yes/no votes, "what should we play next" menus.

```
DWEEB   ──reads──▶  GET /registry.json
DWEEB   ──embeds─▶  GET /config.html  ◀─connect/save─▶  /api/connect, /api/instances  ──▶  SQLite
Discord ─vote───▶  POST /interactions  ──▶  gate + ballot  ──▶  UPDATE_MESSAGE (live tallies)
Discord ─close──▶  POST /interactions  ──▶  final results  ──▶  public announcement
```

## The interesting design problem: results settle *later*

A **vote** is pure request/response — a member picks, the tallies update, done.
But **closing** a poll (and revealing a hidden poll's results) happens *later*,
and none of the bundled plugins initiate outbound messages on a schedule. Same
tension the Giveaway plugin faced, same resolution:

| Approach | Verdict |
|---|---|
| **A scheduler** that closes at the deadline | ✗ It breaks the model every other DWEEB plugin follows (no background posters), adds a "missed the deadline while the box was down" failure mode, and needs durable scheduling + exactly-once posting. |
| **A mod-only Close**, staying in request/response | ✓ Chosen. A host closes with a button (reachable by clicking the bound component as a Manage-Server holder), so the *entire* lifecycle is plain interaction handling. |

The optional **deadline** still has teeth without a scheduler: it's enforced
*lazily at click time* — the first interaction past it closes the poll,
disables the component, and settles the final results into the message — and
it renders as a live `<t:…:R>` countdown via the `{closes}` placeholder.

## Why there's (almost) no bot token

The poll message is posted through a **webhook**, and a bot **cannot edit a
webhook-authored message**. It's kept current with **no bot token** by replying
to a click *on it* with an `UPDATE_MESSAGE`:

- a **select** poll's pick refreshes the tallies right in its reply (the
  ephemeral vote confirmation rides a followup via the interaction's own
  webhook token);
- a **button** poll's click refreshes the message in the reply and delivers the
  ephemeral voting panel as a followup.

Actions on the ephemeral panels (a pick, a retract, a close/reopen) can't reach
the public message in their reply, so each answered public-message click caches
its interaction token — whose `@original` *is* the message — and the panel
actions reuse it to edit the message out of band. A restart or an expired token
just means the message waits for the next click on it.

The shared `BOT_TOKEN` is therefore **optional**: it powers only the config
UI's role picker (vote gates + host roles). Everything else runs token-free.

## Ballots

- **One ballot per member**, enforced structurally (a PRIMARY KEY), anonymous
  by design — the poll never shows who voted for what.
- Ballots can be **changed or retracted** while open (or locked, per config).
- **Multi-pick** ballots count each pick per option; the ballot total counts
  people, not picks.
- Tallies live in a per-option `counts` table maintained in the same
  transaction as every ballot change, so rendering results reads O(options)
  rows — never the ballot ledger — and a rapid double-click can't
  double-count.
- Every submitted ballot is validated against the stored option keys: a select
  `values` array is client-forgeable, so unknown keys are refused, never
  counted.

## Placeholders

Drop these into the DWEEB message text and the poll paints them at send time
and keeps them live after every vote: `{question}`, `{results}` (bars +
percentages + counts, with a 🏆 on the closed winner), `{votes}`, `{leader}`,
`{status}`, `{closes}`. `hide_results` polls render a lock note while open and
reveal on close.

A re-render stays one Discord accepts, and stays the poll the host configured:

- **A select poll's options come from the config, every time.** The template is
  captured *before* DWEEB writes the options onto the select — one save behind,
  or the editor's factory options on a first save — so every re-render writes
  the poll's own options and pick cap (`min_values`/`max_values`) onto the bound
  select instead of the template's.
- **The bound component is found by its binding, then by position** — the
  component sitting where the live message's bound one sits — never simply the
  first button, which in a `[Rules] [Vote]` row would take over the other
  plugin's button.
- **Pictures must be links.** A browser-only upload (`session://…`) makes Discord
  refuse the whole edit, so saving refuses a placeholder template naming one (or
  any File component), and a template stored before that check falls back to
  restyling the live component. Echoed media is cleaned of Discord's output-only
  fields.
- **The text stays inside the 4000-character budget**: `{results}` grows a line per
  option as votes arrive, so an over-budget render trims its longest text display.

## Host controls

A host's Close posts the public results **and** hands that host the closed panel
(Post results / Reopen) as a private followup — the public component is disabled
from then on. A Close that lands just past the deadline still announces (that
click closed the poll). On a locked-ballot select poll a host's every pick — not
just the first — carries the control row.

## Endpoints

| Route | What |
|---|---|
| `GET /health` | Liveness. |
| `GET /registry.json` | The plugin manifest DWEEB reads. |
| `GET /config.html` | The config iframe (embedded in the binary). |
| `GET /api/meta` | Capabilities: whether the shared bot is configured. |
| `POST /api/connect` | List a guild's roles for the pickers (bot, optional). |
| `POST /api/instances` | Create a poll → `{ id, managementToken }` (token returned once). |
| `GET /api/instances/:id` | Read a poll + live ballot count for the config UI. |
| `PUT /api/instances/:id` | Reconfigure (requires the `X-DWEEB-Plugin-Edit-Token` header). |
| `POST /interactions` | Discord interactions (signature-verified on the raw body). |

The instance id inside `custom_id` is a **public binding**, never edit
authority (protocol v2): reconfiguration requires the separate 256-bit
management token, of which only the SHA-256 digest is stored.

## Run it

```sh
cp .env.example .env   # fill in DISCORD_PUBLIC_KEY at minimum
cargo run
```

See `.env.example` for every knob. State is one SQLite file (WAL,
`synchronous=NORMAL`, 5s busy timeout); requests are capped at 256 KiB.
