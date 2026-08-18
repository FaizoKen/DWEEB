#!/usr/bin/env bun
/**
 * Executable entry point for the DWEEB MCP server.
 *
 * Deliberately trivial: it exists so that importing the server's assembly
 * (`index.ts`) never starts anything. Point an MCP client at this file —
 *
 *     "command": "bun", "args": ["/path/to/DWEEB/mcp/src/main.ts"]
 *
 * — or run `bun run mcp` from the repository root.
 *
 * Nothing here may write to stdout: that stream carries the protocol. The exit
 * code is set rather than forced with `process.exit`, so any queued stdout
 * write is flushed before the process ends.
 */

import { main } from "./index";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`dweeb-mcp: fatal: ${(e as Error).stack ?? String(e)}\n`);
    process.exitCode = 1;
  });
