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
plus 9 interaction-plugin crates) and an embedded Discord Activity (collaborative builder).

## Commands

- `bun run dev` — web FE (Vite). `bun run dev:activity` — Activity mode. `bun run dev:server` — Rust proxy.
- `bun run build` — typecheck + Vite build + SEO template pages (`scripts/gen-template-pages.ts`).
- `bun run test` — Vitest (core logic, stores, and feature contracts). `bun run typecheck`, `bun run format:check`.
- `bun run lint` — ESLint (flat config, `eslint.config.js`). Enforces the React hooks rules
  (`rules-of-hooks` + `exhaustive-deps`) and `no-explicit-any` as **errors**; other recommended
  rules are advisory warnings. Suppress an _intentional_ hooks case with a
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
- `plugins/*` — 10 Rust crates total: the dispatcher plus ping-pong, tickets, giveaway,
  quick-replies, self-role, modal-form, picker, poll, and directory.

## Conventions & gotchas (hard-won — do not rediscover)

- **Activity API calls**: the Activity iframe uses bearer auth; cookie-only `/api/guilds/*`
  routes silently 401 inside it. Every Activity-reachable feature needs an `/api/activity/*`
  twin or a dual-credential route, and its FE call must go through `proxyFetch`.
- **"Open in Discord" deep links race the app against a web fallback — the grace period is
  load-bearing** (`lib/discordDeepLink.ts`, fixed 2026-07-19). Desktop launches `discord://`
  and opens the web link only if the page stays focused through the whole grace window; a blur
  or hidden at any point means the app took over. The original 800 ms deadline shipped the
  "opens both" bug: on Windows with the browser set to always-allow, a (cold-starting) app
  regularly needs >800 ms to steal focus, so the web tab opened *and* the app arrived. The
  window is now 2500 ms on Chromium/Firefox (their transient activation lasts 5 s, so the
  delayed `window.open` stays popup-legal) but must stay ≤1000 ms on WebKit — Safari forwards
  a click's user activation through `setTimeout` only for delays ≤1 s, and a blocked popup
  degrades to navigating the builder tab away. Repeat clicks supersede the pending race
  (module-level cancel) rather than stacking fallback tabs. Don't shorten the Chromium window
  back for snappiness and don't lengthen the WebKit one; guarded by
  `src/lib/discordDeepLink.test.ts`.
