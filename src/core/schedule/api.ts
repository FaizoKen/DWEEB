/**
 * Client for the proxy's scheduled-post API (`server/src/schedule.rs`).
 *
 * Rides on the same `VITE_PROXY_BASE_URL` as the other proxy features — with no
 * proxy configured the Schedule tab is hidden, so these are only ever called
 * when `isScheduleConfigured()` is true. Requests send `credentials: "include"`
 * so the proxy can recognise a signed-in owner, and an `X-Manage-Token` header
 * for anonymous per-schedule management.
 *
 * Nothing here throws — every call resolves to a discriminated result so callers
 * branch on `ok` instead of try/catch.
 */

import { PROXY_BASE_URL } from "@/core/guild/config";
import type { Recurrence } from "./recurrence";

/** True when a proxy is configured, i.e. scheduling is available. */
export function isScheduleConfigured(): boolean {
  return PROXY_BASE_URL.length > 0;
}

/** The masked schedule the API returns (no webhook URL/token ever). */
export interface ScheduleView {
  id: string;
  title?: string | null;
  webhook_id: string;
  dest_label?: string | null;
  thread_id?: string | null;
  tz: string;
  recurrence: Recurrence;
  next_run_at: number;
  status: "active" | "sending" | "done" | "failed" | "paused";
  attempts: number;
  last_status?: number | null;
  last_error?: string | null;
  last_run_at?: number | null;
  last_message_id?: string | null;
  runs_count: number;
  end_at?: number | null;
  max_runs?: number | null;
  created_at: number;
  owned: boolean;
  /** Present only on a single-schedule GET — the decrypted message payload. */
  payload?: unknown;
}

export interface CreateScheduleInput {
  webhook_url: string;
  thread_id?: string;
  payload: unknown;
  tz: string;
  recurrence: Recurrence;
  /** Absolute fire time (unix seconds) — required for a `once` schedule. */
  start_at?: number;
  end_at?: number;
  max_runs?: number;
  title?: string;
  dest_label?: string;
}

export interface ScheduleUpdateInput {
  title?: string;
  dest_label?: string;
  thread_id?: string;
  payload?: unknown;
  webhook_url?: string;
  tz?: string;
  recurrence?: Recurrence;
  start_at?: number;
  /** `<= 0` clears the end date. */
  end_at?: number;
  /** `<= 0` clears the run cap. */
  max_runs?: number;
  paused?: boolean;
}

export type CreateScheduleResult =
  | { ok: true; id: string; manage_token: string; next_run_at: number }
  | { ok: false; error: string; status: number };

export type ScheduleResult =
  | { ok: true; schedule: ScheduleView }
  | { ok: false; error: string; status: number };

export type ListResult =
  | { ok: true; items: ScheduleView[] }
  | { ok: false; error: string; status: number };

export type CancelResult = { ok: true } | { ok: false; error: string; status: number };

function authHeaders(manageToken?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (manageToken) h["X-Manage-Token"] = manageToken;
  return h;
}

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `Server returned ${res.status}.`;
}

/** Create a schedule. The `manage_token` it returns is shown once — store it. */
export async function createSchedule(input: CreateScheduleInput): Promise<CreateScheduleResult> {
  if (!isScheduleConfigured()) {
    return { ok: false, error: "Scheduling isn't configured on this deployment.", status: 0 };
  }
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/schedules`, {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the scheduling service.", status: 0 };
  }
  const data = (await res.json().catch(() => null)) as {
    id?: string;
    manage_token?: string;
    next_run_at?: number;
    error?: string;
  } | null;
  if (!res.ok || !data?.id || !data.manage_token) {
    return { ok: false, error: data?.error ?? `Server returned ${res.status}.`, status: res.status };
  }
  return {
    ok: true,
    id: data.id,
    manage_token: data.manage_token,
    next_run_at: data.next_run_at ?? 0,
  };
}

/** Fetch one schedule (masked + its decrypted payload). */
export async function getSchedule(id: string, manageToken?: string): Promise<ScheduleResult> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/schedules/${encodeURIComponent(id)}`, {
      headers: authHeaders(manageToken),
      credentials: "include",
    });
  } catch {
    return { ok: false, error: "Couldn't reach the scheduling service.", status: 0 };
  }
  if (!res.ok) return { ok: false, error: await readError(res), status: res.status };
  const schedule = (await res.json().catch(() => null)) as ScheduleView | null;
  if (!schedule?.id) return { ok: false, error: "Malformed response.", status: res.status };
  return { ok: true, schedule };
}

/** List the signed-in user's schedules (cross-device). */
export async function listMine(): Promise<ListResult> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/schedules`, { credentials: "include" });
  } catch {
    return { ok: false, error: "Couldn't reach the scheduling service.", status: 0 };
  }
  if (!res.ok) return { ok: false, error: await readError(res), status: res.status };
  const data = (await res.json().catch(() => null)) as { items?: ScheduleView[] } | null;
  return { ok: true, items: data?.items ?? [] };
}

/** Edit / reschedule / pause / resume a schedule. */
export async function updateSchedule(
  id: string,
  patch: ScheduleUpdateInput,
  manageToken?: string,
): Promise<ScheduleResult> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: authHeaders(manageToken),
      credentials: "include",
      body: JSON.stringify(patch),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the scheduling service.", status: 0 };
  }
  if (!res.ok) return { ok: false, error: await readError(res), status: res.status };
  const schedule = (await res.json().catch(() => null)) as ScheduleView | null;
  if (!schedule?.id) return { ok: false, error: "Malformed response.", status: res.status };
  return { ok: true, schedule };
}

/** Cancel (delete) a schedule. */
export async function cancelSchedule(id: string, manageToken?: string): Promise<CancelResult> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE_URL}/api/schedules/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(manageToken),
      credentials: "include",
    });
  } catch {
    return { ok: false, error: "Couldn't reach the scheduling service.", status: 0 };
  }
  if (!res.ok) return { ok: false, error: await readError(res), status: res.status };
  return { ok: true };
}
