/**
 * Pure crash-report logic — no browser globals, no network.
 *
 * The browser glue in `reporter.ts` supplies the raw pieces (a thrown value, the
 * current path, the surface); everything here is a pure transform so it can be
 * unit-tested without a DOM. Two jobs:
 *
 *  1. **Shape** an untrusted thrown value into a bounded, content-free wire
 *     payload — the error message, a few stack frames, version, surface, and the
 *     URL *path* (never the `#hash`, which carries the user's message). The proxy
 *     re-clamps everything, but clamping here too keeps the beacon small on the
 *     wire and the intent obvious at the call site.
 *
 *  2. **Throttle** so a crash *loop* (a render error that re-throws every frame)
 *     can't turn into a flood of beacons: each distinct signature is sent once,
 *     and a hard per-session cap bounds the total regardless.
 */

/** Where the error surfaced. */
export type CrashKind = "error" | "unhandledrejection" | "boundary";

/** The content-free beacon sent to `POST /api/telemetry/crash`. */
export interface CrashPayload {
  kind: CrashKind;
  message: string;
  stack: string;
  version: string;
  surface: string;
  path: string;
}

/** Everything the pure builder needs; the glue reads these from the environment. */
export interface CrashInput {
  kind: CrashKind;
  /** The raw thrown value — an `Error`, a string, or anything at all. */
  error: unknown;
  /** `location.pathname` only (the caller must not pass query or hash). */
  path: string;
  /** `"web"` or `"activity"`. */
  surface: string;
  /** The app build version. */
  version: string;
}

// Client-side caps. Mirror the server's (`telemetry.rs`) so what we build is what
// lands in a log line — a touch of headroom on the message since the server is
// the final authority.
const MESSAGE_MAX = 300;
const STACK_MAX = 800;
/** Stack traces are deep and mostly noise after the throwing frames; the top few
 *  identify the site, and more just eats the byte budget. */
const STACK_FRAMES = 6;

/**
 * Coax an unknown thrown value into a `{ message, stack }` pair without ever
 * throwing itself (a reporter that crashes on a weird throw is worse than
 * useless). Handles the common shapes: `Error`, a bare string, an object with a
 * `message`, and the truly unexpected (numbers, `null`, symbols).
 */
export function describeError(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || "Error",
      stack: typeof error.stack === "string" ? error.stack : "",
    };
  }
  if (typeof error === "string") {
    return { message: error, stack: "" };
  }
  // ErrorEvent-like / object with a message, but not an Error instance.
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      const stack = (error as { stack?: unknown }).stack;
      return { message, stack: typeof stack === "string" ? stack : "" };
    }
  }
  // Anything else: a best-effort, never-throwing string.
  return { message: safeStringify(error), stack: "" };
}

/** `String(x)` that can't throw (a Symbol, or an object with a hostile
 *  `toString`), falling back to the value's type. */
function safeStringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return `<unstringifiable ${typeof value}>`;
  }
}

/** Keep only the top `n` non-empty lines of a stack — the frames nearest the
 *  throw — trimmed of surrounding whitespace. */
export function topFrames(stack: string, n: number = STACK_FRAMES): string {
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, n)
    .join("\n");
}

/** Truncate to at most `max` characters (never mid-surrogate-pair concerns here —
 *  the server clamps by `char` too, and these are ASCII-ish code paths). */
function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * A stable signature for de-duplication: the same bug throwing every frame
 * produces the same signature, so the throttle sends it once. Deliberately
 * coarse (kind + message + first frame) — a differing line/column shouldn't
 * defeat de-dup, but a genuinely different error should get through.
 */
export function crashSignature(kind: CrashKind, message: string, stack: string): string {
  const firstFrame =
    stack
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return `${kind}|${message}|${firstFrame}`;
}

/** Build the content-free wire payload from an untrusted thrown value. */
export function buildCrashPayload(input: CrashInput): CrashPayload {
  const { message, stack } = describeError(input.error);
  return {
    kind: input.kind,
    message: clamp(message, MESSAGE_MAX),
    stack: clamp(topFrames(stack), STACK_MAX),
    version: input.version,
    surface: input.surface,
    path: input.path,
  };
}

/**
 * Per-session send gate. Pure and self-contained (no timers, no storage): the
 * reporter holds one instance for the page's lifetime and asks it before every
 * send. Two guards, both intentional:
 *
 *  - **Dedup:** one beacon per distinct signature, so a re-throwing render loop
 *    reports once, not once per frame.
 *  - **Hard cap:** at most `max` beacons total, so even a storm of *distinct*
 *    errors (each a new signature) can't flood the endpoint.
 */
export class CrashThrottle {
  private readonly seen = new Set<string>();
  private sent = 0;

  constructor(private readonly max: number = 5) {}

  /** Record the intent to send `signature`; returns whether it should go out.
   *  Idempotent per signature and monotonic in the total count. */
  shouldSend(signature: string): boolean {
    if (this.sent >= this.max) return false;
    if (this.seen.has(signature)) return false;
    this.seen.add(signature);
    this.sent += 1;
    return true;
  }
}
