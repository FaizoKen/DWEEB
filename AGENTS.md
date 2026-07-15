# DWEEB — agent context

Shared context for AI coding agents (Codex, Claude Code, Cursor, …). This file is the
**single source of truth** for project conventions. When you learn a durable project fact
or receive standing guidance from the maintainer, record it here (public-safe — this repo
is public) or in `AGENTS.local.md` (gitignored — private/ops). Do not keep such facts only
in a tool-private memory store.

> **If `AGENTS.local.md` exists, read it before starting work.** It holds private
> deployment/ops context that must never be committed.

## What this is

Visual Discord webhook & embed builder for Components V2 messages (Preact SPA), plus a
Rust backend (`server/` = API proxy, `plugins/dispatcher` = interaction dispatcher,
plus 7 interaction-plugin crates) and an embedded Discord Activity (collaborative builder).

## Commands

- `bun run dev` — web FE (Vite). `bun run dev:activity` — Activity mode. `bun run dev:server` — Rust proxy.
- `bun run build` — typecheck + Vite build + SEO template pages (`scripts/gen-template-pages.ts`).
- `bun run test` — Vitest (core logic, stores, and feature contracts). `bun run typecheck`, `bun run format:check`.
- `bun run lint` — ESLint (flat config, `eslint.config.js`). Enforces the React hooks rules
  (`rules-of-hooks` + `exhaustive-deps`) and `no-explicit-any` as **errors**; other recommended
  rules are advisory warnings. Suppress an *intentional* hooks case with a
  `// eslint-disable-next-line react-hooks/exhaustive-deps` **plus a one-line reason** — never a
  bare disable (a linter now actually runs, so bare/dead disables are themselves flagged).
  `format:check` + `lint` are CI gates in `web.yml`; run both before pushing FE changes.
- Rust has no root workspace. In `server/` and each `plugins/<crate>/`, run
  `cargo fmt --all --check` **before every push**, `cargo clippy --all-targets -- -D warnings`,
  and `cargo test --locked`.
- Bun is the canonical package manager (never commit `package-lock.json`).

## Structure

- `src/core` — non-UI application logic (stores, serialization, validation, API clients,
  telemetry). `src/features` — UI features. `src/activity` — Discord Activity entry.
- `server/src` — Rust API proxy: Discord/OAuth auth, plain-SQLite shortlinks, and
  SQLite-backed schedules/message library/Activity drafts whose sensitive payloads are sealed.
- `plugins/*` — 8 Rust crates total: the dispatcher plus ping-pong, tickets, giveaway,
  quick-replies, self-role, modal-form, and picker.

## Conventions & gotchas (hard-won — do not rediscover)

- **Activity API calls**: the Activity iframe uses bearer auth; cookie-only `/api/guilds/*`
  routes silently 401 inside it. Every Activity-reachable feature needs an `/api/activity/*`
  twin or a dual-credential route, and its FE call must go through `proxyFetch`.
- **The Activity's destination server is the launching guild — fixed. Only the channel moves.**
  The collab room is keyed to the server the Activity launched in, and its `target` frame carries a
  channel id and nothing else, so the whole room posts into that one server. A guild launch shows a
  **static server badge** (no dropdown) plus a channel picker whose pick is shared with the room; only
  a **DM/group-DM launch** gets a server picker, since it has no guild of its own to post into.
  Do not add a server switcher to the Activity bar — this was tried (d76adda) and reverted. A post
  aimed at another server can't travel with the room, so the post and the collaboration silently come
  apart, and both workarounds are worse: broadcasting that channel id would move _their_ post (peers
  may not even be members of the server you picked), and a `target` frame widened to carry a guild
  leaves a peer outside it unable to load its channels or resolve their post gate. Posting to another
  server is the web app's job — it's bound to no server, and the bar's "Open on web" hands the draft
  over. Guarded by `core/activity/destination.test.ts`. Because the channel _does_ move, the
  Activity's **Restore** (`RestoreDialog` + `core/activity/restoreTarget.ts`) turns a pasted message
  link into a channel switch instead of a dead end: a link into a _sibling channel of this same
  server_ used to be mistaken for a `thread_id` and handed to Discord, which answered 400 "Unknown
  Channel" — now `planRestore` classifies it and the dialog **confirms switching the room to that
  channel** before reading (only on a hit does the room actually move, keeping the in-place Update
  wired). A link's channel segment that isn't a known channel is still treated as a thread (forum/media
  post); a link into a _different server_ is refused with a pointer to "Open on web". Only the channel
  is ever offered — never the server.