- **Activity memory is deliberately load-shed, not queued without limit.** The post/edit routes
  allow 32 MiB only for multipart uploads; plain JSON is capped at 128 KiB. Multipart buffering
  consumes one permit from `ACTIVITY_UPLOAD_CONCURRENCY` (default 2) and returns a retryable 503
  when full. The room WebSocket sets both its frame and assembled-message decoder limits to the
  256 KiB relay limit, and persisted snapshots go through one 250 ms coalescing writer: only the latest plaintext per room is kept,
  at most 64 rooms may be pending, sealing runs off Tokio, and ready rooms commit in one SQLite
  transaction. Do not move sealing/WAL writes back into each socket task or replace these bounds
  with an unbounded wait queue.
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
- **Preview fidelity is measured, not styled.** The `--discord-*` tokens in `tokens.css` and the
  preview renderer CSS mirror values **measured off the live Discord web client** (dark theme,
  2026 visual refresh: chat surface `#1a1a1e`, containers `#242429` + `rgba(148,148,156,.12)`
  border, translucent blurple code fills, link `#4d96ee`, buttons 32px/8px-radius with translucent
  secondary). Don't "improve" them by eye — re-measure. **Measure the right surface**: messages
  render on `chatContent` (`--background-base-lower`, #1a1a1e); the near-black `#121214`
  (`--background-base-lowest`) is only the app frame *behind* the chat panel — the 2026-07-17
  audit briefly recorded #121214 as the chat bg and the canvas read far too dark. **One
  sanctioned deviation** (maintainer, 2026-07-17, settled after trying #121214 and #1a1a1e the
  same day — both read too dark beside the editor): every preview *canvas* (the surface the
  message renders on — preview pane, mini preview, gallery/add-menu thumbnails, Activity
  skeleton) uses `--app-preview-bg` (#313338, classic Discord dark's chat bg);
  `--discord-bg-primary` stays the measured #1a1a1e. Everything *inside* the message keeps the
  measured tokens **except** `--discord-bg-secondary` (containers, file cards) = **#2b2d31**,
  which is **paired to the canvas, not to `--discord-bg-primary`** (maintainer, 2026-07-17):
  since the canvas is *classic* dark's chat bg, the container is *classic* dark's own container
  bg — still a Discord-native pair, just from the theme the canvas came from. **Keep both halves
  of the pair in one theme.** The refresh's measured #242429 is correct only on the refresh's
  #1a1a1e chat surface; on #313338 it reads as a **dark hole** (1.222:1, and inverted — the
  refresh container is *lighter* than its chat surface, classic's is *darker*). Rebasing the
  refresh's lighter-than-chat lift onto the canvas instead was also tried and rejected the same
  day as **too light** (#393b40, ratio-matched to 1.128:1). Re-measuring this back to #242429 is
  the bug, not the fix; if the canvas deviation is ever dropped, drop this one with it. Don't
  re-point the canvases back during a fidelity audit. Workflow (2026-07-17 audit): drive the
  editor via `import("/src/core/state/messageStore.ts")` + `attachEditorFields` on a Vite dev tab,
  post the same JSON to a test webhook with `?with_components=true`, then read Discord's rendered
  DOM/`getComputedStyle` (convert its `oklab()` colors via a canvas) rather than eyeballing
  screenshots. Discord-verified markdown quirks live in
  `src/features/preview/markdown/parse.test.ts` — `*` needs a non-space after the opener while
  `_` needs word boundaries, ` `` ` spans, autolinks drop trailing `.,:;"')]`, consecutive
  ordered items merge into a preceding bullet list, inline styles cross newlines, CV2 text
  displays never render jumbo emoji (unicode emoji are 1.375em, wrapped by the renderer).
  Measured gallery mosaic rules (identical top-level and inside containers, which just narrow
  the column to 566px): 1-up = natural aspect capped 600w/350h; 2-up = two columns at a
  **fixed 280px height** (source aspect ignored); 3-up = 2fr/1fr hero at 12:7 overall; 4-up =
  2×2 cells that **adopt the source image's aspect ratio** (stamped per item on image load,
  3:2 fallback); 5-up = a 2-up-style 280px pair over three squares; 6/9-up = all squares;
  7/10-up = a full-width hero at the **source aspect** (no height cap) over rows of squares. A
  spoilered container blurs the whole card (blur(44px), accent stripe hidden) under the
  SPOILER pill. Failure modes (also measured): an unloadable image keeps its cell geometry and
  shows a centered 32px broken-image glyph on rgba(0,0,0,.04) — 350×350 when it's a lone image,
  85×85 for thumbnails; an unresolvable custom emoji renders as plain `:name:` text (the
  preview swaps on CDN 404); long button labels grow the button (rows wrap), long select
  placeholders ellipsize. Known
  accepted gaps: no code-block syntax highlighting, native emoji glyphs instead of Twemoji
  artwork (Activity CSP blocks third-party CDNs), `gg sans` falls back to Noto Sans.
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
- **A crash beacon must be *our* crash before it may page** (2026-07-24). `window.onerror` hears
  every uncaught error in the page context, including code we never shipped — extension scripts
  injected into the page, userscripts, bookmarklets, console experiments. One paged the maintainer:
  a Safari user's foreign script overflowed its own stack ("Maximum call stack size exceeded.",
  frames `@`/`Pk@`/`Nk@` with **no source URL** — JSC's rendering of code that has no script URL);
  rebuilding every deployed 1.0.0 bundle proved no DWEEB build contained those symbols (prod-vs-local
  identifier histograms match, so local rebuilds are name-faithful — a reusable diagnosis trick).
  Policy (`isForeignCodeError` in crashReport.ts, mirrored as `is_foreign_code_error` in
  telemetry.rs, which is the authority since SW-stale clients keep the old reporter for weeks):
  a `kind=error` beacon whose stack has frames but no `://` anywhere (nothing we serve produces
  URL-less frames), or the muted cross-origin `Script error.` + empty stack, is foreign — the client
  doesn't send it and the proxy logs it at **info** (`web app foreign-code error`, still greppable
  under `web_crash`). Deliberately narrow: `boundary`/`unhandledrejection` keep paging even with
  foreign-looking stacks (the 6-frame cut can hide our deeper frames), an empty stack with an
  ordinary message keeps paging (our code can `throw "string"`), and extension frames that carry a
  URL keep paging. `clamp_field` now replaces control chars with spaces so a multi-line stack stays
  legible in the one-line log (`@ @ @ Pk@` instead of the fused `@@@Pk@` that made this incident
  cryptic) without weakening the log-injection guarantee.
- **Preact must survive a DOM something else rewrote — an in-page translator is the
  known rewriter** (2026-07-29). Preact places a node with
  `parentDom.insertBefore(newNode, oldDom)`, where `oldDom` is the sibling it remembers;
  `diff/children.js`'s `insert` guards only a *detached* reference (`!oldDom.parentNode`),
  **not a re-parented one**. Chrome's built-in translation (same machinery as the Google
  Translate widget) rewrites each text node into `<font><font>…</font></font>` and **moves
  the original text node inside the wrapper**, so the next render that inserts an element
  beside it — a conditional leading icon next to a bare text child, an emoji span appearing
  mid-paragraph — hands `insertBefore` a reference whose parent is now the `<font>`, and the
  whole app falls to the `ErrorBoundary`. That is the 2026-07-29 `boundary` page
  ("…the node before which the new node is to be inserted is not a child of this node",
  top frames `insert` ← `diffChildren` in `vendor`); it reproduces exactly by wrapping one
  rendered text node that way, and the app *is* the fix's target — the user asked for a
  translated page, not a dead editor. Preact exposes no `options` hook around DOM insertion,
  so `core/dom/domGuard.ts` (installed in `main.tsx` **before the first render**, after the
  crash reporter it reports through) patches the two `Node` methods that throw on a moved
  node. **Both only change behaviour where the native call would otherwise throw**, so no
  working path is affected: `insertBefore` walks up from the stale reference to the ancestor
  that *is* our child and inserts before that — the `<font>` stands exactly where the text
  did, so the intended order survives, where a plain append would put the icon after its
  label — and `removeChild` no-ops on a foreign child (deliberately **not** "remove it from
  wherever it really lives"; that node isn't ours). A non-node argument still gets the
  native `TypeError`: a real bug of ours must stay loud. Measured cost ≈100 ns per
  `insertBefore` (18% of a microbenchmark that does nothing else; nothing next to layout).
  The guard reports **once per page** as kind `dom-desync`, whose message carries the two
  facts that diagnose the next one — the tag the stale reference turned up under and any
  translator markers on the document (`translated-ltr`/`-rtl` = google, `_msttexthash` =
  microsoft). `parent=FONT translator=google` is a browser rewriting the page;
  **`translator=none` under an ordinary tag means the guard is masking a bug of ours and
  wants investigating**. The proxy logs `dom-desync` at **info** (`is_repaired_dom_desync`,
  same `web_crash` target) — nothing broke for the user, so it must never page — which makes
  this **server-first deploy ordering**: the old proxy logs an unknown kind at warn, and
  SW-cached clients keep sending plain `boundary` for the unrepaired crash for weeks.
  Guarded by `src/core/dom/domGuard.test.ts` + the `domDesyncMessage` and
  `*_dom_desync` tests.
- **Deploy skew self-heals — don't page for it.** GitHub Pages caches `index.html` ~10 min
  and every deploy purges the old hashed chunks, so a tab that isn't SW-controlled can hit a
  404 on a lazy `import()` ("Failed to fetch dynamically imported module" — this paged the
  maintainer repeatedly on 0.12.0, first at boot, then post-boot when an open tab's Template
  gallery chunk vanished). Four layers, each with a reason to exist — keep all of them:
  1. **SW precache + `clientsClaim`** (vite.config.ts): the precache protects controlled
     tabs across deploys, and `clientsClaim: true` closes the first-visit hole where the very
     session that installed the worker stayed uncontrolled to its end. Safe with
     `registerType: "prompt"`: an *updated* worker never skips waiting, so it can't activate
     (or claim) under an old tab.
  2. **Boot**: `core/pwa/staleChunkRecovery.ts` (armed first thing in `main.tsx`) listens for
     Vite's `vite:preloadError` and reloads once — guarded per **build** via sessionStorage so
     it can never loop, and only **before** `dweeb:surface-ready` so an automatic reload can't
     destroy a user's in-progress message. Keep new boot-path dynamic imports behind this
     ordering. The guard key is `__BUILD_ID__`, not `__APP_VERSION__`: package.json has read
     `1.0.0` across every deploy since launch, so a version key turned "once per version, per
     tab" into "once per tab, ever" — a long-lived tab that recovered from one deploy's skew
     could never recover from the next and reported it as fatal instead (2026-07-28). Any
     per-build-unique string works; don't key it on the semver again.
  3. **Post-boot**: every lazy surface (all 10 in `App.tsx` + the Activity's FeedbackDialog)
     is wrapped in `ui/ChunkErrorBoundary`, which turns exactly the stale-chunk failure into a
     "refresh to update" Modal while the app keeps running (draft autosave + preserved URL
     make the refresh lossless) and rethrows anything else to the top boundary. Wrap any NEW
     lazy surface the same way; its `onDismiss` must fully unmount the surface (open flag
     *and* any `*Mounted` latch) or the cached rejection rethrows forever. Never auto-reload
     post-boot. The top `ErrorBoundary` also has a stale-chunk branch (accurate copy,
     hash-preserving reload) for anything that still gets through.
  4. **Reporting** (`resolveCrashKind` in crashReport.ts + `telemetry.rs`): dropped while the
     boot reload is in flight; a boundary-handled failure reports as kind `stale-chunk`; an
     unhandled one is escalated to `stale-chunk-fatal`. The proxy logs any stale-chunk message
     that isn't `stale-chunk-fatal` at **info** (same `web_crash` target, still greppable) so
     routine skew — including the long tail of pre-fix SW-cached clients — never pages;
     `stale-chunk-fatal` stays a warn and pages, because a current client actually going down
     means a broken deploy or SW precache gap. Don't "simplify" any of this into an
     unconditional drop, and deploy the server change before (or with) the web one — the old
     proxy logs every stale-chunk beacon at warn.
     **A chunk-load message is a symptom, not a diagnosis — the fatal shape must be verified**
     (2026-07-28). Every engine's wording ("Failed to fetch dynamically imported module",
     Vite's "Unable to preload CSS for …") is emitted for *any* failed fetch, so a visitor whose
     connection dropped mid-boot is byte-identical to deploy skew. That paged the maintainer:
     four `stale-chunk-fatal` beacons naming `acquisition-*.js` and `useBarWidth-*.css`, both
     of which were being served, from the same build the live `index.html` pointed at — nothing
     was stale, the fetches had simply lost, and boot recovery's one reload lost the same way,
     which the escalation rule reads as "recovery exhausted on a broken deploy". So before the
     page-worthy shape goes out, `verifyChunkFailure` (reporter.ts) re-requests the failing
     chunk same-origin (HEAD, `cache:"no-store"`, 4s abort) and `chunkFailureKind` decides:
     a **4xx** confirms the chunk is gone → `stale-chunk-fatal`, pages; **200 / an unreachable
     probe / nothing to ask** (Safari's message carries no URL, cross-origin, 5xx) →
     `chunk-unreachable`, which the proxy logs at info under the same target. Err toward
     `chunk-unreachable` — a genuinely broken deploy still pages through every visitor whose
     engine names the URL. Probe the **unclamped** message: a URL cut by the 300-char cap would
     404 and manufacture a false page. The throttle slot is claimed synchronously *before* the
     probe so a crash loop can't fire one request per frame, and the probe must never reject —
     an escaping rejection lands back in our own `unhandledrejection` trap. This one is
     client-authoritative by necessity (only the client can ask), so SW-cached clients keep
     sending the old fatal shape until they update — which is exactly what `build` is for.
  6. **A crash beacon carries `build`, not just `version`** (2026-07-28). `__APP_VERSION__` is
     the package.json semver and has read `1.0.0` since launch, so it could never answer the
     question every one of these incidents ends on: *is this report from a bundle that already
     has the fix?* The app ships from a service-worker cache, so clients keep running — and
     beaconing from — a bundle for weeks after it is replaced. `__BUILD_ID__` (vite.config.ts)
     is the commit (`GITHUB_SHA` in CI, else `git rev-parse --short=10`, `-dirty` when the tree
     is uncommitted — in a prod log that means someone deployed by hand), falling back to a
     timestamp when git is unavailable so it is always unique per build. The proxy logs it
     beside `version`; a client predating the field logs as `build=pre-build-id`, which is
     itself the answer. Keep both fields — `version` is the release users see, `build` is the
     bundle. Neither the field nor the new `chunk-unreachable` kind needs deploy ordering: the
     old proxy ignores unknown JSON fields, and it already logs any non-`stale-chunk-fatal`
     kind at info.
  5. **Optional background imports must handle their own rejection** (2026-07-27). The
     escalation in (4) reads only "was it handled", so a *fire-and-forget* `import()` failing
     post-boot pages even though nothing on screen was waiting for it. `virtual:pwa-register`
     — the service-worker registration `main.tsx` schedules ~8s after first paint — did exactly
     that: a backgrounded tab's timers are throttled to a standstill, so the import can fire
     hours later against a deploy that purged the chunk, and the editor is running perfectly
     the whole time. Pass `reportBackgroundFailure` (reporter.ts) as the `.catch` of any such
     task: a stale chunk reports as handled `stale-chunk`, anything else keeps the honest
     `unhandledrejection` and still pages. `BACKGROUND_ONLY_CHUNKS` in telemetry.rs mirrors
     this for pre-fix SW-cached clients, which keep sending the fatal shape for weeks — add a
     chunk there only if it is reachable *solely* from fire-and-forget work, since the entry
     exempts it from paging for good. (`workbox-window` needs no entry: `manualChunks` folds it
     into `vendor`, which is already loaded, so its inner import can never 404.)
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
- **`attachEditorFields` must return the shape it declares — the schema layer trusts it
  absolutely** (2026-07-26). It is the single funnel for every external payload (JSON
  import/paste, share token, draft/history/saved/library hydration, template, AI reply, Discord
  Restore), and downstream code dereferences the non-optional fields with no guard: `walk`
  iterates `node.components` and yields `node.accessory`, `countCharacters` iterates
  `select.options`, the validator reads `media.url` / `item.media.url`. A payload omitting one
  reached those consumers as `undefined` and threw a bare TypeError. That shipped in 1.0.0: a
  pasted section with no `accessory` made `countCharacters` throw
  `Cannot use 'in' operator to search for 'content' in undefined` (note `in` throws on undefined
  rather than answering false) inside `JsonPanel.finish`'s click handler — so **Import looked
  dead** (the throw preempts both `setError` and `replace`) and the uncaught error paged the
  maintainer. `repairStructure` (normalize.ts) now fills a missing `components`/`items`/`options`
  array with `[]` and missing `media`/`file` with `{url:""}`: that invents nothing and the
  validator already has a precise complaint for each empty case. A missing Section `accessory`
  has no neutral value — a synthesized `createThumbnail()` would inject the DWEEB placeholder
  JPEG into a message that then really posts — so it is **refused** with a descriptive throw,
  which is safe because all 11 callers already treat a throw as "malformed payload" and report
  it. Two more layers, since this is the paging channel: the three `accessory`-yielding walkers
  (schema/traversal.ts, schema/capability.ts, plugins/targets.ts), `collabPatch`'s
  `childCollections`, and the structural helpers never dereference an absent accessory, and
  `validateNode` reports `SECTION_ACCESSORY_MISSING` so such a tree arriving by a non-boundary
  route (a peer's collab op) is blocked from send instead of silently 400ing at Discord. When
  adding a field the schema layer will walk unguarded, guarantee it here. Guarded by the
  malformed-payload tests in `serialization/encode.test.ts` + `schema/validation.test.ts`.
- **The Directory plugin needs no permission bit and no privileged intent — keep it that
  way** (`plugins/directory`, prefix `directory:`, port 8099, added 2026-07-26). It answers a
  click with a live read of the guild in one of two modes — a role/staff roster or a channel
  index with topics — from `GET /guilds/{id}?with_counts=true` + `/roles` + `/channels`, all
  of which work for a bot that is merely a guild member, and it never writes. There is
  deliberately no deployment in which part of it works and the rest doesn't.
  **"Who holds each role" was built and then removed (2026-07-26); don't rebuild it.**
  `GET /guilds/{id}/members` is gated behind Discord's privileged **GUILD_MEMBERS (Server
  Members) intent**, and nothing ungated substitutes: `/members/search` requires a name prefix
  and cannot filter by role, and the role object carries no member count — verified against
  Discord's docs, not assumed. It originally shipped as a graceful degradation (full roster +
  one "Member lists aren't available right now." line, logged at info), which was correct
  engineering but wrong product: **prod has the intent off permanently by the maintainer's
  decision**, so the only thing that feature ever did in practice was put an apology in the
  middle of members' messages — and in `"message"` output that apology read as the *author's
  own words*. Removing it deleted the member scan, its cache/permit pool/page cap, three env
  vars, and **the entire defer path** (see below). What replaced it: an opt-in, off-by-default
  `show_member_count` rendering the guild's own `-# 1,204 members · 87 online` under the
  heading. That rides on a request already being made, so it costs nothing, and an absent
  count renders as **nothing** rather than `0` — Discord staying silent must never become a
  false claim about someone's server. Three load-bearing details survive: (1) a roster is
  built from `<@&role>` **mentions** (colour pill, clickable, rename-proof), so every reply
  sets `allowed_mentions: {parse: []}` — without it one click on a *public* staff list pings
  every role it names; (2) **nothing defers** — a read is three concurrent requests answering
  inside Discord's ~3s window, so every response is terminal (no type 5/6, no
  `PATCH …/messages/@original`, no interaction token retained); `every_response_this_plugin_can_send_is_terminal`
  in discord.rs guards it, because a stray defer would look fine in review and show up as a
  stuck spinner; (3) `InstanceConfig` has **no `deny_unknown_fields`** and must not gain one —
  live instances still carry `show_members`/`max_members_per_role`/`include_bots`/
  `hide_empty_roles` in their stored JSON, and rejecting those would take a posted, working
  directory offline. Channel topics are member-written text rendered into a block joined on
  `\n`, and Discord's inline styles cross newlines, so they are markdown-escaped and collapsed
  to one line (an unbalanced `*` would otherwise italicise every channel after it). Guarded by
  the tests in `render.rs`/`discord.rs`/`rest.rs`/`store.rs`.
- **A Directory can write its list into the author's own message** (2026-07-26).
  `output` is `"reply"` (default — a reply to the clicker) or `"message"`: the
  author puts `{directory}` in their own text and a click re-stamps the message,
  so **everyone reads the list without clicking** and any click refreshes it for
  all. Five non-obvious constraints, all load-bearing: (1) the click answers an
  immediate `UPDATE_MESSAGE` (**type 7**). It must never become a deferred
  *reply* (type 5): after one, `@original` names the reply, so the list would
  land in an invisible ephemeral instead of the message it belongs to. This arm
  once deferred an UPDATE (type 6) to cover a slow member scan; that scan is gone
  and so is the defer — see the plugin's entry above; (2) re-rendering always
  starts from the stored **raw** template, never the live message, or the second
  click finds nothing left to substitute and the list freezes at its first value;
  (3) the update must
  repeat `IS_COMPONENTS_V2` for a V2 message and re-send `content` for a legacy one,
  or the edit **blanks the body**; (4) saving `"message"` output with **no**
  `{directory}` anywhere `substitute_tree` visits (`content`/`label`/`placeholder`
  — never `custom_id`) is **refused**, because it would post a button that
  re-renders correctly and therefore appears to do nothing at all, with no error
  anywhere; (5) the inline list is capped at 2000 chars (`MAX_INLINE_TEXT`) since it
  shares the message's single 4000-char budget with the author's prose and Discord
  rejects an over-budget message entirely. Tokens are namespaced (`directory`,
  `directory_count`, `directory_updated`) because Self Role already declares a bare
  `{roles}` and the host resolves collisions first-wins in binding order.
  **`"message"` output is button-only**, for two independent reasons: a menu's
  section pick is per-person while the message body is shared (one pick would
  re-stamp what everyone *else* sees), *and* the template is captured before the
  host wires the menu's options onto it, so a refresh would re-send an option-less
  select that Discord rejects.
  **Click-free updates are impossible — don't attempt them**: a webhook message is
  editable only through an interaction on it or with the webhook token, which stays
  sealed in the proxy. Guarded by the in-place tests in `discord.rs`, the
  `render_text` tests, and the in-message arm of `validate.rs`.
- **Adding an interaction plugin** touches the crate, compose service/volume + dispatcher
  `ROUTES`, Caddyfile, registry, `server/gatus/config.yaml`, `plugins-ci.yml` matrix,
  `.github/workflows/plugin-<id>.yml`, and `deploy.yml`'s workflow list. A link plugin is
  registry-only (no backend service). Plugin config iframes are forced dark theme. Ports in
  use: 8090 modal-form, 8091 ping-pong, 8092 self-role, 8093 tickets, 8094 giveaway,
  8095 dispatcher, 8096 quick-replies, 8097 picker, 8098 poll, 8099 directory.
- Every interaction plugin must verify custom-app signatures through the dispatcher-forwarded
  key attestation; `DISPATCHER_FORWARD_SECRET` must match the dispatcher and every plugin.
- **Component expiry is a sliding window, enforced in the dispatcher** (2026-07-18; was a
  fixed date from the send snowflake). A component click dies only when the message's send
  time AND its last served interaction are both older than `COMPONENT_TTL_DAYS` (default 7):
  every routed component/modal interaction restarts the window via a write-throttled
  `component_activity` upsert in dispatcher.db (`ActivityMarks` in-memory throttle ≈ TTL/8
  capped at 6h; rows pruned once older than the TTL — safe, their send time is at least as
  stale). The gate reads the store only for clicks already expired-by-snowflake, and a
  missing/unreadable activity row falls back to the fixed send-date rule — fail toward
  expiry, never toward unlimited validity. Never-expire slots exempt a message outright and
  remain the only protection for *idle* messages (that's the paid-slot pitch — active
  messages keep themselves alive for free). Keep user-facing copy phrased "N days without
  use", never "N days after sending", and treat client-side expiry estimates (gallery
  "Buttons may be expired" tag, scheduled-history badge, PermanentStatus date) as a no-use
  lower bound — the FE can't see server-side activity. The send/post confirm dialogs (web
  `SendConfirm` + Activity `PostConfirm`) present the choice as an **"Expiry" fact row —
  two choice pills with "Never expire" first and default-selected** whenever a slot is
  free, matching the dialog's When / Post as rows (maintainer: two explicit options
  2026-07-18 — replaced an on/off switch whose off state never said what happens —
  restyled from stacked radio cards into the fact row 2026-07-19; don't revert or flip
  the default, and the hint under the pills must always state the selected option's
  outcome), and all slot-usage copy goes through `slotUsageLabel`
  (core/guild/api.ts) so the unlimited-cap sentinel never renders as "1/1000000 slots".
