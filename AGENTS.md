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
- `bun run verify:codegen` — runs every code-export target (`src/core/codegen`) against the real
  discord.js / discord.py / requests / curl and compares the result with the source payload. Needs
  the libraries installed somewhere (`CODEGEN_VERIFY_NODE_DIR`, `CODEGEN_VERIFY_PYTHON`; header of
  `scripts/verify-codegen.ts`); on-demand, never a CI gate. Run it after touching a generator.
- `bun run gen:mcp` — regenerates the data + pinning corpus the Rust MCP server serves
  (`server/src/mcp/*.json`). Also run by `bun run build`, and `web.yml` fails on a resulting
  diff, so a stale catalog cannot be committed. See `docs/mcp.md`.
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

- `src/core/codegen` — the code export (discord.js, discord.py, cURL, fetch, Python requests), a
  pure function of the wire payload; used by the Share dialog's Code tab and by the static-site
  generator for every code sample on the site.
- `src/core` — non-UI application logic (stores, serialization, validation, API clients,
  telemetry). `src/features` — UI features. `src/activity` — Discord Activity entry.
- `server/src` — Rust API proxy: Discord/OAuth auth, plain-SQLite shortlinks, and
  SQLite-backed schedules/message library/Activity drafts whose sensitive payloads are sealed.
- `server/src/mcp` — the MCP server (HTTPS at `/mcp`, OAuth-guarded) plus its generated data
  (`catalog.json`, `validation-corpus.json`, `lz-vectors.json` — never hand-edit; run
  `bun run gen:mcp`).
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
- **A crash beacon must be *our* crash before it may page** (2026-07-24; extension frames
  2026-09-14). The `error` and `unhandledrejection` traps hear everything thrown or dropped in the
  page's own JS world, including code we never shipped — extension scripts that run in the page's
  world (a wallet must, to define `window.ethereum`; an isolated-world content script never reaches
  page listeners), userscripts, bookmarklets, console experiments. Two have paged. 2026-07-24: a
  Safari user's foreign script overflowed its own stack ("Maximum call stack size exceeded.",
  frames `@`/`Pk@`/`Nk@` with **no source URL** — JSC's rendering of code that has no script URL);
  rebuilding every deployed 1.0.0 bundle proved no DWEEB build contained those symbols (prod-vs-local
  identifier histograms match, so local rebuilds are name-faithful — a reusable diagnosis trick).
  2026-09-14: MetaMask's page-world `inpage.js` dropped its own connection promise (`i: Failed to
  connect to MetaMask`, one frame at `chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/…`, kind
  `unhandledrejection` — a fire-and-forget warm-up that rejects after a 10 s extension-detection
  timeout; DWEEB never touches `window.ethereum`), reported by build `e699a38eec`, ~25 days stale in
  an SW cache, so **only the proxy could stop it**. Policy: `isForeignCodeError` (crashReport.ts)
  and `is_foreign_code_error` (telemetry.rs — the authority, since SW-stale clients keep their
  reporter for weeks), both pinned to the hand-written `server/src/foreign-code-vectors.json`. Both
  judge the text as the proxy reads it — `clamp_field` turns control characters into spaces, and
  the client maps them the same way first (`asProxyReads`) — so newline vs space, or a `\n` inside
  a token, can never split the verdict; the Rust suite runs each case through `clamp_field`, the
  TS suite both as written *and* flattened, and both trim the muted-error check alike. A stack's
  **locations** are each `://` read with the **whole** `[A-Za-z0-9+.-]` run before it, compared
  whole and ASCII-case-insensitively — so `blob:https`, `webpack-internal`, `wasm` and any empty or
  malformed run count as ours, the paging side — plus Firefox's `<anonymous code>`, its deliberate
  name for every page-world extension script and for nothing else (without it the Gecko rendering of
  the same MetaMask rejection names no location and pages); location-less frames (`<anonymous>`,
  `[native code]`, `async Promise.all (index 0)`) are ignored. Foreign = (1) **every** location an
  extension's — `chrome-extension` (every Chromium browser, Edge included), `moz-extension`,
  `safari-web-extension`, `safari-extension`, `webkit-masked-url` (Safari 16+ masks every extension
  script URL and never an http(s)/blob one) — for `error` *and* `unhandledrejection`; (2) `error`
  only, frames that name no location; (3) `error` only, the muted `Script error.` + empty stack.
  The client drops these before the throttle; the proxy logs them at **info** (`web app
  foreign-code error`, still under `web_crash`). Both that line and the paging `web app crash` carry
  `frames=none|page|extension|mixed` right after `kind` — on a page, `frames=mixed` says an
  extension was in the stack beside ours. Deliberately narrow: **all** locations, never the top
  frame (Sentry's rule — it would silence our own misuse of an API a page-world extension wraps,
  since `History.pushState (chrome-extension://…)` sits *above* our frame); **at least one**
  location (a location-less rejection pages: our own failed `fetch` rejects with a header-only
  `TypeError`); only the two window traps (`boundary`/`boot` page whatever the stack — an
  extension-only stack there is a real outage, as a 2024 1Password iOS bug proved on another web
  app); an https URL in an extension's message pages; no message lists (Trust Wallet's `Cannot read
  properties of null (reading 'type')` is word-for-word a DWEEB bug). **The client judges the full
  stack and sends evidence, never a verdict.** The wire carries ≤6 lines / ≤800 units and V8 spends
  line 1 on its `Name: message` header, so a multi-line or huge message (zod's pretty-printed
  errors, a `DataCloneError` quoting source code) used to push every frame out and the unattributed
  rule silenced our own Chromium crash — and an extension's frame above ours, with the rest of the
  window naming nothing, would now do the same. So `reporter.ts` judges `topFrames(stack,
  Infinity)` with the *resolved* kind, and `wireStack` promotes the first http(s) location (else any
  non-extension location) into a window that lacks one — head lines, a `... N lines skipped ...`
  marker when any were left out, then that line — budgeted first so no clamp can cut its
  location (a scheme run too long to keep whole is dropped, never front-trimmed, since a trimmed run
  could spell an extension's scheme). The search starts *below* line 1, V8's header, so a frame is
  promoted rather than a message's tail, and line 1 always leads — a header whose only URL lies past
  the window used to send that URL's tail alone. A seeded property test pins "client says ours ⇒
  proxy says ours", `reporter.test.ts` pins the full stack and the resolved kind, and a log-capture
  test (`log_crash`) pins the lines themselves — `INFO … foreign-code error … frames=extension` vs
  `WARN … web app crash … frames=mixed`. Don't replace promotion with a client-set "ours" flag (the
  `shellVerified` pattern): a verdict would freeze each bundle's policy into its beacons for as long
  as the bundle lives in SW caches, where evidence leaves the policy with the proxy. Residue,
  accepted: a pre-promotion bundle's window is its first six lines / 800 units whatever they hold,
  and only locations count, so a single extension frame hides ours whenever the rest of that window
  names nothing of ours — a long or multi-line V8 message, or URL-less lines such as V8's builtins
  (`at Array.forEach (<anonymous>)`) — but a fault of ours hidden that way still pages from every
  current bundle, which judges the full stack and promotes our frame; a later line
  of a multi-line message can be promoted in place of a frame (the verdict is the same); an
  extension that catches our error and throws its own, or an async wrapper whose
  rejection carries only its own frame, is demoted for the visitors running it (the same bug pages
  from everyone else); a V8 header-only `kind=error` (a parse error in a classic script,
  `Error.stackTraceLimit = 0`) still reads as unattributed (pre-existing; Firefox/JSC report it with
  an empty stack, which pages). Add a scheme only on evidence (a page naming it), to both lists
  **and** the vector file — and never http(s): promotion relies on an http(s) location staying ours.
  The client's clamps never split a surrogate pair: the orphan serializes as a `\udXXX` escape
  serde refuses, losing the whole beacon. No deploy ordering (no new field or kind). `clamp_field`
  replaces control chars with spaces so a multi-line stack stays legible in the one-line log
  (`@ @ @ Pk@` instead of the fused `@@@Pk@` that made the first incident cryptic) without
  weakening the log-injection guarantee.
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
- **The boot screen is handed over, not swapped — and it is what paints FCP** (2026-09-10).
  `index.html` ships an HTML-first shell (`<main data-seo-boot>`: the product H1 plus a
  loading line) that paints from the render-blocking stylesheet while the split app chunks
  load. Measured, it is the **FCP element and the first LCP candidate**, so it stays fully
  opaque from the first frame — delaying or hiding it to hide the handoff trades a real metric
  for a cosmetic one. Smooth the *handoff* instead, which is three things. (1) **The shell
  wears the chrome its own surface is about to commit to**: the web app's two pane tones
  (`--app-bg-elevated` | `--app-preview-bg`, collapsing to one below the 900px single-column
  breakpoint), the Activity's flat `--app-bg` splash background. Both surfaces boot the *same*
  document, so an inline, parse-time script stamps `data-surface="activity"` from `frame_id` —
  the same signal `isActivityMode()` reads, a second copy nothing links to the first, pinned by
  `core/activity/bootSurface.test.ts`. Without it half the screen jumped from near-black to
  `#313338` in the frame the editor appeared. The seam is deliberately **ramped** (41%→59%)
  rather than reproduced as the pane divider: the card is centred on the viewport, so a hard
  edge runs straight through the product title. (2) **`mount()` re-parents the shell to
  `<body>` and dissolves it** there over the already-rendered app (`dismissBootShell`) rather
  than deleting it — a warm load only shows it ~70-200ms, which as a hard cut reads as a flash
  rather than as a page loading. (One exception: a shell that has already become the
  boot-failure notice, `data-seo-boot-state="failed"` — point 7 of the deploy-skew entry — is
  removed outright, since dissolving a failure notice over a live app would flash it;
  unreachable today, as a failed boot never mounts.) It cannot simply stay inside `#root` for the fade: Preact's
  `render` treats a container's existing children as excess DOM it may reuse or remove itself.
  (3) **`.app-bootstrap` fades in after a beat**, like `.gallery-bootstrap__hint` — on a first
  visit it is on screen ~100ms between the shell leaving and the gallery covering it, a third
  flash inside a third of a second. `seo-boot-exit` is the **one animation exempt from the
  blanket `prefers-reduced-motion` collapse** (`global.css`): it is opacity-only, and
  collapsing it leaves the overlay sitting opaque over the mounted app until `animationend`
  lands — ~230ms during the mount task — and then cuts, which is a longer wait ending in a
  harder flash, not what that preference asks for. The delays in (3) are *kept* under reduced
  motion, since a delay is not motion.
