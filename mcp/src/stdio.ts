/**
 * The stdio transport.
 *
 * MCP over stdio is newline-delimited JSON: one message per line on stdin, one
 * per line on stdout. Three rules make or break it, and all three are the kind
 * of thing that "works on my machine" right up until it does not:
 *
 *  - **stdout carries protocol and nothing else.** A stray `console.log`
 *    anywhere in the process — a debug line, a warning from a dependency —
 *    lands mid-stream and the client's parser gives up on the connection. All
 *    diagnostics go to stderr, which the client shows as server logs.
 *  - **One message, one line.** `JSON.stringify` never emits a raw newline
 *    (they are escaped inside strings), so serializing is safe as-is, but
 *    nothing else may be written between a message and its terminator.
 *  - **Backpressure is real.** A large tool result can exceed the pipe buffer;
 *    ignoring `write`'s return value grows an unbounded queue in memory. Writes
 *    are chained through one promise so the next message waits for drain.
 *
 * Requests are handled concurrently — a tool call can take a network round-trip,
 * and a client is free to pipeline — but responses are serialized through the
 * same write chain, so lines never interleave.
 */

import type { Readable, Writable } from "node:stream";
import type { McpServer } from "./protocol";

/**
 * Longest unterminated run of input accepted before the buffer is discarded. A message big enough to
 * hit this is a runaway or a corrupt stream, not a Discord payload — the whole
 * message budget is 4000 characters, and even a share token of the maximum
 * message is a few kilobytes.
 */
const MAX_PENDING_CHARS = 8 * 1024 * 1024;

export interface StdioOptions {
  input: Readable;
  output: Writable;
  /** Where diagnostics go. Never `output`. */
  log: (line: string) => void;
}

export function serveStdio(server: McpServer, options: StdioOptions): Promise<void> {
  const { input, output, log } = options;
  let buffer = "";
  let writes: Promise<void> = Promise.resolve();
  let pending = 0;
  let ended = false;
  let finish: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const settleIfDone = (): void => {
    if (ended && pending === 0) finish();
  };

  const write = (payload: unknown): void => {
    const line = `${JSON.stringify(payload)}\n`;
    writes = writes.then(
      () =>
        new Promise<void>((resolve) => {
          if (!output.write(line)) output.once("drain", () => resolve());
          else resolve();
        }),
    );
  };

  const dispatch = (line: string): void => {
    pending++;
    void server
      .handleLine(line)
      .then((answer) => {
        if (answer) write(answer);
      })
      .catch((e: unknown) => {
        // `handleLine` reports its own failures; reaching here means the
        // transport itself broke, which the client cannot be told about.
        log(`dropped a message: ${(e as Error).message}`);
      })
      .finally(() => {
        pending--;
        settleIfDone();
      });
  };

  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_PENDING_CHARS && !buffer.includes("\n")) {
      log(`discarded ${buffer.length} characters with no message terminator`);
      buffer = "";
      return;
    }
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "").trim();
      buffer = buffer.slice(index + 1);
      if (line) dispatch(line);
      index = buffer.indexOf("\n");
    }
  });

  input.on("end", () => {
    // A trailing message with no newline is still a message.
    const rest = buffer.trim();
    buffer = "";
    if (rest) dispatch(rest);
    ended = true;
    settleIfDone();
  });

  input.on("error", (e: Error) => {
    log(`input stream failed: ${e.message}`);
    ended = true;
    settleIfDone();
  });

  return done.then(() => writes);
}