- **In-Discord plugin management is discovered through "Message Info", executed by the
  plugin** (2026-07-24). Ops panels always existed but were hidden behind the plugin's own
  member-facing button (a giveaway host clicking Enter gets the Draw/Reroll/Cancel panel; a
  poll host's vote reply carries Close/Reopen/Results), which admins couldn't find. Now the
  Message Info reply lists every routed plugin it detects on the message (`plugins_on_message`
  in dispatcher commands.rs — custom_ids matched against the same ROUTES table clicks are
  forwarded by) and, for Manage Server holders in a guild, adds one "Manage <plugin>" button
  per instance of each prefix in `MANAGEABLE_PLUGINS` (currently `giveaway:` + `poll:`). The
  button's custom_id is `<prefix>manage:<instance>` — the PLUGIN's namespace, so the click
  travels the ordinary prefix forwarding (zero new routing, no command re-registration, custom
  apps included) and the plugin answers with its existing host panel as a **fresh type-4
  ephemeral** (never UPDATE_MESSAGE — the button sits on the info reply, and there is no
  public message in the interaction; the panel's own actions already refresh the public
  message out of band via the refresher cache / next-click). Authority is the plugin's
  `require_host` at click time — the dispatcher's Manage-Server gate is presentation only
  (host-role-only hosts don't see the buttons but keep the in-situ path). Contract details:
  instance ids are extracted only from *bare* bound custom_ids (`<prefix><id>`, the only
  shape the editor posts); verb-carrying ids name the plugin in the `**Plugins:**` line but
  mint no button; custom_ids past 100 chars and buttons past the 5-per-row cap are skipped.
  **Adding a plugin to the set**: implement the `manage:` verb arm (a plugin without it
  answers "Unknown action."), deploy that service FIRST, then add its prefix to
  `MANAGEABLE_PLUGINS`. Config edits stay web-only (the v2 management token is browser-local)
  — a manage panel is operational controls, never a config editor. The perm-toggle's
  UPDATE_MESSAGE refresh must keep foreign action rows (`other_action_rows`) or the manage
  row vanishes on toggle. Guarded by `manage_control_*` tests in giveaway/poll routes.rs and
  the `plugins_*`/`manage_buttons`/`other_action_rows` tests in dispatcher commands.rs.
- **A plugin may only answer 5xx for its own faults — 5xx is the paging channel.**
  `TraceLayer::new_for_http()`'s default classifier reports every 5xx through `on_failure` at
  ERROR level, and `dweeb-alerts` forwards backend ERRORs to Discord. So a status code is an
  alerting decision, not just an HTTP detail. All five bot-token plugins' `POST /api/connect`
  (quick-replies, giveaway, poll, self-role, tickets) used to answer a blanket **502 for every**
  `ConnectError`, including `BotNotInGuild` — and the config iframe **auto-connects on open**
  (`maybeConnect()`), so simply opening a plugin's config for a server whose shared bot was never
  invited paged the maintainer. That's what the 2026-07-20 quick-replies 502 alerts were; the
  ~230ms latency was the tell (a real `Network` failure takes the client's full 2.5s timeout).
  Mapping now lives in `ConnectError::status()`: `BotNotInGuild` → **404**, `RateLimited` (new,
  Discord 429) → **429**, `BadToken` → **500** (our credential is broken — this one *should*
  page), `Network` → **502** (genuine upstream failure). The config UIs branch on `!res.ok` and
  render `data.error`, so the copy is unchanged. Guarded by `only_our_own_faults_are_server_errors`
  in each crate's `rest.rs`. When adding a plugin route, ask "would an ordinary user action reach
  this branch?" — if yes it is 4xx, never 5xx.
- **Every router answers an unroutable path *after* draining the request body** (`not_found`,
  wired with `.fallback()` in all 11 Rust `main.rs` files — proxy + dispatcher + 9 plugins).
  Axum's default fallback answers 404 without touching the body, so hyper can't reuse the
  connection and closes it; Caddy, still copying that body upstream, reports
  `write: broken pipe`, throws the 404 away and synthesises a **502** — which it logs at ERROR,
  which pages (`dweeb-alerts`). Internet vulnerability scanners POST bodies at paths we don't
  serve constantly, so this paged the maintainer over requests already answered correctly
  (2026-07-21: `POST /lib/vendor/phpunit/…` at the proxy; the same class had already hit the
  picker host as `POST /`). Reading the body first keeps the connection reusable, so the honest
  404 is delivered and nothing is logged anywhere. `.fallback()` must be registered **before**
  the `.layer()` calls that should wrap it — `Router::layer` only applies to what was added
  above it. Buffering the drain through `Bytes` is deliberate: it is bounded by the ambient
  `DefaultBodyLimit`, and a body past that limit is one to hang up on rather than read.
  Guarded by `fallback_drains_the_request_body` in `server/src/main.rs`.
- **Caddy rides out a container restart instead of 502ing it** (`upstream_retry` snippet in
  `server/Caddyfile`, added 2026-07-26). Recreating a container leaves a sub-second gap where
  Caddy dials an address the service no longer holds, gets `connection refused`, answers
  **502** and logs it at ERROR — which pages, because that class is deliberately *not* in
  `dweeb-alerts`' `CONN_ABORT_RE` (a genuinely dead upstream must still page). So every
  routine deploy could page: measured before the fix, one `--force-recreate` of a plugin
  produced **6 consecutive 502s** out of 200 probes. Worse for members — a Discord
  interaction landing in that gap shows "interaction failed". Every app-facing
  `reverse_proxy` (proxy, both dispatcher routes, all 9 plugins) now imports
  `lb_try_duration 2s` + `lb_try_interval 200ms`. Measured after: **0/200 failures and zero
  ERROR-level log lines** — a successful retry logs nothing, which is the whole point.
  Four properties to preserve if you touch it: (1) retrying is safe *only* because this is a
  **dial** failure — nothing reached the upstream and Caddy retries only while no response
  headers are written, so it can't double-process; it is **not** a blanket "retry 5xx", and
  an upstream answering 500 still passes straight through. (2) The healthy path is unaffected
  (~60ms measured before and after) since no retry happens when the dial succeeds. (3) A
  genuinely stopped upstream **still 502s**, just ~2.2s later, so a real outage stays visible
  and still pages — don't raise the window much past this, and keep it clear of Discord's ~3s
  interaction budget. (4) The **monitoring** blocks (Gatus, Beszel) deliberately do *not*
  import it: when they're down, failing fast is the honest answer. The Caddyfile is a
  hand-synced bind mount — copy it and `docker exec dweeb-caddy-1 caddy reload
  --config /etc/caddy/Caddyfile` after editing.
- **The paging channel carries our faults, so `dweeb-alerts` drops Caddy connection aborts**
  (`broken pipe`, `connection reset by peer`, `context canceled`, `client disconnected` —
  `CONN_ABORT_RE`). Draining above removes the scanner case, but the honest residue stays: a
  413 on an oversized upload, a 429 under abuse, a browser closing a tab. None is actionable,
  and an upstream genuinely going down still pages three other ways — its own panic/tracing
  ERROR, Caddy's `dial tcp … connection refused`/DNS errors (which carry no abort wording and
  pass the filter), and Gatus on `/ready`. Don't widen that regex into a blanket Caddy mute.
- **The Top.gg listing's server count is pushed, and its failures must stay quiet**
  (`server/src/topgg.rs`, added 2026-07-30). Top.gg renders whatever count a bot last
  **posted** — there is no pull, and stats are the only writable part of a listing — so a
  page nobody posts to keeps showing the number it was created with. A background task
  reports the live guild count every `TOPGG_POST_INTERVAL_SECS` (default 30 min) under
  `TOPGG_TOKEN` (unset ⇒ never spawns, which is right for every self-hosted deployment).
  Three load-bearing details: (1) it **never logs `error!`** — tracing ERROR is the paging
  channel, and a stale public counter is not worth waking anyone, so a Top.gg outage/429 is
  `info` + retry on the next tick and only refused credentials earn a `warn`; (2) a failed
  guild read is **skipped, never published as `server_count: 0`** — the picker's cached
  `bot_guild_set` folds an error into an empty set, which is why this reads
  `discord.bot_guild_ids()` directly; a published zero is visibly wrong on a public page and
  sorts the listing to the bottom, where a stale count merely lags; (3) the token goes in
  `Authorization` **bare** (the documented form). Verified against the live API 2026-07-30:
  the stats route resolves the bot from the **token** and ignores the id in the path — a
  request naming a completely unrelated bot returns *our* stats — so a wrong `TOPGG_BOT_ID`
  will appear to work and a 200 is no proof the id is right.
- **Plugin request and storage work is resource-bounded.** Every plugin router caps request
  bodies at 256 KiB. Interaction services parse their primary Ed25519 key once at boot (custom
  attested keys remain dynamic), bound idle HTTP pools, and configure SQLite with WAL,
  `synchronous=NORMAL`, and a 5-second busy timeout. Stateful stores must release the connection
  mutex before token hashing or JSON decoding. Giveaway draws use constant-memory reservoir
  sampling and compare-and-swap commits; ticket numbering and anti-spam checks stay single-query.
- Stateful plugin instance ids in Discord `custom_id` are public bindings, never edit authority.
  Protocol-v2 services return a separate 256-bit management token once, store only its SHA-256
  digest, and require it for updates; a legacy/cache-miss edit must create and rebind a new
  instance. **All stateful plugins are v2 as of 2026-07-16** (modal-form and self-role
  first; picker, quick-replies, giveaway, and tickets migrated in one pass — services deployed
  before the web-manifest bump, per the deploy-ordering rule above; poll shipped v2-native
  2026-07-18). Pre-migration instances
  keep a null token digest, so an edit of one always 403s into the create-a-replacement flow;
  a replacement giveaway starts with an empty entry list and a replacement ticket panel restarts
  its numbering/ledger (both config UIs say so on the 403). Never add a v1 stateful plugin. Saved-webhook approval responses travel over an iframe-created `MessagePort`, not
  `contentWindow`. Deploy compatible plugin services/static pages before the v2 web manifest.
- Plugin-library presets and `init.preset` seeding stay; the duplicate in-config “Quick start”
  bars stay removed.
- **Adding/removing a template**: update `src/data/presets.ts` + `scripts/seo/content.ts`
  (build **throws** if a template has no SEO entry) **+ its slug in `ENTRY_IDS`
  (`src/core/seo/acquisition.ts`)** — the audit fails every CTA on the new page with
  "unknown acquisition token" otherwise, exactly as it does for a guide or landing.
  Check `scripts/seo/features.ts` and `video/src/data.ts` references, and regenerate
  committed OG images with
  `bun add -d sharp && bun scripts/gen-template-og.ts && bun remove sharp` (run from the
  repo root; expect the new card **plus** `templates-og/templates.png`, the catalogue hub
  card, to change — every other card stays byte-identical).
- **Static discovery is a build contract.** `scripts/gen-template-pages.ts` generates the
  template and feature catalogues, `/guides/*`, the product landing pages, and the image
  sitemap. Build-critical generator code is covered by `tsconfig.seo.json`; `bun run build` then
  runs `scripts/seo/audit.ts`, which fails on broken sitemap
  targets/internal links, duplicate or missing metadata, invalid JSON-LD, missing/wrong-size
  social cards, stale/future dates, late charset declarations, thin detail pages, and orphaned
  templates. Add new discovery routes to that generator rather than hand-writing unverified
  files in `dist/`; keep source-backed guide claims and `lastmod` dates honest.
  **Datetime-typed JSON-LD properties need a timezone.** `uploadDate` on the home page's
  intro-film `VideoObject` shipped as a bare `"2026-07-17"`, which Search Console reported as
  *two* issues at once — "Invalid datetime value" and "missing a timezone" (2026-07-20). It is
  now a full zoned ISO 8601 datetime, and `DATETIME_PROPERTIES` in `audit.ts` fails the build on
  any regression. That set is deliberately narrow: `datePublished`/`dateModified` are Date-typed,
  are legitimately date-only, and are separately cross-checked against sitemap `lastmod` — don't
  widen it to them.
  Landing pages are a catalog (`LANDINGS` in `scripts/seo/guides.ts`, rendered by
  `renderLandingPage`) — currently `/discord-webhook-builder/` and `/discord-embed-builder/`.
  **Adding a guide or landing** = entry in `GUIDES`/`LANDINGS` + its slug in `ENTRY_IDS`
  (`src/core/seo/acquisition.ts`, else the audit fails the CTA token) + a committed OG card via
  `bun add -d sharp && bun scripts/gen-template-og.ts --guides-only && bun remove sharp`
  (guide/landing cards only; output is deterministic, untouched cards stay byte-identical).
  Bump `GUIDES_LASTMOD` when guides change — the audit fails a hub whose lastmod is older
  than its newest child, and bump a guide's `modified` when its visible content (including
  related-link cards) changes.
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
- **A 100%-off-forever promo code takes no card — which forces the code through our
  own field** (2026-07-27). Stripe skips card collection only with
  `payment_method_collection: "if_required"` **and** a total that is already 0 **when the
  Checkout Session is created**; the same code typed into Checkout's *own* promo box
  arrives after the session exists and the card form it was built with does not go away.
  So the pricing modal has a "Have a promo code?" field, `POST /api/stripe/checkout` takes
  `promotion_code`, and the proxy applies it server-side as `discounts[0][promotion_code]`.
  Five load-bearing details: (1) **`allow_promotion_codes` is never sent**, so Checkout has
  no promo field of its own and ours is the only entrance. Shipping both was a trap
  (fixed 2026-07-27, same day): Stripe's box sits beside the price and looks official, so
  that's where people typed the code — and a 100%-off code entered *there* discounts to
  $0.00 and **still demands a card**, with nothing able to warn them, because the session
  was already minted with collection on. Nothing is lost by removing it (our field takes any
  code; a partial one still discounts and still collects the card), the field is therefore
  **always visible** rather than behind a disclosure, and re-adding the parameter would break
  every *coded* purchase too — it is mutually exclusive with `discounts`, and Stripe rejects
  a session carrying both; (2) `if_required` is set **only** when the coupon is `percent_off >= 100` **and**
  `duration: "forever"` (`PromoCode::covers_everything`) — a time-limited 100%-off coupon
  keeps collecting the card its first real renewal needs, and an `amount_off` coupon that
  merely happens to equal today's price is excluded because a price change would strand a
  card-less customer; (3) only the **customer-facing code** is accepted from the client,
  never a `coupon`/`promo_…` id — a promotion code is the object Stripe means to be handed
  out, and `parse_promotion_code` re-checks `active`, `expires_at`, `max_redemptions`, and
  `coupon.valid` itself rather than trusting the `active=true` filter alone. **The coupon
  is not where the old docs put it**: on the account's current API version a promotion code
  carries it as a bare id under `promotion.coupon` (needing
  `expand[]=data.promotion.coupon`), while older versions inline a top-level `coupon` —
  same both-shapes hazard as `current_period_end` in `extract_sub_fields`. Reading only the
  top level shipped a live 100%-off-forever code reporting itself as *expired* (2026-07-27),
  found only by querying Stripe by hand, which is why a refused lookup now logs under
  `stripe_promo`. A coupon that can't be read is **not** a rejection — the code is still
  applied (Stripe validates it at session creation) and merely doesn't qualify as
  free-forever; refusing a code we only failed to *parse* is the worse failure. Don't add
  more `expand` paths: a rejected query is a 502 that pages, and the legacy path needs none.
  (4) every
  promo failure is a **4xx** — a typo (`PromoError::Invalid`) and a code whose restrictions
  don't fit the purchase (`CheckoutError::PromoRejected`, logged at *info* under
  `stripe_promo`) — because 5xx is the paging channel and neither is our fault; that is why
  `post_form` carries Stripe's status (`StripeErr::is_client_error`) instead of a bare
  string; (5) the route has its own per-IP limiter (`CHECKOUT_RATE_*` in main.rs) since each
  call mints a Stripe session and may resolve a code. Expiry/redemption caps stay Stripe's
  job (`max_redemptions`, `expires_at` on the coupon) — don't rebuild them here. A free
  subscription still mirrors as `active`, so entitlement flows normally; if the coupon is
  ever deleted the next invoice fails and the tier drops on its own. Guarded by the
  `checkout_form_*`/`normalize_promo_code_*`/`parse_promotion_code_*` tests in stripe.rs.