- **Deploy skew self-heals — don't page for it.** GitHub Pages caches `index.html` ~10 min
  and every deploy purges the old hashed chunks, so a tab that isn't SW-controlled can hit a
  404 on a lazy `import()` ("Failed to fetch dynamically imported module" — this paged the
  maintainer repeatedly on 0.12.0, first at boot, then post-boot when an open tab's Template
  gallery chunk vanished). Several layers, each with a reason to exist — keep all of them:
  1. **SW precache + `clientsClaim`** (vite.config.ts): the precache protects controlled
     tabs across deploys, and `clientsClaim: true` closes the first-visit hole where the very
     session that installed the worker stayed uncontrolled to its end. Safe with
     `registerType: "prompt"`: an *updated* worker never skips waiting, so it can't activate
     (or claim) under an old tab.
  2. **Boot**: `core/pwa/staleChunkRecovery.ts` (armed first thing in `main.tsx`) recovers a
     failed boot with a short ladder of navigations — since 2026-09-11 run from the boot
     promise's `.catch`, no longer from Vite's `vite:preloadError` (point 7 has the ladder and
     its guards) — recorded per **build** via sessionStorage so it can never loop, and only
     **before** `dweeb:surface-ready` so an automatic navigation can't destroy a user's
     in-progress message. Keep new boot-path dynamic imports inside `bootWeb`/`bootActivity`'s
     awaited chain so that `.catch` sees them. The guard key is `__BUILD_ID__`, not
     `__APP_VERSION__`: package.json has read
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
  4. **Reporting** (`resolveCrashKind` in crashReport.ts + `telemetry.rs`): dropped while a
     boot recovery navigation is in flight; a boundary-handled failure reports as kind
     `stale-chunk`; an unhandled one (or a `boot` failure with no rung left) is escalated
     *provisionally* to `stale-chunk-fatal` and settled by two probes (below, and point 7). The
     proxy logs any stale-chunk message that isn't `stale-chunk-fatal` at **info** (same
     `web_crash` target, still greppable) so routine skew — including the long tail of pre-fix
     SW-cached clients — never pages; `stale-chunk-fatal` stays a warn and pages, because since
     2026-09-11 it means the shell our host serves *right now* is this very build and names a
     chunk it doesn't serve — a broken deploy. Don't "simplify" any of this into an
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
     chunk same-origin (HEAD, `cache:"no-store"`, 4s abort) — and, concurrently, reads the
     live shell (point 7) — and `chunkFailureKind` decides: a **4xx** *and* a live shell whose
     module entry is ours → `stale-chunk-fatal`, pages; 4xx + a different live shell →
     `stale-shell`; 4xx + an unreadable live shell → `shell-unverified`; **200 / an unreachable
     probe / nothing to ask** (Safari's message carries no URL, cross-origin, 5xx) →
     `chunk-unreachable` — the last three all logged at info under the same target. Err toward
     the non-paging kinds — a genuinely broken deploy still pages through every visitor whose
     engine names the URL and whose probes complete. Probe the **unclamped** message: a URL cut by the 300-char cap would
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
  7. **A stale tab is not a broken deploy — the fatal shape needs both probes, a boot can't die
     on "Loading…", and it never navigates more than twice per build (four per tab in ten
     minutes)** (2026-09-11). Two `stale-chunk-fatal`
     beacons paged from ONE tab on build `e699a38eec`, 42 h after `42e4218` replaced it: its boot
     chunks (`flows-*.js`, then `App-*.js`) were long purged, the live shell was fine, and the one
     recovery reload came back on the same stale shell — under a controlling service worker a
     reload, and any `/?…` navigation, is answered from the precache (`SPA_NAVIGATION_ALLOWLIST`
     admits root queries), so a reload can never escape a worker-served shell. The old rule read
     "recovery exhausted + chunk 404" as "broken deploy"; a stale client produces the identical
     shape, and the fatal kind had never once paged for a real broken deploy. Three changes:
     (a) **`stale-chunk-fatal` now requires the live shell to be *this* build.** After the chunk
     HEAD answers 4xx, `probeLiveShell` (reporter.ts) fetches `/?dweeb-probe=<nonce>` with
     `cache:"no-store"` — an unknown query misses the SW precache and a `fetch()` is not a
     navigation, so it reaches the network (but NOT past the Pages CDN, which keys on the path and
     ignores the query; that copy is ≤10 min old, fresh enough) — and compares its module entry
     with this document's first *same-origin* module script (`moduleEntryFromHtml`, an
     attribute-order-tolerant string scan: Vite emits `type="module" crossorigin src=…`; the
     origin check matters because extensions inject `chrome-extension://` module scripts ahead
     of ours, and taking one as "ours" would read every live shell as `different`). Both probes
     run concurrently so the beacon is out within 6 s. `same` → fatal (pages); `different` →
     `stale-shell`; unreadable → `shell-unverified` (its own kind so a probe regression is a
     count, not silence). One bounded residue stays: inside the ~10-minute post-deploy CDN
     window an edge still serving the previous shell answers the probe with that same shell, so
     a visitor who got it (chunks already purged) still pages as fatal although the deploy is
     fine — the pre-existing 0.12.0 class, and nothing client-side can bust the CDN; the
     `build` beside the kind (equal to the sha that was live minutes earlier) says which it was.
     Both new kinds log at info on
     the proxy and already did — `is_routine_stale_chunk` demotes every kind but the exact fatal
     string — so no deploy ordering. Kinds are clamped to `KIND_MAX`=20 by silent truncation;
     `CRASH_KINDS`/`KIND_MAX_LENGTH` and the Rust twin pin every kind's length and that only one
     starts with the fatal string. `scripts/seo/audit.ts` runs `moduleEntryFromHtml` over the built
     `dist/index.html` and fails the build if it doesn't return the manifest's entry: that gate,
     not the paging channel, is where parser/markup drift must fail. Pre-fix SW-cached clients keep
     sending the fatal shape for a stale boot until they update; `build` ≠ the live deploy's sha is
     the triage key. The Gatus `web shell` check (hand-synced config) covers a shell that
     answers non-200 or carries no hashed module entry — a deploy no beacon can report; a shell
     whose entry chunk itself 404s still runs nothing and is reported by nothing, a known gap.
     Server-side classification **learned from beacons** was considered
     and rejected: the proxy has no deploy knowledge, and learning "newest build" from an
     unauthenticated beacon would let one forged POST silence the paging channel. That
     rejection is scoped by those words and does not cover **point 8**, added 2026-09-13, where
     the proxy reads its own configured origin instead and nothing is learned from the POST.
     (b) **The recovery is a ladder run from the boot promise's `.catch`, no longer from
     `vite:preloadError`** (`recoverFromBootFailure` in staleChunkRecovery.ts; both boots in
     main.tsx are caught, and the three speculative imports get side-branch `.catch`es so one dead
     boot is one report, not one per un-awaited promise — never *assign* those, or a 404 becomes
     `undefined` and a different, page-worthy crash). Per build, per tab: step 1 `location.reload()`;
     step 2 "bypass" — unregister every service worker for the origin (web only; other tabs keep
     theirs until they navigate; the app re-registers ~8 s after the next good boot) then
     `location.replace` the same URL plus a `dweeb-refresh=<nonce>` query, built by verbatim string
     surgery on `search`/`hash` (never a `URL` round trip — the Activity's `frame_id`/`instance_id`
     and the share hash must survive byte-for-byte) and stripped again first thing in
     `installStaleChunkRecovery`. Guards, each pinned by a test: a step runs only after a
     read-back-verified `sessionStorage` record (no storage ⇒ no automatic step, as before); a boot
     whose URL carried the nonce never bypasses again; an absolute per-tab cap
     (`MAX_AUTOMATIC_NAVIGATIONS`=4 per 10 min, independent of the build key — two builds both
     failing behind a CDN still serving the old shell would otherwise earn a fresh ladder per
     alternation); never past `dweeb:surface-ready`; only for the stale-chunk message class (a bug
     in the entry boots identically every time); never into the void (the bypass never runs
     offline, and a reload runs offline only under a controlling worker, which may serve it). A
     20 s watchdog — cancelled by `pagehide`, re-triggered by a persisted `pageshow`, i.e. a
     back/forward-cache restore after the user left mid-recovery — hands a navigation that never
     commits back to the notice, otherwise the tab is frozen *and* the reporter muted; it is
     long on purpose, since a slow link's navigation commits late and must not be declared
     stuck. Keep step 1 unconditional (`serviceWorker.controller` doesn't
     prove the shell came from the worker, and a reload preserves a healthy precache) and keep the
     ladder off `vite:preloadError`, which also fires for post-boot lazy failures in the Activity —
     which never dispatches `surface-ready` — and used to auto-reload them mid-session.
     (c) **A boot that cannot be recovered ends in a notice, never a frozen "Loading…"**
     (`core/pwa/bootFailure.ts`): the shell is stamped `data-seo-boot-state="updating"` (its
     loading line says so) while a navigation is in flight, and becomes a `role="alert"` notice
     (`failed`) with one button after — plain DOM and `global.css` classes, since the App chunk is
     exactly what didn't load and the CSP allows no inline handlers; the product H1 is untouched
     (it stays the page's only `<h1>`). Copy says the app has *probably* been updated (an offline
     tab produces the same error); the stale-chunk notice's button is the bypass on demand
     (storage-free, idempotent, disabled until the navigation commits or is declared stuck),
     while the offline and error notices reload in place. The failure reports as kind
     `boot` — a chunk message takes the probe road above, anything else pages as our own crash —
     because the entry never reaches the `ErrorBoundary`. Only a shell still inside `#root` is
     rewritten; once `mount()` re-parents it, it is the app's. `ErrorBoundary`'s generic "Reload
     editor" now reloads in place in the Activity — `assign("/")` dropped `frame_id` and rebooted
     the web surface inside Discord.
  8. **A beacon from a build we no longer serve cannot be evidence about the deploy — and only
     the server can tell** (2026-09-13). Point 7 fixed the *client's* judgement, which fixes
     every client running it and **no other**: the app ships from a service-worker cache and
     `registerType: "prompt"` deliberately never forces an update, so a tab keeps its bundle —
     and its reporter — for as long as someone leaves it open. Two `stale-chunk-fatal` beacons
     paged from `e699a38eec`, a **24-day-old** bundle whose `chunkFailureKind(probe)` took only
     the chunk probe and had no concept of a live shell. Both were genuine: their boot chunks
     (`flows-B2W2FfFo.js`, then `App-DELGwkAR.css` — note the second is the root-relative form,
     which `CHUNK_URL_PATTERNS` does probe) really did 404, while the live shell was healthy and
     seven commits newer. That population never drains, so "wait for clients to update" is not a
     plan and the fix cannot live anywhere a stale client can veto it. The proxy now asks the
     question the beacon could not: `stampBuildMeta` stamps `<meta name="dweeb-build">` into
     `index.html` from the same `__BUILD_ID__` the beacon carries, `server/src/live_build.rs`
     reads it off `FRONTEND_URL` (5 min TTL on success / 60 s on failure, single-flighted by
     holding the cache mutex across the fetch, 4 s deadline, 64 KiB bounded read), and
     `pages_as_broken_deploy` demotes any fatal beacon whose `build` differs to an **info**
     `web app stale client` line naming both builds. Load-bearing: (i) **this is not the
     beacon-learned classification point 7 rejected** — nothing is learned from the POST; the
     proxy fetches its own configured origin, so a forged beacon can at most *claim* to be the
     live build, which pages, which is the status quo; (ii) **every failure fails open to
     paging** — unreachable host, unreadable shell, or a shell older than the marker all answer
     `None` = "don't know" = exactly the old behaviour, so the server change is **inert until
     the web deploy lands and needs no deploy ordering**; (iii) only a beacon that *would* page
     is asked about, so a `BACKGROUND_ONLY_CHUNKS` exemption still decides on its own and spends
     no request; (iv) the marker lives in `index.html`, not a side-car file, because the shell is
     definitionally what visitors receive — a separate file could be fresh while the shell is
     stale; (v) the marker is the one input a **hijacked origin** controls and it is compared
     *and logged*, so both parsers refuse anything not shaped like a build id (a newline would
     forge a log line), the value is `clamp_field`ed like every other field before use, and the
     reader follows **no redirects at all** (`Policy::none()` — the fetch target is
     operator-configured, but a 302 would hand a hijacked origin a blind GET from inside the
     compose network, the same hazard `image_client` guards in activity.rs). Every one of those
     refusals answers `None`, so a hostile origin can only make the channel *louder*.
     **The proxy's answer must never overrule a client's own** (vi): a beacon carrying
     `shellVerified` came from a client that fetched the live shell itself *at crash time* and
     found it to be its own build, which is strictly fresher than our cached read of an
     edge-cached shell — so the build comparison is skipped for it entirely. Without that, a
     cached read up to `FRESH_FOR` + the CDN window stale would speak for **everybody** and could
     silence a genuinely broken deploy globally, which is the opposite direction and a wider
     scope than point 7's per-visitor false page. With it the override reaches only clients that
     had no opinion — every visitor of a broken deploy runs a *current* bundle and therefore sets
     the flag — so the mechanism self-narrows to nothing as old bundles drain, and the only
     residue left is that an old client's beacon may be judged against a ≤~15-min-stale build,
     which for that cohort is not actionable either way. Don't "fix" the residue by trusting the
     beacon's build, and don't try remembering which builds were once live: a 24-day-old build
     was never in this process's memory, which is exactly the case being fixed.
     Marker drift must fail at the **audit**, not through the paging channel —
     `scripts/seo/audit.ts` runs `buildMetaFromHtml` over the built `dist/index.html` and fails
     the build when the marker is missing or still the unstamped `dev` placeholder (both verified
     to fail). Guarded by `live_build.rs`'s parser tests (including a truncation sweep, since the
     bounded read can cut the last tag), the `pages_as_broken_deploy` tests in telemetry.rs, and
     `buildMetaFromHtml` in `crashReport.test.ts`.
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
  **The same rule covers required *strings*, not just structures** (2026-08-18, found by
  feeding the schema layer model-authored payloads through the MCP server): `validateNode`
  reads `TextDisplay.content.trim()` and `validateButton` hands a Link button's `url` straight
  to `containsPlaceholder`, both unguarded — so `{"type":10}` or
  `{"type":2,"style":5,"label":"x"}`, either of which a person can paste into JSON Import,
  threw a TypeError out of the **live** validator (it runs on every keystroke) instead of
  reporting an empty field. `repairStructure` now fills both with `""` — the validator already
  says "Text display can't be empty" and "Link button needs a valid https:// URL" — and both
  derefs tolerate an absent value as the second layer.