- **Safe-area overlays**: portaled/fixed overlays must use the `--app-sait`/`--app-saib` and
  `--app-sail`/`--app-sair` tokens from `tokens.css`, never raw
  `env(safe-area-inset-*)`; the floor is stamped via `html[data-activity-platform]`.
- **Mobile AI preview clearance**: the floating assistant covers the lower preview, so while it
  is open the preview scroll area must reserve the assistant's shared height + safe-area-aware
  bottom offset. The final rendered message must be scrollable fully above the assistant card.
- **ResizeObserver state must hop a frame.** Resize notifications are delivered mid-frame, after
  layout and before paint: a `setState` _inside_ the callback re-renders and runs layout effects in
  the same delivery cycle, so if that resizes the observed element (the action bars' collapse
  ladder does — it changes the bar's content), the browser gives up and fires a global
  "ResizeObserver loop completed with undelivered notifications" error. Nothing is broken, but it
  lands on `window.onerror` → a crash beacon → a prod alert. Both bars measure via
  `lib/useBarWidth`, which defers to `requestAnimationFrame`; keep new observers on that hook (or
  the same rAF hop) rather than calling `setState` in the callback. Belt and braces: known browser
  non-errors (the RO loop notice) are dropped by the crash reporter (`core/telemetry/crashReport.ts`)
  _and_ by the proxy's `/api/telemetry/crash` (`telemetry.rs`) — the FE ships from a service-worker
  cache, so stale clients keep beaconing long after a fix.
- **`Field` rewrites the caller's element tree — it must never descend into a render prop.**
  `ui/Field`'s `wireControl` walks the tree its render-prop child returns and clones
  `aria-describedby`/`aria-errormessage`/`aria-invalid` onto the element carrying the control id.
  A `children` that is a **function** (`Menu`, a nested `Field`) is not a tree — the subtree only
  exists once that component _calls_ it. Recursing anyway is destructive, not just useless: we run
  **Preact**, whose `Children.map` wraps a lone child into an array, so the clone writes `[fn]` back
  over `children` and the component then invokes an array. This shipped in 0.12.0 and took the whole
  app down to the ErrorBoundary (`TypeError: children is not a function`) the first time anyone
  opened the emoji picker — `EmojiField` renders a `<Menu>` inside its `<Field>`. Note the throw
  surfaces in the _child_, far from the line at fault. Guarded by `src/ui/Field.test.ts`, which runs
  against `preact/compat` (aliased in `vitest.config.ts`) because React's `Children.map` does not
  wrap and would hide the bug.
- **Adding an interaction plugin** touches the crate, compose service/volume + dispatcher
  `ROUTES`, Caddyfile, registry, `server/gatus/config.yaml`, `plugins-ci.yml` matrix,
  `.github/workflows/plugin-<id>.yml`, and `deploy.yml`'s workflow list. A link plugin is
  registry-only (no backend service). Plugin config iframes are forced dark theme.
- Every interaction plugin must verify custom-app signatures through the dispatcher-forwarded
  key attestation; `DISPATCHER_FORWARD_SECRET` must match the dispatcher and every plugin.
- Stateful plugin instance ids in Discord `custom_id` are public bindings, never edit authority.
  Protocol-v2 services return a separate 256-bit management token once, store only its SHA-256
  digest, and require it for updates; a legacy/cache-miss edit must create and rebind a new
  instance. **Current state (audited 2026-07-16):** modal-form and self-role are v2; picker,
  quick-replies, giveaway, and tickets still declare `apiVersion: 1` and use the unguessable
  instance id as the update capability — but a `custom_id` is readable by every member who can
  see the message, so anyone in the guild can rewrite those instances' configs via
  `PUT /api/instances/:id`. Migrating them to v2 needs each plugin's embedded `config.html` +
  backend + both registries updated together, and the plugin services deployed **before** the
  v2 web manifest (see the deploy-ordering rule above). Treat this as the next security debt to
  pay down; don't add new v1 stateful plugins. Saved-webhook approval responses travel over an iframe-created `MessagePort`, not
  `contentWindow`. Deploy compatible plugin services/static pages before the v2 web manifest.
- Plugin-library presets and `init.preset` seeding stay; the duplicate in-config “Quick start”
  bars stay removed.
- **Adding/removing a template**: update `src/data/presets.ts` + `scripts/seo/content.ts`
  (build **throws** if a template has no SEO entry), check `scripts/seo/features.ts` and
  `video/src/data.ts` references, and regenerate committed OG images with
  `bun add -d sharp && bun scripts/gen-template-og.ts && bun remove sharp`.
- **Static discovery is a build contract.** `scripts/gen-template-pages.ts` generates the
  template and feature catalogues, `/guides/*`, `/discord-webhook-builder/`, and the image
  sitemap. Build-critical generator code is covered by `tsconfig.seo.json`; `bun run build` then
  runs `scripts/seo/audit.ts`, which fails on broken sitemap
  targets/internal links, duplicate or missing metadata, invalid JSON-LD, missing/wrong-size
  social cards, stale/future dates, late charset declarations, thin detail pages, and orphaned
  templates. Add new discovery routes to that generator rather than hand-writing unverified
  files in `dist/`; keep source-backed guide claims and `lastmod` dates honest.
- **Search attribution is first-party and privacy-bounded.** Static CTAs use
  `entry=<landing|template|feature|guide>:<public-slug>` (never internal UTM tags), and optional
  `intent=` values may only open a non-mutating app surface. `gtag-init.js` drops hashes,
  Discord/OAuth/billing identifiers, arbitrary queries, and exact short-link ids by sending only
  the controlled canonical plus a referrer's origin; acquisition ids and product-event fields use
  exact allowlists. Keep GA Enhanced Measurement disabled (especially outbound clicks, site search,
  and history pageviews), because those automatic events bypass the repository's field filters.
  Never add message content, webhook URLs/tokens, guild/app/message ids, share payloads, or
  free-form text to analytics.
- **The service worker has a narrow navigation allowlist.** Only `/` and valid `/s/<id>` routes
  may fall back to the SPA shell (`src/core/seo/navigationRoutes.ts`). Every current or future
  discovery/legal route must receive its real static HTML. Registration has a real post-paint
  delay so precaching cannot race the lazy first-visit gallery; the full versioned-chunk precache
  protects old open tabs across deployments.
- Successful Pages deploys submit the deployed sitemap through IndexNow using the public root
  key and `scripts/seo/submit-indexnow.mjs`. The notification is best-effort and must never fail
  or roll back an otherwise healthy deploy.
- **Share-token golden fixtures**: regenerate only via `bun run gen:golden` after a version bump — never hand-edit.
- **Bot permission union** is `805306385`; changing it requires editing
  `src/core/guild/config.ts` + 4 plugin `config.rs` files and per-server bot re-invites.
- Command-set changes must keep `scripts/register-commands.mjs`,
  `server/src/discord.rs::command_set()`, and dispatcher command names/matches aligned.
- Plans (Free/Plus/Pro) are **quota-raising only** — a plan must never lock a feature outright.
  Entitlement is keyed per **guild**, not per user. Guild moves have a 7-day cooldown;
  downgrades keep the oldest resources within cap, suspend overflow, and restore it on upgrade.
- **Stripe stays off the boot path.** Import Stripe.js only via `@stripe/stripe-js/pure`
  (the default entry injects the js.stripe.com script — cookies + fraud beacons — as an
  import side effect; it once rode the vendor chunk and hit every visitor on every page
  view). Cheap availability checks live in `src/core/plan/stripeConfig.ts`, never
  `stripeApi.ts`, and vite.config.ts's manualChunks keeps `@stripe` in its own lazy chunk.
- **Feedback webhook credentials are server-only.** Both web and Activity forms submit the
  closed report schema to the proxy (`/api/feedback` anonymous + strict per-IP limit;
  `/api/activity/feedback` bearer-gated). Only `FEEDBACK_WEBHOOK_URL` may hold the destination;
  never add a `VITE_*` feedback webhook variable or direct browser-to-Discord feedback post.
- **The intro film is opt-in.** First-time visitors get one quiet pointer to
  **More ▸ Watch intro**; never auto-open or autoplay the multi-megabyte film on page load.
  Keep it lazy-mounted and use `preload="metadata"`; an explicit Watch intro action may start
  playback (while respecting reduced-motion) because the user asked for it.
- index.html's JSON-LD `softwareVersion`/`dateModified` and `og:updated_time` are stamped
  at build by `stampBuildMeta` (vite.config.ts) — don't hand-maintain them; the build
  throws if the patterns vanish. Marketing claims there must match the plans model
  (quota-raising only — never claim "no usage limit" or "no paywall").
- Message library: "posted" is a server-only rolling history window (no local fallback);
  drafts have hard per-plan caps.
- Keep the default `webhook.incoming` OAuth path. Custom bots must not collect bot tokens;
  their OAuth create flow uses the popup/localStorage handshake because Discord can sever
  `window.opener`.
- Link-plugin URLs stay freely editable and the binding follows the URL. Keep one uniform
  link-plugin UI; do not reintroduce per-plugin parameter panels.
- **Discovery marketing**: lead with DWEEB's visual Discord message builder for webhooks,
  embeds, and Components V2. Do not use "without the JSON" copy, and do not present the
  collaborative "Build Together" Activity feature as DWEEB's main functionality. Keep
  essential discovery-banner text and branding inside the central vertical safe band because
  Discord's listing preview may center-crop the banner at larger display sizes. Persist the
  source upload assets in `public/activity-assets/`; `dist/activity-assets/` is generated.
- **Web Send dialog shows the destination read-only.** When the action bar's channel chip has
  a pick, the Send tab renders `GuildWebhookPicker variant="summary"` — one row for the picked
  channel, no channel list (changing the channel lives in the bar chip; don't reintroduce an
  in-dialog re-pick). The full list appears only when no bar pick exists yet (it's then the
  first pick), and that decision is frozen per dialog open so an in-dialog pick doesn't yank
  the list away mid-flow.
- **Env config fails loudly, never silently.** `config.rs` trims every value (`normalize`), and a
  _present but unparseable_ value is a boot error rather than a fall back to the default —
  `parse_bool` accepts only `1/true/yes/on` + `0/false/no/off` and rejects anything else. This is
  load-bearing, not pedantry: an untrimmed `REQUIRE_MANAGE_GUILD=true ` used to parse as **false**
  and silently switch off the gate restricting users to servers they manage (same shape drops
  `Secure` off the session cookie via `COOKIE_SECURE`). Don't reintroduce a "default on anything
  unrecognized" parser.
- **Durable stores must have absolute paths.** Every `*_DB_PATH` (shortlink, schedule, library,
  activity-draft, stripe) defaults to a bare filename, which resolves against the container's
  working directory — _not_ the mounted volume — so the data is destroyed on the next deploy with
  no error. compose passes `${X:-/data/x.db}`; the server now also checks itself and logs a loud
  boot WARN naming each enabled store on a relative path. `STRICT_DB_PATHS=true` promotes that to a
  hard boot failure (set it in prod once every path is absolute). Add any new durable store to
  `DurableStores` in `config.rs`.
- **Proxy health vs readiness.** `/health` is bare liveness (static 200, no deps). `/ready`
  probes every _present_ SQLite store (shortlinks, schedules, activity drafts, library, Stripe
  mirror) with a nonblocking pool checkout + `SELECT 1` under a two-second per-store deadline,
  so a busy/stuck store returns `503 {"failed":[…]}` even while `/health` still 200s. This proves
  responsiveness, not filesystem writability. Each store exposes an inherent `ping()`; add one
  for any new store and probe it in `routes::ready`. Gatus watches `/ready`
  (`server/gatus/config.yaml`, asserts `[BODY].status == ready`).
- **Global request timeout has exemptions.** `main` wraps the normal routes in a `TimeoutLayer`
  (`REQUEST_TIMEOUT`, 60s) as a backstop for wedged handlers. The room WebSocket and the two
  32 MiB upload routes (`/api/activity/post`, `/api/activity/edit`) are merged _after_ the layer
  via `untimed_routes()` and must stay there — a persistent socket / slow large upload must not
  be cut off. Any new long-lived or large-upload route belongs in `untimed_routes()`, not the
  main chain.
- **SQLite stores share a small connection pool** (`sqlite_pool.rs`): each store holds a
  `SqlitePool` (round-robin `Vec<Mutex<Connection>>`) instead of a single `Mutex<Connection>`, so
  WAL's concurrent reads are no longer serialized behind one lock. Pragmas (WAL +
  `synchronous=NORMAL` + 5s `busy_timeout`) run per connection in the pool's `init` closure;
  schema/migrations/count are one-time and run once on a checked-out connection (then dropped
  before `pool` moves into the struct — a size-1 pool would otherwise self-deadlock). A store
  method still checks out **one** connection for its whole operation (`self.lock()` →
  `pool.get()`), preserving transaction semantics. Use `prepare_cached` (not `prepare`) for
  repeated queries (per-connection statement cache). Size = `SQLITE_POOL_SIZE` env (default 3,
  floor 1); **set it to `1` to reproduce the old single-connection behaviour** on a
  memory-constrained host (each connection carries its own page + statement cache).

## CI

- `web.yml` — FE build + Vitest + GitHub Pages deploy. `server.yml` — Rust fmt/clippy/test. `plugins-ci.yml` — fmt/clippy/test matrix over all 8 crates. `deploy.yml` — backend CD.
- Pushing `main` triggers deployments; never push unless the maintainer explicitly asks.