- **An advertised promo campaign is presentation only, and must be kept true by hand**
  (`src/core/plan/promo.ts`, added 2026-08-01). `ACTIVE_PROMO` is what the pricing modal
  *claims* — the discount itself is a coupon in the shared live Stripe account, created by
  the maintainer; nothing in-repo creates or checks it. The live campaign is
  **`MEDIUMPROMO` = 50% off the first payment on Plus** (monthly and annual), auto-applied
  by `PricingModal` on the tiers it covers, since the card already shows the discounted
  price and making the buyer type a code to reach it would be a trap. Rules that hold the
  claim together: (1) it is applied **only where a card can act on it** — `promoFor` is
  consulted for a tier only when that tier is `buyable` here, so a "50% off" flash never
  lands on the plan the server already holds; (2) a **typed code always wins** over the
  campaign's (they chose it, and Stripe takes one per session); (3) a checkout refused with
  the auto-applied code **fails loudly as a toast** and is never silently retried at list
  price — that would charge more than the card advertised; (4) a `first-payment` campaign
  must print the renewal price beside the discounted one (`thenNote`), or the headline is a
  bait price; (5) which tiers a campaign may name is a **Stripe** question — a coupon can
  carry `applies_to` product restrictions, and DWEEB's tiers buy the sibling RoleLogic
  prices (Plus = Medium, Pro = Expanded). `MEDIUMPROMO`'s coupon is scoped to the **Medium
  product**, which owns both prices Plus buys, so Plus is safe on either interval and
  **Pro must never be added** — Stripe refuses the session and the buyer gets "That promo
  code can't be used on this plan" from a card that promised a discount (the existing
  `PromoRejected` 400; verified live). Reading that restriction has a trap: `applies_to` is
  an **expandable** field, so a plain `GET /v1/coupons/{id}` omits it and a restricted
  coupon looks unrestricted — ask with `?expand[]=applies_to`, and never conclude
  "unrestricted" from its absence (the same shape of hazard as `promotion.coupon` in
  stripe.rs; a first pass at this account got it exactly backwards). If the coupon is
  edited, expires, or is archived, edit `ACTIVE_PROMO` (or set it to `null`) in the same
  change; `promo.test.ts` pins code/percent/duration/tiers as a change-detector so Stripe
  and the modal can't drift apart silently. Purely a web change — the proxy already resolves
  and applies whatever code it is handed, so no deploy ordering.
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
- **Promo-film story locks** (`video/`, settled 2026-07-17): the opening is a direct
  boring-message → visual-message makeover on a neutral preview surface — never an
  announcement being buried in `#general`. The Build Together beat starts directly in the
  Discord Activity editor and clicks its bottom-right invite/presence dock; do not restore the
  voice-call shelf/launch detour. The outro promise is “Build better Discord messages” and its
  action is a Google-style search bar for “DWEEB Discord builder,” with the G at the far
  end. Keep `video/SCRIPT.md`, generated narration/manifest, and both aspect-ratio beats aligned.
