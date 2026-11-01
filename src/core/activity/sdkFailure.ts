/**
 * Turn a rejected Embedded App SDK command into an `Error` worth showing.
 *
 * The SDK rejects a failed command with Discord's RPC payload itself — a plain
 * `{ code, message }`, not an `Error` (`Discord.mjs`: `reject(parsed.data)`) — so
 * `String(err)` read `[object Object]`. That text reached both the launch failure
 * splash and the handshake beacon: 7 of 107 launches in October failed at
 * `authorize` showing exactly that, and left no reason in the logs either.
 *
 * The code stays in the message because the beacon carries only this text, and
 * the code is what tells a refused consent from a misconfigured app.
 */
export function sdkFailure(err: unknown, stage: string): Error {
  if (err instanceof Error) return err;
  const { code, message } = (typeof err === "object" && err !== null ? err : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const said = typeof message === "string" ? message.trim().replace(/\.+$/, "") : "";
  const reason = said || "Discord gave no reason";
  const suffix = typeof code === "number" ? ` (code ${code})` : "";
  return new Error(`Couldn't finish ${stage}: ${reason}${suffix}. Try relaunching DWEEB.`);
}
