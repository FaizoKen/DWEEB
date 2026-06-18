# Giveaway — a DWEEB plugin

Attach this to an **interactive button** in DWEEB and you've got a giveaway.
Members click **Enter**, the **live entrant count** ticks up right on the button,
and when you're ready a moderator **draws N winners at random** — fairly, with a
public announcement that pings the winners. Reroll for a fresh pick, or cancel.

Classic uses: Nitro drops, key giveaways, "react to win" boards (the modern
button version), event raffles, milestone celebrations.

```
DWEEB   ──reads──▶  GET /registry.json
DWEEB   ──embeds─▶  GET /config.html  ◀─connect/save─▶  /api/connect, /api/instances  ──▶  SQLite
Discord ─Enter──▶  POST /interactions  ──▶  eligibility check  ──▶  UPDATE_MESSAGE (live count)
Discord ─Draw───▶  POST /interactions  ──▶  pick winners (pure)  ──▶  public announcement (+ optional DM)
```

## The interesting design problem: winners are announced *later*

An **Enter** click is pure request/response — a member clicks, the count
updates, done. But **ending** a giveaway and announcing winners happens *later*,
and none of the bundled plugins initiate outbound messages on a schedule. There
were two ways to bridge that gap:

| Approach | Verdict |
|---|---|
| **A scheduler** that posts winners at a deadline | ✗ It breaks the model every other DWEEB plugin follows (no background posters), adds a "missed the deadline while the box was down" failure mode, needs durable scheduling and exactly-once posting, and announces to an empty room — no human is there to hype it. |
| **A mod-only Draw**, staying in request/response | ✓ Chosen. A host draws with a button (reachable by clicking the Enter button as a Manage-Server holder), so the *entire* lifecycle is plain interaction handling — no timers, no outbound poster, and the draw happens exactly when a human runs it. |

The optional **deadline** still has teeth without a scheduler: it's enforced
*lazily at click time* (entries close once it passes) and rendered as a live
`<t:…:R>` countdown. You draw whenever you like; the deadline just stops new
entries.

### Why there's (almost) no bot token

The giveaway message is posted through a **webhook**, and a bot **cannot edit a
webhook-authored message**. It's kept current two ways, both **token-free**: an
`UPDATE_MESSAGE` response to a click *on it* (how a member's Enter click restamps
the count), and — when a *host* clicks Enter, which replies with the control
panel rather than editing the message — an out-of-band edit of the interaction's
`@original` (the clicked message) via the interaction's own webhook token, so a
host-only giveaway still keeps its count / winners / status live. The winner
announcement is the public (non-ephemeral) interaction response to the Draw
click; again, no token. So the whole core — enter, live count, requirements,
draw, reroll, cancel, announce — runs entirely off interaction responses.

The shared bot (`BOT_TOKEN`) is therefore **optional**, used for just two extras:

- listing a guild's roles in the config UI's **requirement / host-role picker**, and
- **DMing the winners** when a giveaway opts in.

Leave it unset and those two degrade gracefully (the UI says so); everything else
works. State is a single SQLite file.

## Placeholders in your message

Write your giveaway however you like in DWEEB, and drop these tokens into the
message text — they fill in and stay live:

| Token | Becomes |
|---|---|
| `{prize}` | The prize. |
| `{entries}` | The live entrant count (updates on every entry). |
| `{winners}` | `TBD` until you draw, then the winner mentions. |
| `{winner_count}` | How many winners are drawn. |
| `{host}` | The host, as a mention (when set). |
| `{status}` | `open` / `ended` / `cancelled`. |

DWEEB's built-in server/channel tokens (`{server}`, `{channel}`, …) work here too
and survive the live refresh — DWEEB bakes their value into the template, so they
stay filled in alongside `{winners}` rather than reverting to raw text.