- index.html's JSON-LD `softwareVersion`/`dateModified` and `og:updated_time` are stamped
  at build by `stampBuildMeta` (vite.config.ts) — don't hand-maintain them; the build
  throws if the patterns vanish. Marketing claims there must match the plans model
  (quota-raising only — never claim "no usage limit" or "no paywall").
- **Message library is metadata-first.** "Posted" is a server-only rolling history window (no
  local fallback); drafts have hard per-plan caps. Gallery open uses
  `/library?metadata_only=true`, whose SQL excludes both sealed payload columns; visible cards
  hydrate through the guild-scoped `/library/entries` endpoint in batches of at most 64 (24 cards
  at a time in the UI), while exact body search loads remaining batches sequentially. The legacy
  full-list response remains for deploy skew. Reopening an editing draft uses the indexed
  `/library/origin/:message_id` lookup, never a full list. Keep decryption/JSON parsing on the
  blocking pool, and reset/invalidate all decrypted rows on sign-out or a 401/403. Async draft
  origin recovery must also retain the editor's whole-document generation; a template/import/clear
  while the lookup is pending must never arm the replacement message with the old webhook secret.
- Keep the default `webhook.incoming` OAuth path. Custom bots must not collect bot tokens;
  their OAuth create flow uses the popup/localStorage handshake because Discord can sever
  `window.opener`.