- **The validator checks where each component sits, not just its fields** (2026-09-24).
  The import boundary takes any tree, so a button or menu at the top level or directly in a
  Container, a thumbnail anywhere but a Section accessory, a nested Container, or a text
  display in a row used to validate clean and then 400 at Discord on send. `placementIssue`
  (validation.ts) and `placement_issue` (mcp/components.rs) now report `BUTTON_OUTSIDE_ROW` /
  `SELECT_OUTSIDE_ROW` / `COMPONENT_MISPLACED` for each slot (top level, container child,
  section text, accessory, row child), and a misplaced component still gets its own field
  checks. A row child that isn't a button used to be validated *as a button*, so it was
  blamed for a missing custom ID and label instead of for being in the row. **A type the
  schema doesn't know is deliberately not flagged**: Discord adds component types, and this
  code can't know where a new one is accepted, so blocking it could stop a send Discord would
  take — same stance as the MCP module keeping unknown fields. Pinned by 13 corpus cases (one
  per slot, plus the unknown type) and `validateMessage — component placement` in
  validation.test.ts. The discord.js/discord.py code exports still skip a misplaced component
  (their builders can't express one); the Code tab's validation notice now warns about it.
- **An empty mention policy is intentional, never an omitted default** (2026-09-11).
  Discord's webhook/interaction default is user mentions only; the all-types default belongs
  to regular bot messages. `webhookMentionParse` drives both the editor chips and pre-send
  summary. `allowed_mentions: {parse: []}` disables automatic parsing, and an explicit `{}`
  is also preserved through normalization rather than broadened to a missing field. Clearing
  the last chip or allowed ID must retain an explicit empty policy (`mergeAllowedMentions`),
  and JSON/share imports must preserve it. Dropping an empty array made a guide's "no pings"
  example re-enable user mentions when imported. Covered by `mentions.test.ts` and the
  JSON/share round-trip tests in `encode.test.ts`. Silent send suppresses **push**
  notifications, not notification badges; keep the UI and guides precise about that distinction.
- **The MCP server is Rust, and its agreement with the schema layer is generated
  and pinned, never remembered** (`server/src/mcp/`, added 2026-08-18; guide in
  `docs/mcp.md`). It serves MCP over HTTPS at `/mcp` so an AI client — claude.ai's **custom
  connectors**, Claude Desktop, Claude Code — connects with one URL and a Discord sign-in,
  nothing installed. A **local stdio server also existed and was removed** (2026-08-18, same
  day): it needed a checkout, a runtime, and a webhook URL in an env var, which is a
  developer's path in a product aimed at end users — don't reintroduce one. It
  lives inside the proxy because that is where Discord auth, the guild gates, the webhook
  resolution, the entitlement reader, and the short-link store already are; the maintainer
  chose the Rust port over a Bun sidecar (2026-08-18) with the duplication cost stated.
  **Off by default** (`MCP_ENABLED`, and every route including the two discovery documents
  answers 501 while off) — it is a public surface through which an AI client can post to
  people's channels, so a deployment opts in rather than inheriting it.
  **How the duplication is contained, which is the whole design:** (a) **data is
  generated** — `bun run gen:mcp` (inside `bun run build`) writes
  `server/src/mcp/catalog.json` from `src/data/presets.ts` + `limits.ts`: all 36 templates,
  every cap, the core placeholder tokens, the link-plugin prefixes, the share-token
  version. (b) **rules are pinned** — the same script writes `validation-corpus.json`, ~105
  messages with the exact `(code, path)` pairs the TS validator emits, and BOTH sides are
  tested against it (`src/core/schema/corpus.test.ts` + `components.rs`). The generator
  **refuses** to emit a corpus that does not exercise every code the validator can emit, so
  a new rule without a case fails the build, and `web.yml` fails on a `git diff` in
  `server/src/mcp` so a stale catalog cannot be committed. (c) the share-link encoder is
  pinned the same way (`lz-vectors.json` → `lz.rs`). **Change a rule, a limit, or a
  template ⇒ `bun run gen:mcp`, then expect both suites to move together.**
  Traps worth knowing: character limits are **UTF-16 code units** (JS `.length`), so
  `chars().count()` lets a message of emoji through at twice the cap and `len()` rejects one
  at half — pinned by the `astral-characters-*` cases; LZ-String is likewise defined over
  UTF-16 units, so a `chars()`-based port yields links the browser cannot decode for any
  message with an emoji; the corpus is sorted in **code-point** order, never
  `localeCompare` (locale- and ICU-dependent, so Rust could not reproduce it). One
  deliberate boundary divergence: a Section with no `accessory` is **reported**
  (`SECTION_ACCESSORY_MISSING`) rather than refused, because a model handed that can fix its
  payload — the TS boundary throws instead, and the corpus records the Rust behaviour.
  **Auth**: OAuth 2.1 with **Discord as the identity provider** — `/oauth/authorize` hands
  the browser to Discord and the `mcp_` state prefix routes the callback back
  (`auth.rs`, same dispatch the Activity connect flow uses), with the whole request sealed
  inside `state` because the connector's browser carries none of our cookies. PKCE S256 is
  mandatory, `plain` is not offered, and **there are no refresh tokens** (ours could not
  refresh Discord's, so an expired grant means re-authorizing, which is silent while the
  Discord session lives; a token's life is capped at the Discord token's). An error raised
  **before** the redirect URI is verified renders as a page — redirecting one to an
  unverified URI is how an open redirector is built. Every call then acts with the user's
  own Discord token through `authorize_member_session` / `authorize_activity_webhooks`, so
  a caller reaches exactly what that person can and **no webhook URL ever leaves the
  server**. `mcp.db` stores digests only, with the Discord token sealed under its own AAD
  domain. The transport is **stateless** (POST only; GET/DELETE are 405) because the server
  sends nothing unsolicited — that is what lets it survive a redeploy mid-conversation.
  **No Caddy change is needed** (the `{$DOMAIN}` catch-all already routes `/mcp`,
  `/oauth/*`, `/.well-known/*`). Wiring checks that no unit test can reach live in
  `server/ops/mcp-smoke.sh`, which drives the real binary over HTTP and runs in `server.yml`.
  **Gatus watches the discovery document** (`server/gatus/config.yaml`, live 2026-08-18),
  asserting the `resource` field rather than only a 200: a wrong `MCP_PUBLIC_URL` still answers
  200 while handing clients an issuer that doesn't match where they connect, which reaches the
  user as an opaque connector failure with nothing in our logs. **That monitor is only valid
  while `MCP_ENABLED` is on** — with the feature off the endpoint answers 501 by design and it
  pages forever, so comment it out if MCP is ever switched off. Gatus's config is a hand-synced
  bind mount (copy in place, `docker compose restart gatus`).
  **The feature is surfaced in the app** by "Connect an AI client" in the builder's More menu
  (`features/mcp/ConnectAiDialog`), which hands over the connector URL and the local setup
  command with copy buttons. The URL is **derived from `PROXY_BASE_URL`**, never hard-coded, so
  a self-hosted build advertises its own address; the entry is gated on the proxy reporting
  `mcp: true` (`core/mcp/availability`, same shape as feedback/avatar uploads) because handing
  someone a URL that answers 501 sends them through a connector setup that cannot work and reads
  as their mistake. Keep it a lazy surface inside a `ChunkErrorBoundary` like every other dialog.
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
  page). The config UIs branch on `!res.ok` and render `data.error`, so the copy is unchanged.
  When adding a plugin route, ask "would an ordinary user action reach this branch?" — if yes it
  is 4xx, never 5xx.
  **`Network` was then split by what actually failed** (2026-09-09), because a blanket
  `Network → 502` paged the maintainer on 2026-08-20 for a self-role connect on which Discord
  merely took longer than the 2200 ms client deadline — nothing anyone could act on. Now, in all
  six bot-token plugins (self-role, tickets, giveaway, poll, quick-replies, directory):
  `Timeout` (Discord took the request, didn't answer in time) → **504**, `Upstream` (Discord
  answered 5xx, dropped the connection, or cut the body off) → **503**, and `Network` → **502**
  means we couldn't even *connect* (DNS, refused, TLS) or the reply isn't the shape we expect —
  this host's network or our code. Each crate's `trace::on_failure` (replacing tower-http's
  default on the `TraceLayer`) logs **503/504 at WARN** (`upstream failed`, never pages) and
  every other 5xx at ERROR with the exact line tower-http emitted, so `dweeb-alerts` and every
  grep still match. Two traps: `is_connect()` is checked **before** `is_timeout()` (a connect
  timeout answers true to both and is a dial failure, i.e. ours — same ordering as the
  dispatcher's forward hop); and reqwest reports both a body cut off mid-read and a body serde
  refuses as `is_decode()`, so `body_error` looks at the error's *source* — only a
  `serde_json::Error` is ours. Guarded by `only_our_own_faults_page` +
  `transport_failures_are_split_by_what_actually_failed` (real sockets: a stalling server, a
  refused port, a non-JSON 200, a truncated 200) in each `rest.rs` and the `trace.rs` test.
  A plugin never emits 503/504 for its own faults, which is what makes the status-based rule
  safe there; the proxy has own-fault 503s (`/ready`, the avatar row cap) and so marks the
  fault on the response instead — see the entry below.
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
  **Over HTTP/3 a client hang-up is spelled `Application error 0x100 (remote)`** (0x100 =
  H3_NO_ERROR, "closed, nothing wrong") or, generically, `APPLICATION_ERROR (remote)`, and it
  paged eleven times between 2026-08-20 and 2026-09-03 — every one an `HTTP/3.0` GET of an
  ordinary app route (`/api/capabilities`, `/auth/me`, `/api/guilds/…/library/origin/…`) from
  Firefox/iOS Safari, ~2.0 s long, status 502. Two Caddy (v2.11.4) behaviours conspire: it
  recognises a downstream cancel only as Go's `context.Canceled` / "operation was canceled"
  (`statusError`, `proxyLoopIteration`), and quic-go cancels the request context with the QUIC
  close as the *cause*, which is neither — so Caddy treats it as an upstream failure, **retries
  the GET** (its default `lb_retry_match` for non-dial errors) every 200 ms against a client
  that is gone until `lb_try_duration` (2 s) runs out, then logs a synthesised 502 at ERROR.
  The ~2.0 s durations are that retry window, not backend latency. `CONN_ABORT_RE` now drops
  both spellings; the `(remote)` anchor is load-bearing — a `(local)` application error is
  *our* side aborting and still pages. Don't "fix" this by disabling GET retries: they are what
  let an in-flight GET survive a container restart. **`dweeb-alerts` must also parse past the
  request span** (2026-09-09): tracing renders the proxy's span *before* the target —
  `ERROR http{method=… path=… error=…}: tower_http::trace::on_failure: response failed …` —
  and the old `TRACING_RE` took `http` as the target and threw the braces away. So every proxy
  502 page since 2026-08-12 still read `latency=… ms` with no route (the fields were in the
  journal, never in the alert), and worse, `web_crash` warns — whose real target sits after the
  same span — stopped matching `startswith("web_crash")`, so **FE crash beacons silently
  stopped paging from 2026-08-12 to 2026-09-09**. The parser is now three-part (`TRACING_HEAD_RE`
  → leading `SPAN_SEG_RE` segments, fields kept → `TARGET_RE`); an ERROR alert reads
  `method=GET path=/api/… error=…  response failed classification=… latency=…` (fields first, so
  they survive the 280-char clamp), and a span whose field value contains a brace is left
  unstripped rather than dropped. `--parse-test` runs the classifier over real prod lines
  offline; run it on the host before restarting the service (see the README).
  Three refinements from the adversarial review (2026-09-10): the HTTP/3 mute is
  **duration-gated** (`H3_ABANDON_MAX_SECS`, 15 s — a pure hang-up's fingerprint is
  `duration` ≈ the 2 s retry window, so a client that gave up on a request our upstream had left
  unanswered for far longer *pages*, naming method + path, never the query); the generic
  `APPLICATION_ERROR (remote)` spelling is a close that arrived before the handshake completed
  and carries no code, so it also covers an early close with any code; and the mechanism is a
  property of the pinned stack (Caddy v2.11.4, quic-go v0.59.1, Go 1.25 — quic-go ≥0.60 turns it
  into a scheduling race, so a partial recurrence after an image pull is not a new bug; the
  Caddyfile's `upstream_retry` comment now states the real retry rule). Because every
  Discord-side failure is now a WARN, **the alerter pages once on a sustained one**: ten
  `upstream failed` warns from one service within five minutes post a single `UPSTREAM STORM`
  alert (`ALERTS_UPSTREAM_BURST_COUNT/_SECS`), muted like any signature, so an outage reads as one
  page plus "still occurring ×N". A `web_crash` behind a *fieldless* span (tracing renders it as
  a bare `name:`) is also recognised, and `request_span` documents that it must always carry a
  field.
  **No content match may be evaluated ahead of the level — a demoted line must be unpageable**
  (2026-09-13). `classify` tested `PANIC_RE` *first*, before `TRACING_HEAD_RE` had even read the
  level, so the match ran against every line the services emit at every level. That is a hole
  straight through the whole demotion strategy: `/api/telemetry/crash` is **unauthenticated** and
  its `info` branches render the beacon's `message=`/`stack=` **verbatim**, so a visitor whose
  error text happened to contain "panicked at" paged as `PANIC` despite the proxy having
  deliberately logged it at `info` — and anyone could fire a page on demand by POSTing one.
  `NON_PAGING_LEVEL_RE` now skips the panic check for `INFO`/`DEBUG`/`TRACE` lines only. The
  check stays a *content* match, which is safe precisely because a real Rust panic is written by
  the panic hook straight to stderr with **no tracing prefix at all** and therefore matches no
  level; ERROR and WARN are untouched and still page on panic wording. Anything added to this
  file that decides by text — a new keyword, a new service's format — must sit **after** the
  level parse for the same reason. `--parse-test` covers all three demoted levels, an unprefixed
  real panic, and an ERROR mentioning one (verified to fail 3/3 without the fix); its printed
  total is now counted from the assertions rather than a hand-maintained `+ 7` that had drifted
  and reported 27/27 for 28. Remember this file is **hand-scp'd, not CD-deployed** — run
  `--parse-test` on the host before restarting the service.
- **A 5xx pages only if it is ours — the proxy marks a dependency's transient failure
  `Fault::Upstream`** (2026-09-09). Nine proxy 502s paged between 2026-08-23 and 2026-09-05
  (`latency=10002/10001/10551 ms` = Discord not answering a JSON read inside the ten-second
  client deadline; `14077` = a rate-limit wait then a timeout; `122/323` = a fast Discord 5xx
  or a dropped connection), and not one was actionable. `error::Fault` is the alerting
  decision: `AppError::into_response` attaches it to every 5xx as a response *extension*,
  `trace::FaultClassifier` (which replaces `TraceLayer::new_for_http()`'s classifier) reads it
  back, and `trace::on_failure` logs `Ours` at ERROR — byte-for-byte tower-http's line, under
  its target — and `Upstream` at **WARN** (`upstream: upstream failed classification=… latency=…`,
  inside the request span, so it still names the route and the recorded `error`). **Statuses
  are untouched**: the caller still gets its 502, message, and `Retry-After`. What is upstream:
  `discord.rs`'s `transport_error` (a reqwest error that isn't `is_connect()`/`is_builder()`),
  `body_error` (a 2xx whose body died mid-read — but a body serde refuses is *ours*, found via
  the error's source since reqwest reports both as `is_decode()`), and `status_error` (Discord's
  own 5xx; an unexpected 4xx is our malformed request, ours), via `AppError::gateway(fault, msg)`
  / `AppError::upstream(msg)`. Two traps the adversarial review closed (2026-09-10): the Discord
  client now sets a **`connect_timeout`** (5 s), so a black-holed dial reports as `is_connect()`
  — ours, paged — instead of a bare total timeout filed as Discord's; and the message is built by
  `describe`, which **strips the request URL** (reqwest's `Display` appends it, and eight of these
  calls carry `/webhooks/{id}/{token}` — the span's `error` field now reaches Discord) and
  flattens the `source()` chain instead, the dispatcher's own lesson (pinned: no message may
  contain `for url` or the peer address). The Activity plugin relay marks a plugin's **503/504
  as `Upstream`** on the way through (`relayed_response` — those are the plugins' "Discord, not
  us" statuses, and relayed bare they would page as ours). Deliberate capacity 503s (upload
  permits, AI budget/busy, row caps) are `AppError::Status` and still page as ours — a decision
  not taken here, recorded as such. What still pages, deliberately: a rejected bot token (401), the
  bot lacking guild access (403), the dispatcher or one of our own allow-listed plugin hosts
  unreachable, a Discord connect failure (this host can't reach discord.com at all) or a DNS
  failure with no earlier answer to fall back on (a merely *stalled* lookup no longer fails the
  dial — next entry), Stripe,
  every `Internal`, and the AI relay's `Unavailable` (kept a paging 502 per the 2026-08-01
  decision — flip `terminal_error`'s `Unavailable` arm to `AppError::Upstream` if that ever
  proves noisy). A bare `StatusCode::INTERNAL_SERVER_ERROR.into_response()` carries no marker and
  is treated as ours. No deploy ordering — nothing here is a contract with the FE or the
  alerter. Guarded by `error.rs` + `trace.rs` tests and `discord.rs`'s `fault_tests`, which pin
  the reqwest classification against real sockets rather than our reading of its docs.
- **A DNS stall is the host's, not Discord's — the Discord client dials the last good answer
  through it** (`server/src/dns.rs`, 2026-09-13). A page read `GET /api/guilds/…/webhooks
  error=could not reach Discord: … client error (Connect): operation timed out … latency=5001 ms`
  while Discord was fine: a second earlier dockerd had logged `[resolver] failed to query external
  DNS server … 127.0.0.53:53: i/o timeout question=discord.com`. Containers resolve through glibc
  (no cache) → Docker's embedded DNS (no cache; **abandons a forwarded query after 4 s**) → the
  host's systemd-resolved (caches only for the TTL; on systemd 255 it re-sends an unanswered UDP
  query only after a **fixed 5 s**, `DNS_TIMEOUT_USEC` = 120 s / 24 attempts) → the VPS provider's
  two resolvers. So one dropped datagram stalls every lookup behind it past 4 s, and the Discord
  client's 5 s `CONNECT_TIMEOUT` — which covers DNS + TCP + TLS — is spent by the lookup alone.
  The journal held **61 such stalls in 8 days** (7 for discord.com; `resolvectl statistics`
  counted 76 upstream timeouts), and the same stall failed a quick-replies config connect four
  minutes later (504 at 2501 ms). `ServeStaleResolver` (RFC 8767 "serve stale") is now the Discord
  client's `dns_resolver`: every dial still looks its host up and an answer always wins, but after
  `DNS_FRESH_WAIT` (1 s — healthy lookups measured 4–29 ms, stalls are ≥ 4 s) with no answer, or on
  an outright failure, it dials the address from the last good lookup (at most `DNS_MAX_STALE`,
  24 h, old), logged at **info** under target `dns`, and the lookup keeps running on its own task
  so a late answer still refreshes the memory. Safe because **TLS verifies the certificate against
  the name on every connection**: a stale address can fail to connect, never reach anyone else.
  With nothing remembered (a fresh process) a stall still fails the dial and **still pages** — it
  is our host's resolver — but at `DNS_DEADLINE` (4 s, inside the connect timeout) as `dns error:
  no answer for discord.com within 4s, and no earlier answer to fall back on` rather than a bare
  "operation timed out" that points at the network or Discord. A `const` assert pins
  `DNS_FRESH_WAIT < DNS_DEADLINE < CONNECT_TIMEOUT`. Don't answer a recurrence by raising
  `CONNECT_TIMEOUT` past the stall (every stall becomes a 5 s+ wait, and this one outlasted glibc's
  retry — its second query timed out too) or by demoting connect failures to `Upstream`. Only the
  Discord client needed this: the scheduler (15 s total) and the AI relay (10 s dial) ride a stall
  out late instead of failing, but the plugins' 2.2–2.5 s clients can't, and those are the host
  resolver's to fix (`AGENTS.local.md`). Diagnose on the host with
  `journalctl -u docker.service | grep 'failed to query external DNS'`, and in the proxy's journal
  with `grep ' dns: '`. No deploy ordering. Guarded by `dns.rs`'s paused-clock tests and
  `discord.rs`'s `a_dns_stall_dials_the_last_good_address` /
  `a_cold_dns_stall_pages_as_ours_and_says_it_was_dns`, both verified to fail without the fix.
- **A failed forward must name what failed, and nested deadlines must not be equal**
  (2026-08-15). A page arrived reading, in full, `forward failed prefix="selfrole:"
  upstream=http://self-role:8092 err=error sending request for url (…)`. That sentence is
  reqwest's `Display` for **every** transport failure — a refused dial, a DNS blip, our own
  deadline, a connection dying mid-flight all print identically, with the real reason left in
  the `source()` chain, which was never printed. Unattributable, and the four classes want
  opposite handling. Three things changed in `plugins/dispatcher/src/main.rs`:
  1. **Classification + cause.** `classify_forward_failure` splits `Dial` / `Timeout` /
     `Broken` (checking `is_connect()` **before** `is_timeout()` — a *connect* timeout answers
     true to both and belongs with the dial failures), and `forward_detail` logs the flattened
     `source()` chain — "client error (Connect): tcp connect error: Connection refused (os
     error 111)". It prints the chain **or** reqwest's own Display, never both: the Display
     only repeats the `upstream` field, and `dweeb-alerts` samples at 280 chars cutting the
     *tail*, which is exactly where the specific reason sits. Control chars become spaces and
     the chain is clamped at `MAX_CAUSE_CHARS`, same reasoning as the proxy's `clamp_field`.
  2. **A dial is retried; nothing else ever is.** This is the one hop Caddy's `upstream_retry`
     cannot cover — the dispatcher reaches plugins directly over the compose network — so a
     plugin container recreate used to page exactly as a deploy once did through Caddy. Retry
     is safe **only** because a failed dial means nothing reached the plugin, so an interaction
     cannot be processed twice; a connection that dies *after* the request was written may well
     have been acted on, and re-sending would double-toggle a role or double-enter a giveaway
     (hyper already retries the one safe variant — a pooled connection closed before we wrote —
     so what survives to `Broken` is precisely what must not be repeated). `should_retry_dial`
     is the guard and is tested against every class. Each attempt gets only
     `FORWARD_BUDGET - elapsed` as its deadline, so retrying can never push the reply past the
     wall the hop started with, and `connect_timeout` bounds a black-holed SYN so one attempt
     can't drain the budget. A recovered dial logs `info`, never `warn`.
  3. **Log level by fault.** `Dial` exhausted across the whole window = the plugin is genuinely
     unreachable = our infrastructure = **ERROR, pages** (same stance as `upstream_retry`: a
     real outage still pages). `Broken` is unclassified and unexpected = **ERROR, pages**.
     `Timeout` = the plugin took the request and a slow/rate-limiting Discord behind it ran
     long — not actionable, self-heals — so **WARN, never pages**; a plugin genuinely *wedged*
     rather than merely slow still pages from the monitor that can tell the difference, Gatus
     probing each plugin's own `/health` every 120s. The member-facing copy also splits: a
     timeout says "check whether it went through before clicking again", because the plugin may
     have completed the action after we stopped listening and "try again" would undo a toggle.
  **The nested deadlines were equal, so the outer one always lost.** The dispatcher gave the
  forward 2500 ms and *every* plugin gave its own Discord REST calls 2500 ms — but the inner
  clock starts later, so any Discord call running near its limit guaranteed a forward timeout:
  the member saw "the plugin didn't respond" for a click that had *worked*, and it paged. Plugin
  clients are now **2200 ms** (`self-role`, `tickets`, `giveaway`, `poll`, `directory`,
  `modal-form` — the ones whose client is on the interaction path; `quick-replies` stays at 2500
  because its client is config-time only, and `picker` has none), and two `const _: () =
  assert!(…)` in the dispatcher enforce the ordering at compile time rather than leaving it as
  prose. **An inner deadline must always be strictly smaller than the outer one that waits on
  it**, so the fault is reported by the component that knows what it was — the same principle
  as the entry below. No deploy ordering: nothing here is a contract between the two.
