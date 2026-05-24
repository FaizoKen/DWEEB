# CLAUDE.md

Project-specific guidance for Claude / Claude Code when working in this repo.
Read this file before touching anything — it captures conventions and traps
that aren't obvious from skimming the source.

## What this app is

A 100% client-side, statically-hosted Discord webhook builder for
**Components V2 only**. No backend. State lives in a Zustand store; share
state lives in the URL hash; webhook URLs (when sending) live in the user's
browser only.

Deploy target is Cloudflare Pages. Runtime is Bun, but Vite is what does the
actual work — `npm`/`pnpm` work too.

## Commands

```bash
bun install
bun run dev          # http://localhost:5173
bun run build        # tsc -b && vite build → dist/
bun run preview      # serve dist/ locally
bun run typecheck    # tsc -b --noEmit
```

**Before claiming a task is done:** run `bun run typecheck` (or
`bun run build`). The dev server uses Vite's on-the-fly transform and
**skips `tsc`** — code that runs locally can still fail the production
build. The TypeScript config is strict
(`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`) so
most logic bugs surface there. The first Cloudflare deploy failed on 40+
errors because of exactly this mistake.

## Layer rule (read this once, never forget)

```
src/features  ──► src/core/{state,serialization,factory,webhook}  ──►  src/core/schema
   (UI)                  (orchestration)                                (truth)
```

**A lower layer must never import from a higher one.** That rule is what
keeps the app extensible. If you find yourself wanting to import a React
component from `src/core/`, you're solving the wrong problem.

- `src/core/schema/` — Discord Components V2 wire shape. **No** UI strings,
  **no** React. Pure types + pure functions.
- `src/core/state/` — single Zustand store + actions. The only place that
  mutates the message tree.
- `src/core/serialization/` — URL hash + JSON encoding/decoding, version
  migrations.
- `src/core/factory/` — `createX` helpers that produce fresh components
  with an `_id` already stamped.
- `src/core/webhook/` — Discord webhook execution + opt-in history.
- `src/features/` — React UI. Each feature folder is self-contained.
- `src/app/` — composition root, hooks, error boundary.
- `src/ui/` — styling primitives (Button, Modal, Field, …) — no business
  logic, no store imports.

## Non-obvious conventions

### Every component carries `_id` — only inside the editor

`_id` is editor-only. It exists so the builder can track selection and
reordering without relying on array indices.
`src/core/serialization/normalize.ts:stripEditorFields` strips it before
export. **Never** include `_id` in anything the user copies or sends.

### All tree edits go through the store

There is no `useState` for message data. Every structural change is a
named action on `useMessageStore`. If you find a component calling
`useState` to track part of a message, you're holding it wrong — read it
from the store, write it back through an action.

### All recursion goes through `traversal.ts`

`walk`, `findById`, `updateById`, `removeById`. Reducers and renderers
never recurse on their own; that's how subtle bugs (skipping accessories,
forgetting gallery items, miscounting components) creep in.

### `patchNode` vs `replaceNode`

```ts
patch:   { ...node, ...partial }   // merges into the existing node
replace: { ...next,  _id: node._id } // replaces structural fields
```

