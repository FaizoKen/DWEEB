# `mcp/` — DWEEB's Model Context Protocol server

Lets an AI assistant build, check, and post Discord Components V2 messages
through DWEEB. Speaks MCP over stdio.

```bash
bun run mcp:check     # what this environment would give the server
bun run mcp           # serve on stdio
bun run mcp -- --help # flags and every environment variable
```

Connect a client with `bun /path/to/DWEEB/mcp/src/main.ts` as the command.

Everything — client setup, the environment, the tool reference, and why there
is no SDK dependency — is in **[`docs/mcp.md`](../docs/mcp.md)**.

Two things worth knowing before editing anything here:

- **This is a shell around `src/core`, not a second implementation.** The
  schema, validator, encoder, templates, and webhook client are the web app's.
  Adding a rule here that the app does not have is a bug; add it to `src/core`
  and both get it.
- **stdout carries the protocol.** Every diagnostic goes to stderr. One stray
  `console.log` anywhere in the process breaks the client's parser.

Tests live beside the source and run in the repository's own suite
(`bun run test`); the code is type-checked by `bun run typecheck` through
`mcp/tsconfig.json`, which the root solution file references.