- **A 502 must name its route, and a reqwest deadline must not become a bandwidth
  requirement** (2026-08-12). A page arrived reading, in full, `response failed
  classification=Status code: 502 Bad Gateway latency=10002 ms` — no method, no path, no
  reason, and one occurrence in 21 days. `TraceLayer::new_for_http()`'s stock span
  (`DefaultMakeSpan`) does record method and URI, but at **DEBUG**, and the deployed filter
  is `info`, so the fields never reach the log. `main.rs`'s `request_span` replaces it at
  INFO with `method` + **`path` only — never the query**, because these lines are forwarded
  to Discord by `dweeb-alerts` and `/auth/callback?code=…` carries a live OAuth code (no
  route embeds a credential in its *path*; ids only). It also declares an empty `error`
  field that `AppError::into_response` records **for 5xx only**, so the reason lands on the
  same line as the classification instead of living only in a response body no operator
  sees. Note the side effect: every log line emitted during a request now carries that span
  prefix — the documented `web_crash` / `activity_handshake` greps still work, since they
  match the target.
  The `10002 ms` was un-attributable because **two** subsystems had ten-second deadlines,
  and both were wrong in a different way. (1) `Discord::http` set reqwest's `.timeout()`,
  which is a **total** deadline covering the request body — so the flat 10s was silently a
  bandwidth floor on the multipart calls. `/api/activity/post` and `/api/activity/edit`
  accept **32 MiB** and are deliberately exempt from the inbound `TimeoutLayer` because a
  large attachment legitimately takes a while to arrive, and the proxy then gave itself ten
  seconds to forward those same bytes (~27 Mbit/s sustained to Discord's ingest — usually
  fine, which is why it failed rarely rather than always). The user's post failed *and* it
  paged. `upload_timeout(bytes)` now sizes the per-request deadline as the base allowance
  plus the body at a pessimistic 1 MiB/s floor (~42s at 32 MiB) — still bounded, so a stuck
  transfer can't hold the connection open. Don't put a flat `.timeout()` back on a call that
  carries files. (2) The Activity **image proxy** answered 502 for the remote host's
  behaviour: it is unauthenticated by necessity (an `<img>` can't send a bearer) and fetches
  whatever URL someone pasted, so a typo'd link, a lapsed domain, a host that 404s or
  geo-blocks the VPS each paged the maintainer over a message that was merely missing a
  picture. Those branches are now 4xx via `unreachable_target`, matching the 400 the same
  handler already returned for a URL that fetches fine but isn't an image, and costing the
  caller nothing (an `<img>` renders the same broken placeholder for any non-2xx). The split
  is by **fault, not by handler**: `ensure_public_host` takes a `UrlOwner`, so an
  unresolvable host is 4xx for a pasted image URL and stays a paging **502** for one of our
  own allow-listed plugin hosts — and the plugin relay's other 502s are left alone, since a
  registry-allow-listed host being down really is our infrastructure. Server-only, no deploy
  ordering (the FE only ever builds the image URL as an element `src`). Guarded by
  `an_upload_deadline_covers_the_transfer_not_just_the_reply` in discord.rs, the
  `*_never_our_server_error` / `our_own_*` pair in activity.rs, and
  `a_paging_failure_names_the_route_and_reason_but_never_the_query` in main.rs.
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
  Keep `templateLastmod()` in `scripts/seo/content.ts` honest too: unchanged template pages retain
  the stable catalogue baseline, while a meaningfully revised template gets a dated override;
  `TEMPLATES_LASTMOD` is the newest child date used by the catalogue hub.
  Check `scripts/seo/features.ts` and `video/src/data.ts` references, and regenerate
  committed OG images with
  `bun add -d sharp && bun scripts/gen-template-og.ts && bun remove sharp` (run from the
  repo root; expect the new card **plus** `templates-og/templates.png`, the catalogue hub
  card, to change — every other card stays byte-identical).
- **SEO changes are driven from Search Console, and three mechanisms exist because of what it
  showed** (2026-09-16; the GSC/GA MCP servers cannot see DWEEB's properties — read them through
  the maintainer's signed-in browser, ids in `AGENTS.local.md`). The 3-month picture: 328 clicks
  / 7.16K impressions / avg position 19.3, rising; `/` wins the "components v2 builder" family at
  position 4–7 with 12–27% CTR (leave it alone), while the **server-rules cluster** was the largest
  untapped one — `/templates/discord-server-rules-template/` had ~1,000 impressions at position
  22–50 and 0.5% CTR across "discord server rules template", "discord rules copy and paste" and
  ~60 variants, because searchers want pasteable rule *text* and a six-rule preview card never
  satisfied that. (1) `/guides/discord-server-rules/` carries that text (five full rule sets,
  add-ons, formatting, Rules Screening); the template page keeps the visual card and they
  cross-link — don't merge or redirect one into the other. (2) **Every template page carries a
  "Read next" guide row** (`TemplateSeoOverride.guides`, default `DEFAULT_TEMPLATE_GUIDES`,
  resolved against `GUIDES` by the generator, which throws on an unknown slug): the three newest
  guides sat "Discovered – currently not indexed" two months after publication while template
  pages are the most-crawled detail pages, so this is the guide cluster's inbound ring — keep it
  when restyling template pages. (3) **A retired URL gets a redirect stub, never a bare 404**:
  `LEGACY_REDIRECTS` in `gen-template-pages.ts` writes a `noindex` zero-delay `meta refresh` +
  canonical stub (GitHub Pages cannot 301; a zero-delay refresh is the redirect signal Google
  documents for static hosts, and `noindex` is what lets the audit's orphan check accept an HTML
  file outside the sitemap). `/templates/discord-onboarding-panel/` (template retired in
  7e5288e) was still earning impressions as a 404 — add the next retired slug there. Two things in
  the indexing report are *correct* and need no fix: the `/?entry=…` / `/?template=…` rows under
  "Page with redirect" / "Crawled – not indexed" are the pre-fragment CTA form and non-canonical
  by design, and the 13 RoleLogic role templates being un-crawled is crawl-budget prioritisation
  on a young domain, not a markup fault. The audit warns on titles over 65 characters and
  descriptions over 160 — keep new copy under both, since Google truncates around there anyway.
- **Guides quote Discord's error messages verbatim, can carry an FAQ and an interactive tool,
  and the timestamp reference covers all nine styles** (2026-09-23 pass; Search Console +
  Bing Webmaster Tools read through the maintainer's signed-in browser). Growth was real —
  impressions tripled in two weeks (~550/day, average position 25 → 8) — but the guides that
  took most of it earned almost no clicks: `/guides/discord-webhook-forum-threads/` (~370
  impressions at 7.4, 0.8% CTR) and `/guides/discord-webhook-errors/` (214 at 7.4, zero clicks),
  both fed by anonymized long-tail queries whose named members were **pasted error text**
  ("webhooks posted to forum channels must have a thread_name or thread_id", "discord api error
  400", "missing permissions") that neither page ever printed. (1) **Error pages now quote each
  message exactly** — the API's own casing ("Unknown Webhook", "Missing Permissions", "Invalid
  Form Body"), the nested Components V2 codes (`MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2`,
  `UNION_TYPE_CHOICES` = V2 components sent without flag 32768) and the discord.js /
  discord.py renderings (`DiscordAPIError[50013]: Missing Permissions`, `403 Forbidden (error
  code: 50013)`). Verify a new string against Discord's docs or a real response before adding it;
  a paraphrase matches nothing anyone searches. Deliberately left out as unverified: what
  triggers 220004, and whether the `/github` endpoint accepts `thread_id` for a forum channel.
  (2) **`GuidePage.faq`** renders a visible FAQ and `FAQPage` JSON-LD from one array, like the
  landings; answers are plain text (they are the schema text, so no inline links). (3)
  **`GuidePage.tool`** adds an interactive block above the table of contents. Its script is a
  `scripts/seo/tools/*.client.ts` that imports straight from `src/` and is bundled by
  `tools/bundle.ts` with **Bun.build** at generation time (the generator already runs under Bun;
  bun-types is not a dependency, hence the typed shim) — never a hand-written copy under
  `public/`, which would drift from the editor. The tool's static markup must be a complete worked
  example on its own (no-JS readers and non-rendering crawlers get the reference table), and
  `artifact-audit.ts` now fails any generated page whose first-party `<script src>` is missing.
  The first tool is the Discord timestamp generator on `/guides/discord-timestamp-format/`
  (retitled around it), built from the same `features/preview/markdown/timestamp.ts` the preview
  and the toolbar picker use. (4) **Discord has nine timestamp styles** — `s` (short date, short
  time) and `S` (short date, medium time) joined the original seven; the preview parser used to
  accept only `[tTdDfFR]`, so `<t:…:s>` rendered as raw text in DWEEB while Discord showed a
  date. `t`/`T` are Intl's `timeStyle` short/medium — Discord's own names, and the same short time
  `f` ends with (a forced 2-digit hour read "09:05 AM" beside `f`'s "9:05 AM"). (5) **A
  `.table-scroll` is `position: relative`**: an absolutely positioned `sr-only` header at a wide
  table's far edge otherwise escapes the scroll container's clip and widens the whole page on a
  phone (found at 390px; mobile-first indexing reads that layout). (6) The welcome-message cluster
  (~20 "copy and paste" variants landing on the template page) got `/guides/discord-welcome-messages/`,
  the same guide-carries-the-text / template-carries-the-card split as the rules pair, which moved
  the rules template from position ~28 to ~10 within a week of 2026-09-16.
- **Static discovery is a build contract.** `scripts/gen-template-pages.ts` generates the
  template and feature catalogues, `/guides/*`, the product landing pages, and the image
  sitemap. Build-critical generator code is covered by `tsconfig.seo.json`; `bun run build` then
  runs `scripts/seo/audit.ts`, which fails on broken sitemap
  targets/internal links, duplicate or missing metadata, invalid JSON-LD, missing/wrong-size
  social cards, stale/future dates, inconsistent WebSite entities, crawlable app-state queries,
  manifest-derived critical request/transfer budgets, rendered-H1 regressions, late charset
  declarations, thin detail pages, and orphaned templates. Add new discovery routes to that
  generator rather than hand-writing unverified
  files in `dist/`; keep source-backed guide claims and `lastmod` dates honest.
  **Reference artifacts come from the same sources as the tool** (2026-09-11).
  Each template ships a visible JSON disclosure and a downloadable `message.json` derived
  through `encodeJson`, with component/text counts from the schema traversal. Those examples
  are starting points: plugin custom IDs and server placeholders are not configured by a
  download. `scripts/seo/discovery.ts` generates `dist/llms.txt` from the live catalogues;
  do not restore a separate handwritten public copy. It is an agent directory, not a Google
  ranking mechanism. `artifact-audit.ts` verifies local downloads, section anchors, duplicate
  IDs, example/export agreement and the directory's targets. The generator also creates
  `404.html` **before auditing**: it preserves every executable app/short-link bootstrap script,
  but declares `noindex` and removes canonical/schema claims. Never restore CI's post-audit
  `cp index.html 404.html`. Pages still supplies the real HTTP 404 status.
  Built-in preview media has WebP display variants (2026-09-11):
  `defaultMediaPreviewUrl` rewrites only exact entries in `DEFAULT_MEDIA`, in image renderers
  before Activity proxy resolution. Message JSON, posted URLs, file downloads and arbitrary
  user URLs keep their originals. Keep the JPEGs: existing Discord posts hot-link them.
  Regenerate with `bun add -d sharp`, `bun scripts/gen-preview-media.ts`, then `bun remove sharp`;
  commit the WebPs and `scripts/seo/manifests/preview-media.json`. The artifact audit rejects
  missing, stale or larger variants. This reduced the 14 samples from 433,676 to 78,056 bytes
  without changing dimensions or the app's preview layout.
  Rated software must define its zero-price `Offer`, category and OS on the same page as
  its visible aggregate (`ratingLd` in layout.ts). A shared app `@id` does not make Google's
  software rich-result validator fetch missing required fields from the home page. The audit
  checks that local offer whenever a rating is emitted; the existing publication threshold
  and visible-rating gate still apply.
  `bun run seo:lighthouse` adds a three-run mobile median over `/` and
  `/discord-message-builder/`; `web.yml` runs it after the build and gates Performance,
  Accessibility, Best Practices, SEO, LCP, TBT, and CLS. Keep `lighthouserc.json` in the workflow's
  path filter, and treat local single runs as diagnostics rather than field Core Web Vitals.
  **The lazy intro film is not a root `VideoObject`** (2026-08-20). Google requires an indexed
  video to be embedded and prominent without a user action; DWEEB mounts the opt-in film only
  after More → Watch intro, so root video schema claimed eligibility the page did not satisfy and
  was removed. Keep the film lazy. Add video schema only with a dedicated crawlable watch page
  whose visible primary content is the player. `DATETIME_PROPERTIES` in `audit.ts` remains the
  guard for any future datetime-typed schema: those values need a full ISO datetime + timezone;
  `datePublished`/`dateModified` remain legitimate date-only values.
  Landing pages are a catalog (`LANDINGS` in `scripts/seo/guides.ts`, rendered by
  `renderLandingPage`) — currently `/discord-message-builder/`, `/discord-webhook-builder/`
  and `/discord-embed-builder/`.
  **Adding a guide or landing** = entry in `GUIDES`/`LANDINGS` + its slug in `ENTRY_IDS`
  (`src/core/seo/acquisition.ts`, else the audit fails the CTA token) + a committed OG card via
  `bun add -d sharp && bun scripts/gen-template-og.ts --guides-only && bun remove sharp`
  (guide/landing cards only; output is deterministic, untouched cards stay byte-identical).
  The run also refreshes `scripts/seo/manifests/guide-landing-og.json`, which pins the SHA-256 of
  every source SVG and emitted PNG; a copy change without a regenerated card must fail the SEO
  audit. Root `og-image.png` is pinned separately by `scripts/seo/manifests/root-og.json`; regenerate
  it without touching icon bytes via
  `bun add -d sharp && bun scripts/gen-assets.mjs --og-only && bun remove sharp`.
  Bump `GUIDES_LASTMOD` when guides change — the audit fails a hub whose lastmod is older
  than its newest child, and bump a guide's `modified` when its visible content (including
  related-link cards) changes. A **landing** carries its own `modified` instead (added
  2026-08-19): landings are revised independently of the guide cluster, and since the audit
  cross-checks JSON-LD `dateModified` against the sitemap `lastmod`, one shared constant
  would either claim freshness for an untouched page or under-report a revised one.
  A landing may also carry an optional `faq`, which renders the shared `faqSection` **and**
  `FAQPage` JSON-LD from the same array — never add schema Q&A a reader cannot see on the page.
  The primary message-builder landing carries responsive 1280×680 and 768×408 WebP product views
  through the optional `productImage`; keep their intrinsic dimensions/srcset, sitemap entry,
  descriptive alt text, and transfer budget together. `/about/` is the crawlable Faizo
  author/profile and preview-test methodology page; guide/landing bylines and the canonical
  Person entity point there.
  `SITE.alternateNames`/`description` in `scripts/seo/content.ts` define the canonical WebSite
  identity for generated pages; root `index.html` must mirror them exactly because the audit
  compares every definition of `#website`. Do not let old keyword positioning survive on one
  section of the site as a conflicting entity.
  **`/` and `/discord-message-builder/` deliberately target the same head term**
  (2026-08-19). "Discord message builder" is how people search for this product, so the home
  page leads with it in `<title>`, the sr-only `<h1>` in `App.tsx`, the manifest, and the
  `WebSite`/`WebApplication` `alternateName` — it has the domain's authority and it *is* the
  builder. `/` renders the editor, so its crawlable body is a UI, not prose. `index.html` paints
  an HTML-first product shell with the same heading while the split app chunks load; `mount()`
  removes that shell immediately before Preact commits, and the audit checks both states for one
  product H1. The substantive `<noscript>` copy is a no-JavaScript fallback, not rendered-page
  content. The landing carries the
  depth (~1,300 words: what a message builder is, every message type, delivery modes, FAQ) and
  owns the nav/footer/hub-lede internal links. Don't "de-duplicate" these two by deleting or
  redirecting one, and don't retitle `/` back to the internal Discord API term — the SERP for
  this query is visual-tool pages with the phrase in their title, competing with discord.js's
  `MessageBuilder` docs for the same words. The two sibling landings stay narrower on purpose
  (webhook workflow, embed conversion) so all three do not chase one query.
  **But "Components V2" must stay in the root `<title>` beside the head term** (2026-09-18).
  The 2026-08-19 retitle dropped it ("Discord Message Builder — Free Visual Webhook Editor"),
  and Search Console's before/after is unambiguous: over the 28 days before, the
  components-v2-builder cluster gave `/` 54 clicks from ~394 impressions (13.7% CTR; "components
  v2 builder" 14.8% at 5.1); over the 28 days after, 25 clicks from ~250 (10%; "components v2
  builder" **2.3% at 3.6** — ranked higher and clicked less, because the snippet no longer said the
  words the searcher typed). The head term it was traded for had earned 12 impressions and 0
  clicks. The title is now "Discord Message Builder — Components V2 & Webhook Editor | DWEEB"
  (64 chars): head term first, exact-match token restored. Judge any future retitle the same way —
  per-query CTR on `/` in GSC, 28 days either side — not by which phrase sounds more like a product.
  **The head-term landing has to be linked *to*, contextually, and an audit gate keeps it that
  way** (2026-08-20). Its inbound links were 126 nav/footer anchors reading "Message builder" and
  nine contextual ones: the 47 template and feature pages — the site's largest content mass and
  the pages a search visitor actually lands on — pointed at it from nowhere inside their own
  copy, so the page carrying the depth for the primary query received no descriptive anchor text
  from the site that owns it. Every template detail page now links it from its closing CTA
  sentence and every feature page from a "Part of DWEEB" block (which is also the honest answer
  to "a feature of *what*" — those pages carried only two to five in-body links each). Both are
  enforced: `audit.ts` counts links found inside `<main>` separately from the nav/footer
  boilerplate every page repeats verbatim, and fails the build if a template or feature page has
  no contextual link to `/discord-message-builder/`. Deliberately not extended to the sitewide
  nav anchor — a generic boilerplate anchor plus contextual exact-match anchors is the natural
  shape; 66 identical exact-match sitewide links is the over-optimised one.
  **Landing and guide prose may carry inline internal links, and the escaping order is the whole
  safety argument** (`renderProse` in guides-layout.ts, 2026-08-20). All section copy is
  `escapeHtml`'d, which is why these pages could not link contextually at all. `renderProse`
  escapes **first**, then converts a `[label](/path)` form into an anchor: by substitution time
  every author-supplied `<`, `>`, `&` and quote is already an entity, so the syntax cannot
  introduce markup, and the href is constrained to a site-relative path from a conservative
  character class, so an external or `javascript:` target cannot be expressed. Never reorder
  those two steps and never widen the href class. Applies to paragraphs, bullets and table cells;
  `code` blocks stay escape-only. FAQ answers deliberately do **not** use it — their text is
  reused verbatim as `FAQPage` JSON-LD, and schema must match the visible text. The audit fails
  on any `[label](/path)` surviving into rendered HTML, since a mistyped target ships as visible
  punctuation rather than as a broken link the link gate would catch.
  **The head term's SERP is mixed intent, and half of it is a code library** (2026-08-20). A
  search sample for "Discord message builder" returns visual tools *and* discord.js's
  `MessageBuilder` class reference; the site addressed the second half nowhere. The landing now
  answers it directly — a "Visual builder or raw JSON" section and a FAQ stating plainly that
  `MessageBuilder` is the code-side way to assemble the same payload and that DWEEB exports it —
  and `/guides/discord-components-v2/` gained a "Sending the payload from a bot or your own code"
  table. This is honest disambiguation, not a competitor mention: the JSON export is real and it
  is what that visitor came for. Don't delete it as off-topic. Same reasoning covers the
  "is a message builder the same as an embed generator?" FAQ — "generator", "creator" and "maker"
  are separate searches for this tool, and the answer is a real product distinction (legacy embed
  versus Components V2 layout), not a synonym list.
  Discord markdown in the live message preview is subordinate page content: visual H1/H2/H3
  levels render as document H2/H3/H4 while retaining their measured CSS classes. Never emit a
  real `<h1>` from user-authored preview text; the root product heading must remain the only one.
  **The generated pages' CSP needs `connect-src 'self'`** even though they ship no first-party
  JS: Lighthouse and AI browsing agents fetch `/robots.txt` and `/llms.txt` **from the page
  context**, and without it those same-origin reads are refused as CSP violations — which
  Lighthouse reports as "robots.txt is not valid" (SEO 92) and "llms.txt does not follow
  recommendations" (Agentic Browsing 67). With it, every generated page scores 100/100/100/100.
  **Home-page discovery is the gallery's job — the editor never carries a standing link row**
  (2026-09-12, replacing the 2026-09-11 arrangement). The first-visit gallery's `discoveryLinks`
  (`TemplateGallery.tsx`) are real anchors and are the only thing a crawler renders on `/`:
  a stateless renderer has no `dweeb.gallery.lastAutoOpen.v1` record, so `shouldAutoOpenGallery()`
  is true, `deferEditorForInitialGallery` latches, and `App.tsx` renders `.app-bootstrap`
  **instead of** `<Builder>` — the editor is never mounted for one. That read must stay
  throw-safe: `localStorage.getItem` itself throws when site data is *blocked* rather than
  merely empty, and `App` calls it from a `useState` initializer, so an escaping throw took
  the whole app to the `ErrorBoundary` (and paged) over a browser setting — unreadable now
  reads as "never", the first-visit answer, pinned by `storageSafety.test.ts`. The five-link nav `Builder`
  used to pass through `ComponentTree`'s `footer` prop was therefore worth **nothing** to search
  while reading as a dangling jump-link row under the draft; it is gone, and so is the prop
  (measured before and after in a fresh browser context: `/`'s rendered internal anchor set is
  identical). Don't re-add a persistent link row to the editor to "protect SEO" — it protects
  none. What replaced it is `emptyHint`, rendered inside the tree's empty-state card only while
  the message has no components — reached by **Clear all**, not on arrival, since the store seeds
  `DEFAULT_PRESET` — offering the in-app Message directory (a button, not a `/templates/` link:
  the directory loads a template straight into this editor) and `/guides/` in a new tab. Still
  web-only: the Activity renders a bare `<ComponentTree />`. A visitor mid-draft reaches docs from
  persistent chrome — the bar's Message directory icon reopens the gallery, More ▸ About opens the
  About panel's `/about/`, `/privacy`, `/terms`. **Nothing gates a rendered anchor on `/`**: if the
  auto-open rule ever changes so a fresh profile renders the Builder instead, `/`'s rendered
  outbound link set drops to zero and no build gate will notice.
  **The feature cluster has an inbound ring too, and it is now gated** (2026-09-12).
  Templates got a build-enforced ring on 2026-08-20; features never did, and it showed — measured
  on the 2026-09-11 build, **no** `/features/<slug>/` page received a contextual link from another
  feature page, so `/features/discord-latency-check/` had exactly one in-body inbound link in the
  whole site while template pages had two to eight. `pickRelatedFeatures`
  (`gen-template-pages.ts`) mirrors `pickRelated` — similarity-ranked, one slot reserved for the
  next catalogue entry so the ring is complete however the catalogue is reordered, then topped up
  so every page ships the same three-card grid — and `renderFeaturePage` prints it as a
  "Related features" block between the templates block and "Part of DWEEB". `audit.ts` fails a
  feature detail page that receives no contextual inbound detail-page link, exactly as it does for
  templates (both count `internalLinks` restricted to detail paths, which the sitewide nav/footer
  never name — they only ever link the hubs). Result: 33 descriptive contextual links where there
  were none. Two knock-on costs, recorded rather than glossed: each feature page's outbound
  contextual count rises, marginally diluting what it forwards to `/discord-message-builder/`; and
  `FEATURES_LASTMOD` is one constant driving the hub *and* all 11 children, so bumping it re-dates
  a hub whose visible content didn't change — unavoidable given the hub-newer-than-child gate.
  **A feature page's setup copy is derived, and `requiresBot` does not mean "plugin"**
  (2026-08-19). `resolveFeature` maps `requiresBot` to `deliveryMode: "bot-install"`, and every
  such feature was a plugin until the MCP connector, which needs the app in the server only
  because posting resolves DWEEB's own webhook. So the delivery callout, the appended "Is DWEEB
  free?" answer, and the CTA instruction gate their plugin wording on `pluginId`, never on
  `deliveryMode` — the generic copy otherwise walks the reader through detecting a component and
  pairing a plugin that doesn't exist for that feature. A feature whose CTA opens something other
  than the editor (an `appPath` with its own `intent=`) also needs an entry in `ctaLabels` and
  `ctaNotes` (features-layout.ts), since neither can be derived from the shape of its data. The
  audit checks structure, not truthfulness; these claims stay honest only by hand.
- **A rating is published because it is ours, not because someone left it somewhere**
  (`server/src/rating.rs`, `src/core/rating/*`, `src/core/seo/ratingAggregate.ts`, added
  2026-08-20). Sending people to review DWEEB on Top.gg, Product Hunt, G2, AlternativeTo or
  a Reddit thread does **nothing** for the site's ranking: every one of those platforms
  marks its outbound links `nofollow`/`ugc`, so no signal reaches dweeb.faizo.net. What does
  change our own result is `aggregateRating` on the `WebApplication` entity — Google's
  review-snippet rich result covers software types, and the self-serving-review restriction
  it applies to `LocalBusiness`/`Organization` does not extend to them. So the rating is
  collected first-party and printed on `/discord-message-builder/`, the page targeting the
  head term. Load-bearing decisions: (1) **one row per Discord user id, enforced by the
  PRIMARY KEY** — the write is identity-gated through `resolve_identity` and re-rating
  overwrites, because an anonymous endpoint behind a rate limit is inflatable and a rating
  snippet Google judges fabricated is a manual action against the **whole domain**, not one
  page; (2) **no review gating** — the score is recorded whatever its value and the prompt
  never routes on it, since steering unhappy raters elsewhere would corrupt the average the
  site publishes (a 4-5 additionally *offers* the Top.gg link afterwards, which is a
  recommendation channel, not a rating channel; ≤3 is pointed at the feedback form); (3) the
  visible block and the schema are gated on **one** expression in `renderLandingPage`, and
  `audit.ts` **fails the build** if any `aggregateRating` names a `ratingValue`/`ratingCount`
  that is not in the page's rendered text — Google requires the rating to be readable by a
  visitor, so schema-only is not an option; (4) nothing publishes below
  `MIN_RATINGS_TO_PUBLISH` (25) — a mean of a handful of scores is noise stated as fact;
  raising it is safe, below ~10 is not; (5) the build **must never fail on this** — the
  aggregate is fetched once by `scripts/seo/ratings.ts` with a 5s timeout and every failure
  (proxy down, feature off, payload that fails `parseRatingAggregate`) ships a page without
  stars, matching the standing rule that workflows must not depend on a network call.
  `SKIP_RATINGS=1` forces that path for local builds; `RATINGS_API_ORIGIN` points a
  self-hosted build at its own proxy. Only **one** page may set `showsRatings` — three
  landings carrying it would put our own URLs in competition for the same stars. The prompt
  itself is armed by the **Send-success dialog closing**, not by page load and not by the
  send itself, and asks once ever: the "have they already rated" answer comes from the server
  (`/api/rating/me`) so rating on a phone settles it on a laptop, and its three-state reply
  matters — `unknown` (signed out, offline, unreadable) must never be read as "hasn't rated",
  or the one prompt is spent on someone whose tap the server is bound to refuse.
  **`RATINGS_ENABLED` is off by default and enabling it is two env changes, not one**: it
  adds a durable store, so `RATINGS_DB_PATH` must be set absolute in the same change or the
  table is destroyed on the next deploy (and under `STRICT_DB_PATHS` the proxy refuses to
  boot) — same trap as `MCP_DB_PATH`, and prod's `/opt/dweeb/.env` is hand-managed, so a
  repo-only change enables nothing. Server-first deploy ordering: the FE gates the prompt on
  `/api/capabilities` reporting `ratings`, which an old proxy omits, so the web app simply
  never prompts until the proxy ships. Guarded by the `rating::tests` in rating.rs,
  `ratingAggregate.test.ts`, and `ratingStore.test.ts`.
- **Search attribution is first-party and privacy-bounded.** Static CTAs use browser-fragment
  `entry=<about|landing|template|feature|guide>:<public-slug>` (never internal UTM tags); optional
  `template=`, `setup=`, and `intent=` state lives in that fragment too, so the generated site
  exposes zero crawlable root-query variants. Readers still accept the old query form for deployed
  bookmarks. `captureSeoAcquisition` removes only `entry` but returns the validated handoff to
  `App`, which suppresses both first-visit gallery auto-open and the delayed welcome-tour toast;
  otherwise an explicit "Open builder" CTA is interrupted after arrival. Suppression writes no
  welcome record, so a later organic visit can still receive the one-time orientation.
  `seo_builder_open` records arrival, while `seo_builder_ready` is the
  actual attributed activation. Optional `intent=` values may only open a non-mutating surface.
  `gtag-init.js` drops hashes,
  Discord/OAuth/billing identifiers, arbitrary queries, and exact short-link ids by sending only
  the controlled canonical plus a referrer's origin; acquisition ids and product-event fields use
  exact allowlists. Keep GA Enhanced Measurement disabled (especially outbound clicks, site search,
  and history pageviews), because those automatic events bypass the repository's field filters.
  **`gtag-init.js` starts from analytics-only consent** (2026-09-23): `gtag("consent", "default",
  …)` denies `ad_storage`, `ad_user_data` and `ad_personalization` and grants `analytics_storage`,
  before `js`/`config` — exactly what the privacy policy promises (analytics cookies, no
  advertising or cross-site tracking). It is what stops gtag's per-page `ngs=1` ping to
  `stats.g.doubleclick.net`, which the app shell's broad `connect-src` let through and every
  generated page's narrow one refused with a console error whenever GA loaded (Best Practices 93 in
  a throttled Lighthouse run). Measured, not assumed: the property's Google-signals toggle was
  already **off**, and `allow_google_signals` / `allow_ad_personalization_signals: false` — tried
  via `set` and via `config` — did not stop the ping; the consent defaults did, with page views
  still collected (`gcs=G101`, `npa=1`). The two flags stay in `config` as documented per-tag
  opt-outs. Don't widen the generated pages' CSP to silence such an error, and don't drop the
  consent defaults.
  Never add message content, webhook URLs/tokens, guild/app/message ids, share payloads, or
  free-form text to analytics. **Never name an event parameter `source`, `medium`, `campaign`,
  `term` or `content`** (2026-09-18): GA4 reads those on *any* event as a manual campaign
  override, and `template_applied { source: "gallery" }` re-attributed 565 of 3,279 sessions (17%,
  the whole "Unassigned" channel) to traffic sources named `gallery` and `seo`, overwriting the
  search engine or AI assistant that really sent them. The field is `applied_from` now;
  `trackAnalytics` refuses the five names and `analytics.test.ts` pins every allowlist clear of
  them. Channel data before 2026-09-18 undercounts Organic Search and AI Assistant accordingly.
- **Code export is generated from the wire payload and proven by running it** (2026-09-18).
  Why it exists: Search Console (90 days) shows the one query family DWEEB wins is "components v2
  builder" — a developer's phrase — and `/guides/discord-components-v2/` drew 1,227 impressions in
  28 days at position 8.8 with 2% CTR, nearly all behind queries too rare to be named (the long,
  specific searches of someone writing a bot). GA4 puts ChatGPT referrals (452 sessions) level with
  Google organic (554). The rival in that niche (discord.builders) exports library code; DWEEB
  could only hand a developer JSON. Now More ▸ **Export as code** (Share dialog **Code** tab,
  `#intent=code`) renders the current message for five targets — discord.js 14.19+ builders,
  discord.py 2.6+ `LayoutView`, and cURL / `fetch` / Python `requests` webhook posts — from
  `src/core/codegen`, a pure function of the same wire payload the JSON tab exports
  (`prepareCodegenInput`: `stripEditorFields`, then `session://` uploads and hand-typed
  `attachment://` URLs become one `attachments` list every target turns into the matching upload
  code, and restored-media metadata is dropped). Load-bearing: (1) **correctness is proven, not
  remembered** — `scripts/verify-codegen.ts` runs all 36 templates + edge cases through the real
  packages (builders' `toJSON()`, `view.to_components()`, and a local capture server for the HTTP
  targets, which checks `with_components=true` and the body byte-for-byte) — run it after touching
  a generator; the unit tests only pin the *printed* form; (2) the printer breaks lines like a
  formatter (88 cols, hugged single calls, one arg per line otherwise) because the export is read
  before it is run; keep new targets on it; (3) **every code sample on the static site is
  generated at build time** (`scripts/seo/code-samples.ts`): the 5 developer guides
  (`scripts/seo/code-guides.ts` — discord.js, discord.py, webhook in Python / JavaScript / cURL),
  `/features/discord-code-generator/` (`codeSamples`), and the "Use this template in a bot"
  section on all 36 template pages (discord.js + discord.py, collapsed; cURL/fetch/Python are one
  click away in the editor via `#template=<id>&intent=code`) — never hand-write builder code into
  a page; (4) a template link that also names a surface (`template=` + `intent=`) skips the Send
  coach mark and the plugin checklist (`useTemplateDeepLink` reads the intent at first render,
  before App strips it), since the CTA promised the Code tab and both would land on top of it;
  (5) the generated discord.py builds the view inside `build_view()` for paste-ability, not because
  construction needs a running loop (it doesn't in 2.7); (6) analytics event `code_exported`
  carries `language` + `action` only. Library facts in the guides were checked against the
  discord.js guide (display-components), the 14.19.0 release notes, discord.py's whats_new/API
  reference, and the installed packages (`withComponents` → `with_components`; discord.py adds
  `with_components` itself when `view=` is passed to a webhook; a bare button in a `LayoutView`
  serialises top-level and Discord refuses it). The `// Designed in DWEEB (https://dweeb.faizo.net)`
  header comment is deliberate: code travels into repos, gists and answers, and a mention there is
  how the next developer — and the AI assistants that now send 14% of sessions — finds the tool.
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
  playback (while respecting reduced-motion) because the user asked for it — and since
  2026-09-24 it first tries playback **with sound** (muted + a "Tap for sound" pill only when
  the browser refuses; a poster + "Play with sound" when even muted autoplay is refused).
  The web cuts are made by `npm run deliver:web` in `video/` (never hand-encoded): AV1 + H.264
  per aspect as codec-tagged `<source>`s (portrait AV1 only when MediaCapabilities says it is
  power-efficient), trimmed of the master's black fades, keyframes on the scene cuts, a
  −16 LUFS mix, posters from the settled end card, and `intro.en.vtt` narration captions
  generated from the VO word timings (off by default — the story is burned in). If an encode
  changes profile or level, update the `codecs` strings in `WelcomeVideo.tsx` from `ffprobe`.
  `/media/*` stays out of the service-worker precache.
- **Promo-film story locks** (`video/`, settled 2026-07-17; v6 2026-09-24): the opening is a
  direct boring-message → visual-message makeover on a neutral preview surface — never an
  announcement being buried in `#general` — and the makeover's AFTER card **is** the message
  the film builds and delivers, so the promise and the payoff are one card. The Build Together
  beat **starts in a Discord voice channel with members in the call and launches the DWEEB
  Activity from it** (maintainer, 2026-09-24 — this reverses the 2026-07-17 "start directly in
  the Activity editor, no voice-call detour" lock): the call's rocket → the Activities shelf
  (DWEEB only, its real cover art) → Discord's launch splash → the Activity in the call, then the
  edits. Show ONE teammate joining the editing (Free rooms allow 2 co-editors — the other call
  members stay in the call). The outro promise is “Build better Discord
  messages” and its action is a Google-style search bar for “DWEEB Discord bot” — the Google G
  at its start, the search button (a magnifier) at its far end, which is what gets pressed
  (maintainer, 2026-09-24; was “DWEEB Discord builder” with the G as the button). The editor
  act (reveal → send) is one continuous take joined by `hold`
  cuts whose boundary frames are pinned in `video/src/scenes/contracts.ts` and checked by
  `npm run qa:cuts`; the vertical cut is portrait-native (a 540×960 stage, locked camera),
  never a crop of the landscape. On-screen product strings follow the app source (tree labels
  from `COMPONENT_META`, a valid CV2 tree whose stat pills match `countComponents`). Keep
  `video/SCRIPT.md`, generated narration/manifest, and both aspect-ratio beats aligned. The
  licensed music source lives in the gitignored `video/assets-src/`; never commit it or
  `video/public/audio/music.wav`. **`video/src/index.ts` must import `remotion/no-react`
  first**: `src/fonts.ts` holds rendering with a module-level `delayRender`, and Remotion's
  render entry — evaluated after the root — resets the delayRender timeout registry on its
  `no-react` import, orphaning that timer, which then kills every full render one timeout in
  while single stills (done in seconds) never notice. Don't "fix" it with a longer timeout or
  fewer tabs (both were tried on a misdiagnosis).
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
  **A pinned model gets decommissioned out from under us** (2026-08-17). Groq retires
  models on a published schedule — `llama-3.1-8b-instant` and `llama-3.3-70b-versatile`
  both went on 2026-08-16 — and answers a request naming one with **404
  `model_not_found`**. That is our configuration going stale, not a bad request, but it
  arrived at the same branch as a broken key: the run ended on the spot with a paging 502,
  so a healthy primary could not rescue a retired fallback (it paged exactly that way, the
  `latency=382 ms` being a rate-limited primary skipping its retry and the fallback 404ing).
  `is_model_gone` now splits it out: the model is marked exhausted, the chain **carries on
  to the next model**, and the attempt logs `warn` — so a run another model can serve is
  silent. Only a run that ends with no model left logs `error!` naming every retired id
  (that pages, and it is exactly what a human must fix). The terminal *status* still comes
  from how the **provider** failed us, not from our stale config — a throttled caller keeps
  its 429 and `Retry-After`, which is the lever they have. Both `AI_MODEL` and
  `AI_FALLBACK_MODEL` must name a currently-served model; check the live list
  (`curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models`)
  rather than assuming, and remember prod's values live in `/opt/dweeb/.env`, so a repo-only
  change fixes nothing. Guarded by `a_retired_model_is_skipped_not_fatal` in ai.rs.
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
- **A reqwest error is never formatted with `{e}` when its URL carries a credential** (2026-09-13).
  reqwest's `Display` appends ` for url (…)`, and a webhook's execute URL *is* its token. The
  scheduled-post worker recorded a failed post as `format!("Couldn't reach Discord: {e}")`, so
  the token the row keeps sealed landed in plaintext in `last_error` — which `schedule::view`
  (documented as never including the token) serves to the per-server list, and which the gallery
  shows on a failed series. Build such messages with `discord::describe`, which drops the URL
  and keeps the cause chain (`unreachable_reason` in schedule_worker.rs). `ScheduleStore::open`
  scrubs any pre-fix reason on every boot (cuts from ` for url (`; idempotent, logs and carries
  on if it fails) so self-hosted deployments are cleaned too; prod held none when this shipped.
  The plugins' token-URL calls (followups, `@original` edits) discard their errors and were
  checked clean. Guarded by `an_unreachable_post_never_records_the_webhook_token` and
  `opening_scrubs_webhook_urls_from_stored_errors`.
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
- **Destructive editor actions acknowledge themselves with an Undo toast, and toasts can carry
  one action** (2026-09-22 UX batch, from a full audit — the remaining findings are in the
  maintainer's notes). `pushToast(message, tone, { action, durationMs })` renders a pill button
  (timing and dismissal rules: see the 2026-09-23 toast bullet below). `features/builder/undoToast`
  wraps it for the editor: capture `useMessageStore.getState().message` *before* the store action,
  and its Undo fires only while that snapshot is still the top of `past` — otherwise it says the
  message has changed since, so a stale Undo can never revert newer work. Used by "Clear current
  message" and by deleting a node with anything nested (the toast names the count). The AI
  panel's "Updated the message" chip offers Undo the same way (`useAiEditIsCurrent` /
  `undoAiEdit` in aiStore, a module-level "what did we last commit" record) — on a phone the
  bar's Undo sits in an `inert` pane while the assistant is open, and Ctrl+Z is ignored in the
  composer, so the chip is the only reachable undo there.
- **Every new button/select is given a unique `custom_id` by the store, never by the factory**
  (`uniqueCustomId` + `uniquifyCustomIds` in messageStore, applied on every add path, on
  `setSectionAccessoryKind`, and on `duplicate`). The factories keep their readable defaults
  (`btn_action`, `select_option`…) so templates, the MCP catalog and the golden fixtures stay
  deterministic; the store suffixes on insert (`btn_action_2`, an existing `_N` is bumped, never
  stacked). Before this the second button anyone added was instantly invalid on both rows, with
  the fix folded behind the Action panel's "Set the ID manually". Plugin bindings
  (`prefix:instance`, anything with a `:`) are copied verbatim on Duplicate — renaming one would
  route the click to an instance that doesn't exist; the validator still reports the duplicate
  and the user picks which copy keeps the binding. Pinned in `messageStore.test.ts`.
- **A Section's accessory row renders no Duplicate/Delete** — `remove`/`duplicate` only walk
  child lists, so both were silent no-ops there (verified on prod); the inspector swaps the
  accessory kind instead. Clicking a tree row also calls `revealTreeRowEditor` (scrollTreeRow.ts):
  a row in the lower ~45% of its scroller scrolls to the top so the inline editor that unfolds
  under it isn't below the fold; rows higher up stay put, since a click must not yank the list.
  The header issue chip hides when `EMPTY_MESSAGE` is the only issue (the empty-state card
  already says it, and the chip's jump had nowhere to land).
- **First-visit feedback: the gallery template pick toasts, the coach-mark waits for its anchor,
  and the intro offer waits for the editor.** On a first visit the landing gallery closes over an
  editor that mounts a beat later, so (1) every gallery template pick pushes the deep-link toast
  ("Loaded the “X” template — make it yours, then Send."), (2) `SendCoachMark` polls for
  `#builder-send-action` for up to 4 s instead of no-oping when it isn't there yet, and (3)
  `useWelcomeAutoOpen(suppress, ready)` only starts its 1.5 s timer once `ready` (App passes
  "no gallery, editor mounted") — it used to toast "look under More" over a modal that hid More
  and stamp its one-shot record regardless. The toast now carries a "Watch the intro" action
  (`useWelcomeStore.openWelcome`); the record is written when the offer is actually shown.
- **Focus rings are full-strength, and forced-colors gets a real outline** (`tokens.css`,
  `global.css`). `--app-focus-ring` is the accent at full opacity (~3.9:1 on the elevated
  surface; the old 55% alpha ring measured ~2:1, under WCAG 2.2's 3:1), and
  `--app-focus-ring-on-accent` (surface-coloured gap + ring) is for accent-filled controls —
  primary buttons and the Collab/AI FABs — where the plain ring vanished. Nearly every control
  replaces the reset's `outline` with that box-shadow, and Windows High Contrast drops box-shadows,
  so `global.css` ends with an `@media (forced-colors: active) :focus-visible { outline … !important }`
  rule; keep it, and don't add `outline: none` without a box-shadow ring behind it.
  `index.html`'s viewport meta carries `interactive-widget=resizes-content` so Android Chrome's
  keyboard shrinks the layout viewport and bottom-anchored surfaces (AI composer, modal footers)
  rise above it.
- **Plugin config frames fail visibly** (`features/plugins`). A `save` the host refuses (prefix or
  URL mismatch) sets a visible `saveError` instead of silently returning — outside DEV that read
  as a dead Save button. The iframe has a `frameState` (loading → ready → timeout): a "Loading
  {plugin}…" cover until the `ready` handshake, and after `PLUGIN_FRAME_READY_TIMEOUT_MS` (8 s)
  a retryable notice with Close/Retry in the modal's only footer (a live plugin renders its own
  Save/Cancel, so the footer exists only in the timeout state); Retry remounts the iframe by key.
  Copy and refusal rules are pinned in `configRejection.test.ts`.
- **The Share dialog keeps a hand-typed webhook across its tabs and names itself by intent**
  (`core/webhook/webhookDraft.ts`, `features/share/sendCopy.ts`). Each tab mounts its own panel,
  so the pasted URL — even after "Done — use this webhook" — died on a tab switch and Update needed
  it pasted again; the draft store holds the raw field text + expanded flag for one dialog open
  and resets on close (hand-entered URLs only: a picker/recents pick clears it, and it is never
  persisted — "Save" is the recents path). `sendCopy.ts` owns the state-dependent claims:
  signed-out lead copy, "Ready to send — we'll check this webhook when you post." until a
  verify/known entry exists (never "All set" for a URL only the regex has seen), the disabled-Send
  hint, and the friendly update-404 text. The modal title follows the tab ("Send message", "Update
  a posted message", …) instead of "Share / Send / Export", and the send receipt's Done closes the
  dialog on the new-post path so the first send doesn't end on the Send panel.
- **Second UX batch (2026-09-22, from a signed-in walkthrough of prod).** (1) **Static template
  and feature previews render the real sample images** (`scripts/seo/render-message.ts` +
  `media-dimensions.ts`): any `/media/defaults/<name>.jpg` URL on any origin becomes an `<img>`
  for the committed `.webp` variant with `width`/`height` read from the WebP header (no image
  library, no fetch); every other URL keeps the captioned placeholder. The old "picsum stand-ins"
  rationale for placeholders predates the shipped samples, and the glyph read as a broken picture
  on the page's hero. The first image per document loads eagerly, the rest lazily. Template and
  feature `lastmod` baselines were bumped for it. (2) **A dialog whose height changes while open
  is top-anchored** (`Modal anchor="top"`, `.dialogTop`): the Send dialog grows by a date field
  when Schedule is picked, and a centred dialog shifts every control by half that growth under a
  resting cursor — an audit click landed on the wrong row because of it. Use it for any dialog
  with expanding sections; leave confirmations centred. (3) **Library cards are named by their
  message** (`core/schema/headline.ts` — first text line, markdown stripped; next line as the
  description): posted history stores no title, so four posts to `#test` were four identical
  cards. Metadata-only cards fall back to the destination until hydrated. (4) **The Collab dialog
  defaults to the toolbar's picked channel** (`sendTargetStore`) and only then the first channel —
  the alphabetical default put invites in the wrong room. (5) **The plugin library's "Needs bot"
  tag is gated on the connected server's `bot_present`**; unknown still shows it. (6) **The plan
  popover shows `used / cap` for rows whose store is already loaded** (saved messages, custom
  bots, AI requests) and never fetches for it; posted history stays a bare cap because its `used`
  counts never-expire messages that sit above the rolling window (the directory subtracts them
  with data the bar doesn't have). (7) Template-page copy names the real CTA ("Use this template
  free"), not the retired "Open in DWEEB".
- **Tree moves are planned once, and the arrows say what they do** (2026-09-23 UX batch, the audit
  backlog plus a fresh walkthrough). `planSiblingMove` (messageStore) decides what an up/down press
  does — reorder, step *into* the adjacent Container, step *out of* the Container at its edge, or
  nothing (`blocked: "top-level-full"` when only the top-level cap is in the way) — using the same
  `canAcceptChild` gate `moveToParent` applies. `moveSibling` executes the plan and the row arrows
  label themselves from it (`treeRowActions.ts`: "Move into the Container above", "Move up out of
  the Container"), so label and behaviour can't drift; a silent re-parent behind a bare "Move up"
  was the old surprise. Arrows stay mounted at a list's edge as `aria-disabled` (never `disabled`,
  which drops focus) and `keepMoveArrowFocus` re-focuses the pressed arrow after the row
  re-mounts. Row actions are `visibility: hidden` until the row is hovered, selected or
  focus-within — `opacity: 0` alone left four invisible buttons per row in the tab order. On touch
  (`(hover: none), (pointer: coarse)`) only the *selected* row shows its actions, at 40 px:
  showing all four on every row squeezed labels to "Text # 🧩 The Compon…" at 390 px. Fine
  pointers get a decorative six-dot grip on hover (pointer-transparent; the row starts the drag),
  and a mouse press that wandered ≤8 px without ever showing a drop target is still a click
  (`swallowsClickAfterDrag`). Rows reveal with `scroll-margin-top: 36px` so the floating issue
  chip (top-right, ~6–30 px) doesn't sit on their Duplicate/Delete.
- **Never `useId` — use `useUniqueId`** (`lib/useUniqueId.ts`). Preact derives `useId` from a
  counter kept per render *root*, and every `Modal` portal is its own root, so a dialog's ids
  restarted at values the editor behind it already used: with the Send dialog open, the Update
  tab's message-ID and Thread ID inputs shared ids with the builder's Username/Avatar fields and
  their labels, hints and errors pointed at the builder (found 2026-09-23 by reading
  `input.labels` in a live dialog). A module-level sequence can't repeat; this app never
  server-renders, so there is nothing to hydrate against.
- **Editor words are the UI's words** (2026-09-23). `COMPONENT_META` labels are UI-only — codegen,
  the MCP catalog and serialization never read them (`bun run gen:mcp` produced no diff). The add
  menu offers the Action Row as "Buttons & menus" (`addLabel` / `addMenuLabel`) because people
  look for a button or a dropdown, never for the row that holds it; the tree calls it "Action
  row", and the five selects are "Options menu", "Member menu", "Role menu", "Member / role menu"
  and "Channel menu", each description keeping Discord's own term for developers. Validation
  message *text* uses the field labels ("Min selections", "Custom ID", "Thread name", "Default
  selections", "alt text") — only `(code, path)` is pinned by the corpus, so copy can move freely
  but codes never do. `ui/Field` takes `counter={{ value, max }}`: an `n/max` on the label row from
  75% of the cap (amber ≥90%, red at it), described via `aria-describedby` rather than a live
  region, counting UTF-16 units exactly like `maxLength`.
- **Toasts are dismissible, pausable and announced once** (`ui/toastQueue.ts`, 2026-09-23). Every
  toast has a Dismiss ✕; its lifetime is the tone's minimum (3 s, 5 s for an error, 7 s with an
  action) stretched by reading time to at most 10 s — an explicit `durationMs` is used as-is; at
  most three are visible and the oldest leaves first; countdowns hold while the pointer or focus
  is on the stack or the tab is hidden, and resume with at least 1 s left. Screen readers hear
  each message from always-mounted hidden regions (polite, or `role="alert"` for errors) while
  the visible copy is `aria-hidden` — never put the visible stack back in a live region, or every
  toast is read twice. `data-modal-live-region` marks a global status surface Modal must not
  inert (the toast root, the update pill, which now portals to `<body>` above the directory).
  Primitives size up only under `(pointer: coarse)` (IconButton 36/40, Button 36/40, menu items
  44, modal close 40), as overrides at the primitive's own specificity so a caller's deliberate
  size still wins; on phones a Modal footer stacks full-width with the primary on top (keep the
  primary last in markup). Menus have typeahead (`menuTypeahead.ts`) and a focus ring distinct
  from hover. The rating card is lazy (`RatingCard` behind a `ChunkErrorBoundary`), docks above
  the FAB stack (its offset copies MiniPreview's 104 px — change them together) and never takes
  focus; its ✕ is the permanent "Don't ask again", while Escape and the 20 s timeout are soft
  (`dismiss(false)`), so the one-time ask survives an ignored card.
- **The error screen never imports the store — and entry-chunk code never dynamic-imports what
  the App graph imports statically** (2026-09-23). The top `ErrorBoundary` offers "Reload" (in
  place, so a share link survives) and, on the web, "Start a blank message", which clears through
  the store (the old message goes onto undo), writes the draft and history itself (autosave is
  unmounted, and `/` restores whatever draft is saved) and then goes to `/`. It reaches that code
  via `import("@/app/App")` (`app/blankStart.ts`, re-exported by App): the first version imported
  `messageStore`/`draftStorage`/`historyStorage` straight from the boundary, which sits in the
  entry chunk, and Rollup split all four modules out of the App graph into chunks of their own —
  19 critical requests against the audit's 16 and +12 kB. Reach App-graph code from the entry
  chunk through the App chunk, never around it. The plugin library modal is lazy for the same
  budget (like the two config modals before it).
- **Sign-in says "Sign in", and only an answer ends a session** (2026-09-23). Signed out, the
  account control is a labelled "Sign in" button (the arrow-into-door icon read as "exit"); the
  bar's fit ladder drops the label only after every utility icon has folded. The web bar reserves
  `WEB_LEFT_MAX_RESERVE` (210 px) for account + destination so the channel name stays readable
  (at a 776 px pane it had elided to "dweeb • …"), while the step that would drop Send's label
  still measures with the Activity's 150. In `authStore`, `/auth/me` 401/403 clears the session
  exactly as before; status 0/408/429/5xx keeps the current state — signed in stays signed in —
  toasts once and retries (2 s doubling to 60 s, plus `online`/`visibilitychange`) when there is
  a session to recover (`sessionHint`, a cached server, a sign-in that just finished). A network
  blip used to sign people out silently. Flows with no click behind them (`?plans=`, the bot-add
  return, `?custom-bot=`) call `requestLogin(message)` — a toast whose button opens the popup —
  never `login()` from an effect, which the browser blocks into a full-page redirect. The landing
  directory makes no cross-origin call (Lighthouse renders it; a CORS error fails Best Practices)
  and picks its signed-out copy from `sessionHint` + the cached server. The "add the bot" popover
  opens once per account per browser (`addBotPrompt`).
- **The landing directory's header is load-bearing for Core Web Vitals — measure before changing
  it** (2026-09-23). On a first visit `/` paints the boot shell's H1 (the intended LCP), then the
  auto-opened directory renders over it, and *any* element in its first screen larger than that
  H1 becomes a late LCP. Three innocent-looking header edits each failed the lab gate in
  interleaved A/B runs (412×823, simulated throttling): hiding the lone "Template" chip moved
  the card grid up 18 px and made a template's banner image the LCP (1.1 s → 3.05 s);
  lengthening the signed-out subtitle to ~4 lines made the *subtitle* the LCP (294×78 px beat the
  H1); and replacing the chip row with a sign-in line kept LCP but raised simulated TBT ~90 ms,
  right onto `lighthouserc.json`'s 600 ms cap. What shipped keeps the row and a subtitle no
  longer than the signed-in one ("Pick a template to start. Sign in with Discord to see your
  server's posted and saved messages." — 94 chars vs 95), measured equal to the pre-change
  build (TBT 494 vs 495 ms, LCP 1092 vs 1092 ms median of 8). So the pointless lone chip stays
  for now. Before touching that header, compare against the previous build with interleaved
  local Lighthouse runs: one-off lab numbers on a dev machine swing ±150 ms, and `lhci` itself
  crashes on Windows cleaning its temp profile (EPERM), so drive `lighthouse` directly and read
  the JSON.
- **Send, Update and Schedule say what they'll do** (2026-09-23). `features/builder/jumpToIssue.ts`
  is the one issue-jump routine: the header chip and the Send panel's "Fix before sending" rows
  (each a button that closes the dialog and lands on the component or its Message-options field).
  A scheduled post loaded from the directory arms `core/schedule/scheduleOrigin.ts` — bound to
  the document generation *and* the message it replaced, dropped synchronously by any replacement
  or an undo past the load, re-checked by `currentScheduleOrigin()` at save time — and Schedule
  mode then PATCHes that post ("Save changes", same access as the directory's Cancel) instead of
  creating a second one; never save into a schedule from anything that skips that check. After a
  successful schedule the primary reads "Schedule another" until the message, time or
  destination changes (two clicks used to make two posts), and past times are refused at the
  field (`min` + inline error). Update shows a "Replaces" card for the target message
  (`share/updateTarget.ts`) and warns "Update replaces the whole posted message…" with "Restore
  it first" whenever the editor wasn't loaded from that message. Web Restore infers `thread_id`
  from a pasted link only through `core/webhook/restoreLink.ts` (never the webhook's own channel
  or a known server channel — Discord 400s "Unknown Channel" — and it checks the webhook first
  when its channel is unknown).
- **Plan, install, AI and feedback dead ends** (2026-09-23). `fetchMySubscriptions` returns ok/error
  and never turns a failure into an empty list — that list gates Manage billing, the only in-app
  cancel path. `getStripe()` resolves `null` instead of rejecting, because
  `EmbeddedCheckoutProvider` chains `.then` with no `catch` and a rejected Stripe.js load became an
  unhandled rejection (a crash beacon). The pricing modal has loading, error (Retry) and signed-out
  states; the install dialog keeps its own `prompting` flag, since `promptInstall()` spends the
  event before the browser prompt resolves. The built-in AI provider never stores a BYOK key
  (`setSettings` strips it; "Remove key" asks first — the key exists nowhere else); "Clear chat"
  is undoable only back into an empty chat; an unsent feedback report lives in sessionStorage
  (`feedbackDraft.ts`, throw-safe) until sent or discarded, since every close unmounts the dialog.
  Plugin-library setup tags come from the real `statusUrl` probe; unknown reads as a neutral
  "One-time setup", never "Ready".
- **In the Activity, replacing everyone's draft asks first and is named to the others**
  (2026-09-23). Any action that swaps the whole shared message — "Start from scratch", a template,
  library or scheduled load, Restore, JSON import — goes through `requestRoomReplace`
  (`core/activity/roomReplaceConfirm.ts`), never `replaceMessage`/`clearAll` directly: it asks
  only when someone else is in the room (counted by user id) *and* the draft has content, so solo
  use never gains a confirm. Peers can't undo a remote frame, so receivers detect a whole-draft
  replace with no wire change — no node id surviving at any depth (`isWholeDocumentReplace`,
  collabPatch.ts) — and name the sender from the identity each connection stamps on its `focus`
  frames; a replacer sends one `focus` just before its draft (an existing frame, so older
  clients behave as before), and the draft answering our own `hello` is never attributed.
  Post/Update refuse a draft whose `session://` uploads aren't in this browser with a message
  naming why (`core/activity/uploads.ts`), a socket drop is toasted only after 4 s and the
  recovery after 2 s of stability (`connectionNotice.ts` — one pair per outage), and unavailable
  bar actions are `aria-disabled` + tap-to-explain (native `disabled` only for an in-flight
  post). The Activity's Scheduled cards load a *copy* (the web's Schedule panel is the only
  editor of a schedule), and say so.
- **Static guide tools work on a phone** (2026-09-23). The timestamp generator's table restyles into
  stacked cards at ≤560 px (name + Copy, the code, "Readers see:") with explicit ARIA table roles,
  since changing a row's `display` drops implicit table semantics in some engines; at 390 px the
  four-column table had put Copy and the preview off-screen. The sticky site header is opaque on
  phones — they skip its backdrop blur, and the translucent fill let text show through.

## CI

- `web.yml` — FE build + Vitest + GitHub Pages deploy. `server.yml` — Rust fmt/clippy/test. `plugins-ci.yml` — fmt/clippy/test matrix over all 10 crates. `deploy.yml` — backend CD.
- **Workflows must not depend on `api.github.com` at runtime** — calls to it from Actions
  runners fail intermittently (HTML error page). This broke `setup-bun`'s version lookup
  (fixed by pinning `bun-version` in `web.yml`) and `docker/metadata-action` in all 10 image
  workflows (replaced 2026-07-17 with a shell tag-derivation step + static OCI labels; keep
  the `sha-<short>` tag scheme — `deploy.yml` rollback relies on it). Don't reintroduce
  actions that query the GitHub API mid-job.
- Pushing `main` triggers deployments; never push unless the maintainer explicitly asks.