DWEEB paints the first values when the message is posted (so it never shows raw
`{tokens}`). After that, the same mechanism that keeps the entrant count current
re-renders the whole message — so `{entries}` ticks up as people enter, and
**`{winners}` / `{status}` fill in after you draw** (the public announcement
still pings the winners instantly). A member's Enter click refreshes it in the
reply; a host's Enter click refreshes it out of band (the host gets the control
panel), so even a giveaway only the host ever touches catches up each time the
panel is opened. The refresh is click-driven rather than a background timer —
effectively immediate in an active giveaway.

Internally the plugin captures your message (with its raw tokens) as a *template*
when you save, and re-renders it from that template on each click — see
`substitute` / `render_bound_message` in [`src/discord.rs`](src/discord.rs). Use no
placeholders and nothing changes: the live count just restamps the button as
before. The same tokens also work in the **custom announcement**.

## How a click becomes an entry

The decision is a pure function of the **interaction payload** alone — no Discord
call:

1. **Status** — ended/cancelled giveaways are closed.
2. **Deadline** — past it, entries are closed (you can still draw).
3. **Role requirement** — the member's roles (from the payload) must include the
   required role(s): *any one of* by default, or *all of* if you choose.
4. **Account age** — derived from the member's user-id snowflake; blocks fresh
   alts without any lookup.
5. **One entry per person** — structural: the entry ledger's primary key is
   `(giveaway, member)`, so a double-click is a no-op, not a double entry.

