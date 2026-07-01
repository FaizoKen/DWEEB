/**
 * Best-effort handshake telemetry for the embedded Activity.
 *
 * A real in-Discord launch runs in a sandboxed iframe with no reachable console,
 * so when a launch stalls we otherwise have nothing to go on but the on-screen
 * stage label — and only if a user happens to report it. This fires a tiny,
 * fire-and-forget beacon to the proxy at each handshake stage (and on failure),
 * so *where* launches stall in the wild becomes measurable in the server logs.
 *
 * It's purely diagnostic: it never blocks, never throws into the caller, and a
 * dropped beacon is fine (the launch outcome doesn't depend on it). Gated to a
 * real production Activity — the web app never runs the handshake, and the dev
 * URL-override can't reach the proxy anyway (its faux ticket 404s every proxied
 * call — see `activityStore`), so beaconing there would be pure noise.
 */

import { proxyFetch } from "@/core/net/proxyFetch";
import { isActivityMode } from "./runtime";
import type { ActivityStep } from "./activityStore";

/** What happened at a stage: we advanced *into* it (`reached`), the handshake
 *  fully completed (`done`), or it failed — distinguishing a per-stage timeout
 *  from any other error, since a timeout is the signature of a silent hang. */
export type StageOutcome = "reached" | "done" | "error" | "timeout";

/** Correlation + context carried alongside a stage beacon. */
export interface StageInfo {
  platform?: string | null;
  instance?: string | null;
  /** A short failure reason — only sent on `error` / `timeout`. */
  detail?: string | null;
}

/** A per-launch tracer: stamps every beacon with one launch id and the elapsed
 *  time since the handshake began, so the server can reconstruct one launch's
 *  timeline and per-stage durations from the log stream. */
export interface HandshakeTrace {
  stage(step: ActivityStep, outcome: StageOutcome, info?: StageInfo): void;
}

/** Only beacon from a real, production Activity (see the module doc). */
function enabled(): boolean {
  return isActivityMode() && import.meta.env.PROD;
}

function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function launchId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

/** Begin tracing one launch's handshake. Cheap and side-effect-free until a
 *  stage is recorded; `stage()` self-gates, so callers can trace unconditionally. */
export function startHandshakeTrace(): HandshakeTrace {
  const launch = launchId();
  const t0 = nowMs();
  return {
    stage(step, outcome, info = {}) {
      if (!enabled()) return;
      const payload: Record<string, unknown> = {
        launch,
        stage: step,
        outcome,
        ms: Math.round(nowMs() - t0),
      };
      if (info.platform) payload.platform = info.platform;
      if (info.instance) payload.instance = info.instance;
      // Only a failure carries a reason, and keep it short — the server also
      // clamps it, but there's no point shipping a wall of text.
      if (info.detail) payload.detail = info.detail.slice(0, 200);
      try {
        // `keepalive` so the beacon still flushes if the page is torn down right
        // after (a relaunch, or the user bailing on a stall). Errors are swallowed
        // — telemetry must never perturb the launch it's measuring.
        void proxyFetch("/api/activity/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* never let telemetry disturb the launch */
      }
    },
  };
}
