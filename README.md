# Discord Webhook Builder

[![CI](https://github.com/FaizoKen/Discord-Webhook-Builder/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/FaizoKen/Discord-Webhook-Builder/actions/workflows/ci.yml)

A visual editor for Discord webhook messages using **Components V2**. Build rich
messages with containers, sections, buttons, media, and files, watch a
pixel-accurate live preview, and share the result through a single URL — no
backend, no account, no database.

## First-time users

The editor opens straight to a showcase message so you can see how the
pieces fit together. Start editing in place, or click **Reset** in the
top-left action bar to discard your changes and reload the showcase.

The editor auto-saves your work to this browser only (`localStorage`); a
refresh or revisit picks up where you left off.

Layout at a glance:

- **Left pane** — the editor. A compact action bar at the top hosts every
  global control (undo / redo / Reset / Restore / Share / Send); below it
  the Components ↔ Message tabs flip between the component tree and the
  webhook's username/avatar. Selecting a node opens its inspector below.
- **Right pane** — the Discord-style live preview. Pixel-accurate, so you
  iterate in seconds.

The action-bar buttons:

- **Send** — POST the current message to your webhook URL (or PATCH the
  original when the editor was populated via Restore).
- **Share** — opens the Share / Export dialog (share link, JSON export,
  Import from URL or JSON).
- **Restore** — pull a message your webhook previously posted back into
  the editor so you can keep iterating. Paste the webhook URL + the
  message ID (right-click → *Copy Message ID* with Developer Mode on) or
  the Discord message link.
- **Reset** — replace the current message with the default template
  (undoable).

Privacy: webhook URLs and your draft never leave your browser. Share URLs put
the message in the `#hash` fragment, which the server never sees.

```
┌─────────────────────────────────┬────────────────────────────────────────┐
│ [↶] [↷]    Reset · Restore ·    │                                        │
│            [Share]  [ Send ▸ ]  │                                        │
├─────────────────────────────────┤                                        │
│  Components │ Message            │     Discord-style live preview        │
│  ───────────┴──────────         │                                        │
│  ▤ Container                    │                                        │
│   ◧ Section                     │                                        │
│   ¶ Text                        │                                        │
│   ⬚ Buttons Row                 │                                        │
│                                 │                                        │
│  ┌─ Inspector ──────────────┐   │                                        │
│  │  fields for the selected │   │                                        │
│  │  component               │   │                                        │
│  └──────────────────────────┘   │                                        │
└─────────────────────────────────┴────────────────────────────────────────┘
```

## Getting started

```bash
bun install
bun run dev          # http://localhost:5173
bun run build        # produces dist/ (Cloudflare Pages-ready)
bun run preview      # serve the built bundle locally
bun run typecheck    # tsc -b --noEmit
```

Bun is the supported runtime, but `npm install && npm run dev` works the same
way — Vite is the only thing the scripts actually invoke.

## Deploying to Cloudflare Pages

1. Push the repo to GitHub.
2. In Cloudflare Pages → **Create a project** → connect the repo.
3. Build command: `bun run build`. Output directory: `dist`.
4. The bundled `public/_headers` and `public/_redirects` ship with sensible
   defaults (CSP, immutable asset caching, SPA fallback). Override them only
   if you change the asset layout.

The site is a static SPA — there is no server runtime to configure.

## Architecture

The codebase is split into four layers. Lower layers never import from higher
ones; that is the rule that keeps the editor scalable.

```
                      ┌────────────────────────────┐
                      │  src/features/             │   <-- React UI
                      │  · builder/  · preview/    │
                      │  · share/                  │
                      └──────────────┬─────────────┘
                                     │
                      ┌──────────────┴─────────────┐
                      │  src/core/state/           │   <-- Zustand store
                      │  src/core/serialization/   │   <-- URL / JSON I/O
                      │  src/core/factory/         │   <-- new-component defaults
                      └──────────────┬─────────────┘
                                     │
                      ┌──────────────┴─────────────┐
                      │  src/core/schema/          │   <-- Discord V2 schema
                      │  types · guards · traversal│       limits · validation
                      └────────────────────────────┘
```

### Layer 1 — Schema (`src/core/schema`)

`types.ts` mirrors the Discord Components V2 wire format. Components are a
tagged union with the numeric `type` field as the discriminator. Editor-only
state (a stable `_id` for selection and reordering) is the only deviation
from the wire format, and it is stripped on export.

- **Discriminated unions, not classes.** TypeScript narrows on `type`
  everywhere; no runtime polymorphism is needed.
- **`guards.ts`** centralizes the `is*` helpers so renderers/inspectors
  never repeat the same check.
- **`traversal.ts`** is the single source of recursion: `walk`, `findById`,
  `updateById`, `removeById`. Reducers never recurse on their own.
- **`limits.ts`** holds every Discord-enforced cap as named constants.
  When Discord raises a limit, change it here and nothing else.
- **`validation.ts`** turns a message into a list of `ValidationIssue`s
  graded `error | warning`. Errors block export; warnings are shown inline.

### Layer 2 — State, Serialization, Factory (`src/core/state`, `…/serialization`, `…/factory`)

- **`messageStore.ts`** is the only Zustand store. It owns the active
  message, the current selection, and an undo/redo ring. Every structural
  edit goes through a named action — no component calls `setState` directly.
  Each action snapshots before mutating, so undo is just "pop a frame".
- **`createComponent.ts`** is the single source of "what a fresh component
  looks like". Both the `+` menus and the importer rely on it, so adding a
  new component type means writing one factory.
- **`serialization/encode.ts`** pipes the editor tree through three stages:
  *strip editor fields* → *JSON* → *LZ-String URL-safe compress*. The
  inverse runs on decode. A `v{N}.<body>` prefix carries the wire-format
  version; `version.ts` registers migrations for future schema bumps.
- **`serialization/url.ts`** owns reading and writing the `#s=<token>`
  hash fragment. Share state lives in the URL hash because hashes never
  reach the server — the share payload stays private to whoever has the URL.

### Layer 3 — Features (`src/features`)

- **`builder/`** — tree view, per-component-type inspectors, contextual
  `+` menus. The dispatcher in `Inspector.tsx` switches on `type` and
  delegates to a dedicated `…Inspector` component per type. Adding a new
  component type means adding one inspector file and one entry in the
  switch — nothing else.
- **`preview/`** — the live Discord-style render of the message. The
  `markdown/` subfolder is a small Discord-flavored markdown parser
  (`parse.ts`) and a JSX renderer (`Markdown.tsx`) sitting strictly above
  it. Component renderers go through `renderers/ComponentRenderer.tsx`,
  which is the mirror image of the inspector dispatcher.
- **`share/`** — the share/export/import modal. Stateless w.r.t. the
  store; reads on open, writes through `replaceMessage` on import.

### Layer 4 — App shell (`src/app`)

`App.tsx` composes everything. Two hooks live here:

- **`useShareUrlBootstrap`** — on first mount, decodes `#s=<token>` (if
  any) and replaces the active message. Failures surface as a toast; the
  editor still opens.
- **`useKeyboardShortcuts`** — global `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z`
  for undo/redo. Ignored while the user is typing in a field.
- **`useAutoSaveDraft`** — subscribes to the message store and writes the
  wire payload to `localStorage` (debounced 300ms). Combined with the
  bootstrap path in `messageStore`, this is what makes a refresh resume the
  in-progress message. The draft is keyed `dwb.draft.v1` and is plain text
  — no credentials live there.

An `ErrorBoundary` wraps the whole app so a bad inspector edit can't blank
the page.

## Adding a new component type

This is the test of how well the layers hold up. Adding a hypothetical
"poll" component:

1. Add a `PollComponent` variant to `src/core/schema/types.ts` and include
   it in the relevant unions (`TopLevelComponent`, etc).
2. Add `isPoll` to `src/core/schema/guards.ts`.
3. Add an entry to `COMPONENT_META` in `src/core/schema/metadata.ts` and
   include the type in `TOP_LEVEL_PICKER` / `CONTAINER_PICKER` as
   appropriate.
4. Add `createPoll` to `src/core/factory/createComponent.ts` and register
   it in `COMPONENT_FACTORIES`.
5. Add validation rules in `src/core/schema/validation.ts`.
6. Add a `PollRenderer` in `src/features/preview/renderers/` and wire it
   into `ComponentRenderer.tsx`'s switch.
7. Add a `PollInspector` in `src/features/builder/components/inspectors/`
   and wire it into `Inspector.tsx`.

No other file needs to change. The dispatchers are exhaustive switches, so
TypeScript will flag any place you forgot.

## Sending, restoring, and updating

The **Send** tab in *Share / Send / Export* posts the current message to a
Discord webhook directly from the browser (Discord allows CORS on the
webhook execute endpoint). The webhook URL never leaves your machine — there
is no backend to forward it through, and history is opt-in per submission
and stored in `localStorage` only.

The **Restore** tab does the inverse: paste a webhook URL plus a message ID
(or link) and the editor pulls the message back via
`GET /webhooks/{id}/{token}/messages/{message_id}`. After restoring, the
Send tab automatically switches into "Update the original" mode, which
sends a **PATCH** instead of a POST so your edits replace the live message
rather than posting a copy. You can switch back to "Send as a copy" with
one click — both modes share the same webhook input.

Authorization caveat: only the webhook that *originally posted* a message
can fetch or edit it. A user-, bot-, or different-webhook-authored message
in the same channel will 404. We surface that explicitly in the Restore
panel because the raw error is misleading.

`src/core/webhook/send.ts` owns all three HTTP calls (`sendToWebhook`,
`fetchWebhookMessage`, `updateWebhookMessage`) — status mapping,
rate-limit parsing, and abort support are shared. `src/core/webhook/history.ts`
owns the localStorage list of remembered webhooks. The CSP in
`public/_headers` allow-lists `discord.com`, `canary.discord.com`,
`ptb.discord.com`, and `discordapp.com` under `connect-src`. If you fork
the app to talk to a different host, edit that header.

## Wire-format compatibility

The exported payload (from the **JSON export** tab) is the body you POST to
`https://discord.com/api/webhooks/{id}/{token}?with_components=true`. Set
the `IS_COMPONENTS_V2` flag (`1 << 15`) on send — `MESSAGE_FLAG_IS_COMPONENTS_V2`
in `src/core/schema/types.ts` is the same value. The **Send** tab attaches it
automatically.

The exporter strips:
- editor `_id` fields,
- any `undefined` optional (kept null when the user explicitly cleared it).

## Tech stack

- **Runtime**: Bun (also runs on Node 20+)
- **Bundler**: Vite 5 with `@vitejs/plugin-react-swc`
- **UI**: React 18 + TypeScript strict
- **State**: Zustand
- **Compression**: LZ-String (URL-safe encoding)
- **Styling**: CSS Modules + CSS variables (no runtime CSS-in-JS)

The first-paint bundle is the editor only; `lz-string` is split into its own
chunk because decoding is only needed when landing on a share URL.

## Deployment

Hosted on Cloudflare Pages with automatic builds on every push.

## License

MIT.