- Link-plugin URLs stay freely editable and the binding follows the URL. Keep one uniform
  link-plugin UI; do not reintroduce per-plugin parameter panels.
- **Link plugins have two optional manifest upgrades** (docs/plugins.md): `statusUrl` — a
  public CORS-open probe (`{"configured": bool}`) that flips the chip to a live
  Ready/Needs-setup state (strictly best-effort: every failure renders as the old static
  hint; it must never gate editing or send); and `configUrl` — a config iframe whose `save`
  returns a **url** validated against the manifest's own template prefix
  (`isValidLinkSaveUrl`), with resources capped at `guild` (never credentials/message
  content). The link host lives in `useLinkPluginConfig.ts`, deliberately separate from the
  interactive `usePluginConfig.ts` — don't merge them. All RoleLogic entries carry
  `statusUrl` (server side: `/{plugin}/dweeb/status` in each RoleLogic-Plugins crate);
  Form-Respondent-Role additionally serves the picker iframe (`/dweeb/picker` + popup
  `/dweeb/bridge` auth + `/dweeb/forms`). **Link config iframes are web-only**: in the
  Activity the sandbox blocks the popup sign-in and cross-origin calls, so the editor
  hides Configure there (don't "fix" this by allowlisting the host in the Activity plugin
  proxy — the loaded picker still couldn't authenticate); the probe is likewise
  CSP-blocked there and degrades to "unknown" by design. The production CSP's `frame-src`
  is derived from every registry `configUrl` origin in vite.config.ts — never
  hand-maintain it.
- **Discovery marketing**: lead with DWEEB's visual Discord message builder for webhooks,
  embeds, and Components V2. Do not use "without the JSON" copy, and do not present the
  collaborative "Build Together" Activity feature as DWEEB's main functionality. Keep
  essential discovery-banner text and branding inside the central vertical safe band because
  Discord's listing preview may center-crop the banner at larger display sizes. Persist the
  source upload assets in `public/activity-assets/`; `dist/activity-assets/` is generated.
- **A decided destination leads; the alternatives fold away behind it.** When the action bar's
  channel chip has a pick, the Send tab renders `GuildWebhookPicker variant="summary"` — one row
  for the picked channel first, and the rest of the server's channels folded into a
  "Post to a different channel" disclosure (`changeHeader`/`changeOpen`) rather than a list to
  scroll past. The same disclosure wraps the restore/update webhook list once a webhook is
  already bound, under "Use a different webhook". The full list is only shown up front when
  nothing is picked yet (it's then the first pick, not a re-pick), and *that* decision is still
  frozen per dialog open so an in-dialog pick can't flip the layout mid-flow; the disclosure
  itself is opened by the user and stays open for the same reason. Picking inside it writes the
  bar store, so the toolbar chip follows — a pick is a pick wherever it's made. (2026-07-27
  revision: the summary used to be strictly read-only and told the user to close the dialog,
  which made a last-second change of mind cost a round trip. Don't re-hide the alternatives, and
  don't promote them back to the top.) The two fetches that section needs — the guild's webhooks
  and its custom bots — are warmed from the builder shell by `core/webhook/prefetch.ts` (idle
  callback on connect + a pointer/focus touch of either action-bar cluster), so the dialog
  usually opens on a resolved destination instead of "Loading this server…"; both stores dedupe
  and cache, so the picker's own mount-time load lands as a cache hit.
- **Built-in AI is a server-relayed Groq key with layered spend guards** (2026-07-19). The
  default AI provider is `dweeb`: `POST /api/ai/chat` on the proxy (`server/src/ai.rs`)
  relays a streamed completion under a server-held `GROQ_API_KEY` (unset ⇒ 501 and the FE
  hides the provider; `/api/capabilities` reports `ai`). **The client sends data only**
  (`guild_id` + current-message `context` + transcript `turns`, closed contract) — the
  instruction template, model (`AI_MODEL`), `max_tokens`, and temperature are pinned
  server-side, so the route can't be borrowed as a general-purpose LLM API. The template's
  single source of truth is `server/src/ai_prompt.txt` (Rust `include_str!`, FE `?raw`
  import in `systemPrompt.ts` — it must stay under `server/src/` because the server's
  Docker build context only copies that directory; `systemPrompt.test.ts` guards its baked
  limit numbers against `LIMITS` drift, and `build_system`/`buildSystemPrompt` must stay
  byte-identical). Guards, outermost in: route-local per-IP limiter → sign-in (cookie;
  needs an `/api/activity/*` bearer twin before the assistant ever ships in the Activity) →
  per-user pacing bucket + one-in-flight → daily quotas (Free = per-user
  `PLAN_FREE_AI_REQUESTS/_TOKENS`; Plus/Pro = per-server pool + per-member ceiling,
  resolved via `authorize_member_session` + entitlement) → concurrency semaphore
  (`AI_CONCURRENCY`, plus `AI_RESERVED_CONCURRENCY` permits only paid servers may spill
  into) → `AI_MONTHLY_TOKEN_BUDGET`, the monthly global token ceiling that makes the
  feature's worst-case cost the number in the env file (distinct 503, FE steers to BYOK).
  Usage is a SQLite rollup ledger (`ai_usage.rs`, `AI_DB_PATH` — a durable store: absolute
  path in prod, probed by `/ready`), recorded from Groq's final-chunk usage (estimated
  from chars when absent) and logged content-free under the `ai_usage` tracing target;
  `GET /api/ai/usage` feeds the panel meter. Quota copy says "resets at midnight UTC".
  Pro's AI quota is deliberately large-but-bounded, never unlimited (each request spends
  real provider money) — that stays consistent with "plans are quota-raising only"
  because Free keeps the feature too. BYOK providers remain unlimited and untouched; the
  relay streams Groq's OpenAI-shaped SSE verbatim so the FE reuses the same decoder.
  **A provider rate limit is a 429 to the caller, never a 5xx** (2026-08-01). Every 5xx the
  proxy returns is logged at ERROR by `tower_http`'s failure classifier and forwarded to
  Discord by `dweeb-alerts`, so the status a handler picks *is* the paging decision.
  `start_stream` treated only Groq's **413** as a rate limit (`is_capacity`); a plain **429**
  was retryable but fell through to the terminal 502 — so when the free tier's per-minute
  token budget binds on every model in the chain, a working assistant paged the maintainer
  (three times in one minute, `latency≈690 ms`, which is just the three attempts). Both
  shapes now answer 429 through `terminal_error`: 413 keeps the size-aware copy (prompt +
  reserved `max_tokens` exceeds the per-minute budget — waiting alone won't help), 429 gets
  "at its rate limit right now". Only `Unavailable` (network, timeout, upstream 5xx) still
  502s, and a non-retryable 4xx (our key, our malformed request) still logs `error!` — those
  *should* page. `Retry-After` is read off the provider's response when it sends one
  (Groq's hints ranged from <1s to 23s, against a hardcoded 30), clamped to 1–300s, with the
  HTTP-date form ignored. A rate-limited model also **skips its remaining attempts** — a
  per-minute bucket cannot clear in the 300 ms before the retry, so that call could only fail
  while spending another request from the full bucket; the fallback model has its own bucket
  and is still tried. Note the FE needs no deploy: `describeDweebError` renders `error` for
  any un-`kind`ed status. Guarded by the `provider_rate_limits_answer_429_and_never_page` +
  `retry_after_prefers_the_providers_own_hint` tests in ai.rs.
- **AI assistant (src/core/ai) reliability contract.** The chat panel strips the model's
  JSON payload from the displayed bubble, but provider history must carry the RAW reply —
  `ChatMessage.raw` + `toTurns` — or follow-ups like "do it" leave the model blind to its
  own previous JSON (this shipped broken and produced announce-only loops). A settled reply
  that _announces_ an edit ("Here's a streamlined version…") with no ```json block gets ONE
  recovery turn (`buildMissingPayloadPrompt`, with a `NO_CHANGE` escape so false positives
  are harmless); if still payloadless it must render the honest "Message not changed" chip
  (`failedEdit`), never prose that masquerades as an applied edit. The Anthropic adapter
  must NOT send `temperature`/`top_p`/`top_k` (Claude Opus 4.7+ / Sonnet 5 / Fable 5 reject
  them with a 400), and provider default-model ids must be currently-served models (the old
  `claude-3-5-sonnet-latest` default 404'd — it retired 2025-10). Guarded by
  `src/core/ai/aiStore.test.ts` + `extractReply.test.ts`. Streaming token bursts are committed to
  Zustand at most once per display frame; do not restore one full transcript-array copy/render per
  token. The accumulated raw reply still records every token for provider history. Provider
  controllers are owned by a monotonically identified send: a cancelled send settling late must
  never clear a newer send's controller, thinking state, or editor commit.
- **An uploaded avatar must be hosted forever — Discord hot-links `avatar_url`.**
  Discord does *not* re-host the avatar image: it stores the URL string on the message
  and re-fetches it every time that message renders. So every "cheap" hosting idea is
  wrong, and two were tried and rejected on the evidence (2026-07-20): a short-TTL /
  in-memory store puts a **broken image in a permanent message**, and reusing Discord's
  own attachment CDN (post the image as a throwaway webhook message, keep its
  `cdn.discordapp.com/attachments/…` link, delete the message) **does not work at all** —
  Discord rejects its own attachment URLs in `avatar_url` with *and* without the
  `?ex=&is=&hm=` signature params (discord-api-docs#6657). Don't reintroduce either.
  Hosting therefore lives in the proxy (`server/src/avatar.rs`, `AVATAR_*` env,
  `/data/avatars.db`): `POST /api/avatar` takes raw bytes and returns a permanent
  `…/api/avatar/<sha256>.png`, `GET` serves them anonymously (Discord's fetcher carries
  no credential) as `immutable` for a year. Rows are **never swept** — deleting one
  silently breaks a live post — so size is bounded only by content-addressed dedupe, a
  byte cap, and a row cap that answers 503 rather than evicting. The browser does all
  the pixel work (`core/avatar/image.ts`: center-crop, downscale to 256², re-encode),
  because Discord *silently* falls back to the default avatar for images past ~1024px
  and never renders animated GIFs (#830) — so the server only parses PNG/JPEG **header**
  bytes to verify dimensions, and needs no image-decoding crate. Format is chosen per
  image: PNG whenever there is any transparency (JPEG would flatten it to black inside
  Discord's circular crop), else PNG until `PNG_SIZE_BUDGET`, then JPEG. Upload is
  identity-gated through `resolve_identity` (**not** cookie-only — the Activity renders
  the same `ComponentTree`) so the endpoint can't become a free image host. The field
  stays a URL input: uploading just fills it, because it must keep accepting
  `{server_icon}` and existing CDN links.
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
- **Hot process caches are bounded by both cardinality and lifetime.** The fallback Discord JSON
  cache lazily reclaims expiry, admits at most 10,000 keys / an estimated 32 MiB of retained JSON,
  and gives Redis GET/SET two seconds before failing open. Entitlement and lazy-reconcile maps also
  expire and cap guild keys; their cold/background work is single-flight or semaphore-bounded.
  For horizontal proxy scaling, use Redis rather than raising process-local bounds.
- **Cached JSON is read by reference on request paths.** The per-request authorization gates
  (`find_guild` in routes.rs) scan the user's cached guild list in place and decode only the one
  matching entry; the full-list deserializations (`guild_list`, `bot_guild_set`, the Activity's
  `resolve_bearer`) go through `T::deserialize(v.as_ref())`. Never reintroduce
  `from_value((*v).clone())` — deep-cloning the cached tree on every authorized request was the
  proxy's largest per-request allocation cost. A cache hit whose *matching* entry doesn't decode
  falls through to a refetch (same recovery a failed whole-list parse had); a well-formed list
  without the guild is a definitive deny for the TTL. Guarded by the `scan_*` tests in routes.rs.
- **Scheduled delivery concurrency is per destination.** Due rows for different webhook ids run
  concurrently up to the small SQLite-pool-derived cap, but rows for one webhook remain serial and
  in due order. This avoids head-of-line blocking without racing Discord's per-webhook rate limit.
  Missed interval ticks use `Skip`, so an upstream slowdown never triggers a catch-up burst.
- **Browser upload hydration follows reachability.** Startup collects `session://` ids from the
  live message, undo/redo, and named browser saves, reads only those IndexedDB blobs, and deletes
  orphan keys with a key-only cursor (never materializing stale file bytes). Those orphan deletes
  are issued as `store.delete(key)` requests, **never `IDBCursor.delete()`** — a key cursor's
  `delete()` throws `InvalidStateError`, and an exception (or unhandled request error, hence the
  `preventDefault` on each delete) inside the transaction's handlers aborts the whole transaction:
  v1.0.0 shipped that, so one orphan key both fired a `web_crash` beacon and silently dropped
  hydration of the user's *live* uploads (fixed 2026-07-19, guarded by
  `src/core/state/attachmentDb.test.ts` against fake-indexeddb, which enforces the spec
  restriction). Multi-file gallery
  registration is one IDB transaction + one attachment-store notification; GC is debounced and
  snapshot URL scans are WeakMap-cached under the stores' immutable-tree contract.
- **The connected server's name/icon are cached separately from its data.** `guildStore`
  hydrates the connected guild's id *and* its whole roles/channels/emojis map synchronously from
  localStorage, but a guild's display name and icon hash exist only in `authStore.guilds`, which
  costs two sequential round-trips (`/auth/me` → `/api/guilds`) and is never persisted. The
  landing gallery auto-opens on the first frame, so anything gated on that list showed its
  "no server" fallback — the Message directory's title rendered the generic sparkle glyph beside
  a fully-loaded server library, and stayed there for good if `/api/guilds` was slow or errored.
  `core/guild/identityCache.ts` persists just `{id, name, icon}` for the connected guild;
  resolution order is **live list → cached identity** (`resolveGuildIdentity`, or the
  `useGuildIdentity` hook exported from `features/share/GuildIdentity.tsx`). The list stays
  authoritative: `syncGuildIdentity` refreshes the cache on every load and *drops* it when the
  connected guild is absent from a loaded list, so a left server can't pin a stale chip. Don't
  reintroduce a bare `guilds.find(...)` on a surface that must render before sign-in resolves.
- **Authentication defines an account-state lifetime.** Credential/decrypted stores register with
  `core/auth/accountScopedState`; logout/session expiry clears and aborts library, webhook,
  custom-bot, and emoji work before publishing anonymous state, and generation guards reject late
  responses from the prior account. Cross-guild emoji fetches share a process-global four-request
  permit pool and merge one batch at a time. Add any new account-scoped cache to this reset path.

## CI

- `web.yml` — FE build + Vitest + GitHub Pages deploy. `server.yml` — Rust fmt/clippy/test. `plugins-ci.yml` — fmt/clippy/test matrix over all 10 crates. `deploy.yml` — backend CD.
- **Workflows must not depend on `api.github.com` at runtime** — calls to it from Actions
  runners fail intermittently (HTML error page). This broke `setup-bun`'s version lookup
  (fixed by pinning `bun-version` in `web.yml`) and `docker/metadata-action` in all 10 image
  workflows (replaced 2026-07-17 with a shell tag-derivation step + static OCI labels; keep
  the `sha-<short>` tag scheme — `deploy.yml` rollback relies on it). Don't reintroduce
  actions that query the GitHub API mid-job.
- Pushing `main` triggers deployments; never push unless the maintainer explicitly asks.