Use **patch** when changing a value (e.g. a TextDisplay's `content`).
Use **replace** when changing structure (e.g. flipping a Button from Link
style to Primary — old `url` would otherwise linger and leak into export).
This already bit the ButtonInspector once.

### Two style namespaces

- `--app-*` drives the editor shell (toolbar, tree, inspector, modal).
- `--discord-*` drives the preview pane and renderers.

Mixing them is a smell. The preview is supposed to look like Discord
regardless of any future shell theming we add.

### Share state lives in the URL hash

`#s=<token>` only. Never put share state in the query string — that would
ship to the server (Cloudflare logs) and break the privacy story. The
hash is read once on mount by `useShareUrlBootstrap`, then we stop watching
it.

### Webhook URLs are credentials

`src/features/share/SendPanel.tsx`:
- `type="password"` by default, with a Show/Hide toggle.
- `autoComplete="off"` keeps password managers out.
- History is **opt-in per submission**, stored only in `localStorage`.
- Never log a webhook URL to console.

## Pitfalls that already bit us

1. **Variable shadowing in strict mode.** `const message = …` inside a
   function whose parameter is `message: WebhookMessage` is a runtime
   `SyntaxError` (caused a blank black page before fix). Use distinct
   names like `errorMessage`. ESM is always strict.

2. **`Exclude<TopLevelFactoryKey, "container">` is a no-op.** Factory keys
   are numeric (the Discord component-type IDs), not strings. Use
   `Exclude<TopLevelFactoryKey, typeof ComponentType.Container>` —
   `ContainerChildFactoryKey` already does this.

3. **`patchNode` doesn't remove fields.** Switching button styles via
   patch leaves stale `url`/`custom_id`/`sku_id` keys in the wire output.
   Use `replaceNode`.

4. **CSP blocks fetches.** `public/_headers` allow-lists `discord.com`,
   `discordapp.com`, `canary.discord.com`, `ptb.discord.com` under
   `connect-src`. If you add another network destination, update both the
   CSP and the README.

5. **Components V2 message ≠ classic message.** With the
   `IS_COMPONENTS_V2` flag set, Discord rejects payloads that also carry
   `content` or `embeds`. `WebhookMessage` deliberately has no `content`
   or `embeds` field — keep it that way.

## Adding a Components V2 component type

Touch these files in order:

1. `src/core/schema/types.ts` — variant + add to relevant unions.
2. `src/core/schema/guards.ts` — `isX`.
3. `src/core/schema/metadata.ts` — `COMPONENT_META[X]` + picker lists.
4. `src/core/factory/createComponent.ts` — `createX` + register.
5. `src/core/schema/validation.ts` — limits/structural checks.
6. `src/features/preview/renderers/XRenderer.tsx` + wire into
   `ComponentRenderer.tsx`.
7. `src/features/builder/components/inspectors/XInspector.tsx` + wire
   into `Inspector.tsx`.

The two dispatchers (`ComponentRenderer.tsx`, `Inspector.tsx`) are
exhaustive `switch` statements — TS will yell at you if you forget either.
Nothing else needs to change.

## Adding a wire-format migration

Bump `CURRENT_VERSION` in `src/core/serialization/version.ts` and register
a migration `{ [oldVersion]: (input) => transformedInput }`. Old share
URLs run through the chain on decode. Forward versions are rejected with a
"update the builder" message.

## Anti-patterns (don't)

- Don't add React Context for cross-component state. Use the Zustand
  store — it's already there and has selectors.
- Don't introduce a CSS-in-JS runtime (emotion, styled-components, …).
  Modules + tokens are the convention.
- Don't reach into `messageStore.setState` from a component. Add a named
  action instead. The history layer depends on actions being the only
  mutation entry point.
- Don't store anything sensitive in `sessionStorage`/`localStorage`
  without an explicit user opt-in (see how `webhook/history.ts` does it).
- Don't write `// removed X` comments after deleting code. Just delete it.
- Don't add ESLint/Prettier preset bloat. The single `.prettierrc.json` is
  it. If you need a lint rule, justify it.

## File map (top-level)

```
public/             static assets, _headers, _redirects
src/app/            App shell, providers, hooks, error boundary
src/core/schema/    types, guards, traversal, limits, validation, metadata
src/core/state/     messageStore.ts (single Zustand store)
src/core/serialization/  encode/decode, URL hash, version migrations
src/core/factory/   createX helpers for new components
src/core/webhook/   send.ts + history.ts
src/data/           message presets
src/features/
  builder/          tree + inspectors + add-menu
  preview/          Discord-style live render + markdown
  share/            share/send/export/import dialog
  toolbar/          top bar
src/lib/            tiny pure helpers (id, cn)
src/styles/         tokens.css, reset.css, global.css
src/ui/             reusable primitives (Button, Field, Modal, …)
```

## When something feels off

- **Preview doesn't update on edit** — you're probably not going through
  the store. Components must read from `useMessageStore`, not from a
  parent prop snapshot.
- **Selection ring on the wrong element** — `data-node-id` is set in
  `ComponentRenderer.tsx`. Accessories pass `noSelectionRing` so they
  don't double-highlight.
- **Imported message has weird ids / collisions** — `attachEditorFields`
  is the only correct way to ingest external JSON. It stamps fresh ids.
- **TypeScript errors after a schema change** — they're usually the
  exhaustive switches in `ComponentRenderer.tsx` and `Inspector.tsx`
  asking you to handle the new variant. That's the feature working.