A member who passes is entered (or, on a second click, shown a private "you're
already in" with a **Leave** button). The count is restamped onto the Enter
button — `🎉 Enter (1,234)` — via `UPDATE_MESSAGE`, preserving the rest of *your*
message design verbatim.

## Drawing, rerolling, cancelling

Anyone with **Manage Server** / **Administrator** (or a role you add as a *host
role*) who clicks the Enter button gets an ephemeral **host control panel**
instead of entering:

| Control | What it does |
|---|---|
| **🎉 Draw winners** | Picks `winner_count` winners uniformly at random from the entrants and posts the public announcement (pinging them). Marks the giveaway ended. |
| **🔁 Reroll** | After a draw, picks a fresh set **excluding everyone already drawn**, and announces again. |
| **Cancel giveaway** | Calls it off with a public notice — no winners. |
| **Enter / Leave as participant** | A host can also enter the draw (or back out). |

The draw is the **pure core** (`choose_winners`, a partial Fisher-Yates with the
randomness injected) — exhaustively unit-tested for fairness (equal odds, no
entrant twice, exact count) while the OS CSPRNG supplies unbiased indices at
runtime (rejection sampling, no modulo skew).

After a draw, the first member to click the (now stale) Enter button lazily flips
the public message to its **ended** state — the button disables and relabels —
since that click is the one chance to edit the webhook message.

## Architecture & safety

| Concern | How it's handled |
|---|---|
| Interaction authenticity | Ed25519 signature verified on the **raw** body before parsing ([`discord.rs`](src/discord.rs)). Bad/missing signature → `401`. Custom-app signatures verified with the dispatcher-attested key (constant-time secret check). |
| Who can reconfigure | The instance id is 128 bits of CSPRNG entropy, carried inside the Discord `custom_id` (invisible to normal users). Knowing it is the capability. |
| Who can draw | Re-checked from the interaction's computed permissions **on every host action** — never trust that only a host can reach a `draw`/`cancel` custom_id. |
| Fairness | Uniform random selection from the live entrant set; the index source is the OS CSPRNG with rejection sampling (no modulo bias). |
| Privilege / spoofing | Role requirements intersect the member's payload roles with the configured set; a crafted client can't smuggle eligibility. One entry per person is a DB primary key, not a client promise. |
| Mention safety | Announcements set `allowed_mentions` to ping **only the winners** — never `@everyone`, even from a custom prize/announcement string. |
| Reply within Discord's 3s window | Every member step is a single in-process response; winner DMs are spawned best-effort **off** the reply path with a sub-3s client timeout. |
| Resource bounds | Prize ≤ 256 chars, 1–20 winners, ≤ 25 requirement/host roles, account-age floor ≤ 5 years, description/announcement clamped. |
| XSS in the config UI | Every Discord-supplied string (role names) is rendered with `textContent`; the one `innerHTML` path is `escapeHtml`-guarded. |

## The bot (optional)

Giveaway works with **no bot at all**. If the deployment configures the shared
DWEEB bot (`BOT_TOKEN`), the config UI gains the role picker for entry
requirements and the "DM the winners" toggle lights up. A server admin only ever
*invites* the bot — never pastes a token — and the invite's `permissions` are
normalized to the same shared union the other plugins use (Giveaway itself needs
no privileged bit, but the union must match so re-inviting can't strip another
plugin's grant). `BOT_INVITE_URL` surfaces a one-click "add the bot" button.

> **Operators:** if `BOT_TOKEN` is set it grants full bot access — treat the
> database as a secret store and only run plugins you trust, the same reason the
> DWEEB registry is bundled and curated. If it's unset, the config UI says role
> requirements aren't available and winners aren't DMed; nothing else changes.

## Run locally

```bash
cd plugins/giveaway
cp .env.example .env          # set DISCORD_PUBLIC_KEY (your app's public key)
cargo run                      # listens on http://localhost:8094
```

DWEEB's plugin list is bundled, so this plugin's manifest ships in
`src/core/plugins/registry.json` pointing at `http://localhost:8094/config.html`
in dev. Restart `pnpm dev`, drop a button into a message, and attach **Giveaway**
from the plugin picker. To receive real interactions, expose `/interactions`
publicly (the production path is the dispatcher).

## Deploy (cheapest path)

```bash
docker build -t dweeb-giveaway plugins/giveaway
docker run -p 8094:8094 \
  -e DISCORD_PUBLIC_KEY=… \
  -e PUBLIC_BASE_URL=https://giveaway.example.com \
  -v giveaway-data:/data \
  dweeb-giveaway
```

The image is a single binary on `debian-slim` (just CA certs); SQLite is
bundled. It runs comfortably on the free/cheapest tier of Fly.io, Railway,
Render, or a $5 VPS. Give it a small persistent volume for the `.db` file. On the
DWEEB production stack it's wired exactly like the other plugins — see
[`docs/plugins.md` §5](../../docs/plugins.md).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. |
| GET | `/registry.json` | DWEEB plugin registry (one plugin). CORS-open. |
| GET | `/config.html` | The config iframe DWEEB embeds. |
| GET | `/api/meta` | Whether a shared bot exists (role picker + DMs) + its invite URL. |
| POST | `/api/connect` | Probe a guild with the shared bot → its roles for the picker. Stores nothing. |
| POST | `/api/instances` | Create a giveaway → `{ id }`. |
| GET | `/api/instances/:id` | Read a giveaway (config + status + entry count). |
| PUT | `/api/instances/:id` | Reconfigure (entries/status preserved). |
| POST | `/interactions` | Discord interactions (signature-verified). |

## Files

| File | Role |
|---|---|
| [`src/main.rs`](src/main.rs) | Wiring: env, router, listen. |
| [`src/config.rs`](src/config.rs) | Env parsing (incl. the optional shared bot + invite normalization). |
| [`src/store.rs`](src/store.rs) | SQLite store: giveaway configs + the per-user entry ledger. |
| [`src/discord.rs`](src/discord.rs) | Signature verify, interaction parsing, and the **pure** core: eligibility, the draw, the live-count button restyle, announcements. |
| [`src/rest.rs`](src/rest.rs) | The thin (optional) Discord REST: list roles for the picker, DM winners. |
| [`src/validate.rs`](src/validate.rs) | Input validation for everything the browser sends. |
| [`src/routes.rs`](src/routes.rs) | HTTP handlers + the giveaway lifecycle (enter / draw / reroll / cancel). |
| [`static/config.html`](static/config.html) | The config iframe (prize → requirements → deadline → draw options). |
