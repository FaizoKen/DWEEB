/**
 * Client for the proxy's per-server message library
 * (`server/src/library.rs`).
 *
 * The library is one shared, labelled shelf of messages per Discord server —
 * the sole home of posted history (nothing posted is kept in the browser) and
 * the server-side twin of the browser-local saved store. It's readable
 * and writable by anyone holding Manage Webhooks there — from the web app
 * (cookie session) *and* the embedded Activity (bearer token), which is why
 * every call rides {@link proxyFetch}.
 *
 * Nothing here throws — every call resolves to a discriminated result so
 * callers branch on `ok` instead of try/catch.
 */

import { PROXY_BASE_URL } from "@/core/guild/config";
import { proxyFetch } from "@/core/net/proxyFetch";

/** True when a proxy is configured, i.e. the library can exist. */
export function isLibraryConfigured(): boolean {
  return PROXY_BASE_URL.length > 0;
}

/** The two stored labels. Scheduled / never-expire are *derived* client-side
 *  from their own APIs, never stored here. */
export type LibraryLabel = "posted" | "draft";

/** One library entry as the API returns it — metadata plus the decrypted
 *  payload and, on posted entries, the webhook execute URL that lets a reload
 *  update the live message in place. */
export interface LibraryEntryView {
  id: string;
  guild_id: string;
  label: LibraryLabel;
  title?: string | null;
  /** Wire-format message payload (raw `{placeholder}` tokens preserved when
   *  the entry came from the web builder). Null if the seal couldn't be
   *  opened (rotated SESSION_SECRET). */
  payload: unknown;
  /** Canonical webhook execute URL — posted entries only. */
  webhook_url?: string | null;
  webhook_id?: string | null;
  /** The custom bot a posted entry was posted as (application id), when it
   *  wasn't DWEEB. The Activity threads this back into its edit path so a
   *  gallery-loaded message updates through the identity that authored it.
   *  Null/absent = DWEEB, or a row recorded before this was tracked. */
  application_id?: string | null;
  channel_id?: string | null;
  message_id?: string | null;
  thread_id?: string | null;
  /** Display-only destination, e.g. `#general`. */
  dest_label?: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface LibraryCreateInput {
  label: LibraryLabel;
  title?: string;
  payload: unknown;
  webhook_url?: string;
  channel_id?: string;
  message_id?: string;
  thread_id?: string;
  dest_label?: string;
}

export interface LibraryPatchInput {
  title?: string;
  /** Drafts only — a posted entry's content mirrors what was sent (400). */
  payload?: unknown;
}

/** Usage of one quota bucket. The two labels are quota'd separately: posted is
 *  a rolling history window (recording past it evicts the oldest, so it can't
 *  fill up), drafts are a hard cap (full = save refused). `quota` null =
 *  unlimited. */
export interface LibraryBucketUsage {
  used: number;
  quota: number | null;
}

export type LibraryListResult =
  | {
      ok: true;
      items: LibraryEntryView[];
      posted: LibraryBucketUsage;
      drafts: LibraryBucketUsage;
    }
  | { ok: false; error: string; status: number };

export type LibraryEntryResult =
  | { ok: true; entry: LibraryEntryView }
  | { ok: false; error: string; status: number };

export type LibraryDeleteResult = { ok: true } | { ok: false; error: string; status: number };

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `Server returned ${res.status}.`;
}

/** The server's library: entries (newest touched first) and the per-bucket
 *  usage (posted history window / saved-draft quota). Needs Manage Webhooks in
 *  the guild. */
export async function listLibrary(guildId: string): Promise<LibraryListResult> {
  if (!isLibraryConfigured()) {
    return {
      ok: false,
      error: "The message library isn't configured on this deployment.",
      status: 0,
    };
  }
  let res: Response;
  try {
    res = await proxyFetch(`/api/guilds/${encodeURIComponent(guildId)}/library`);
  } catch {
    return { ok: false, error: "Couldn't reach the library service.", status: 0 };
  }
  if (!res.ok) return { ok: false, error: await readError(res), status: res.status };
  const data = (await res.json().catch(() => null)) as {
    items?: LibraryEntryView[];
    posted?: Partial<LibraryBucketUsage> | null;
    drafts?: Partial<LibraryBucketUsage> | null;
  } | null;
  const items = data?.items ?? [];
  // A proxy that predates the split sends no buckets — derive the counts from
  // the items and treat the caps as unknown (unlimited) until it's upgraded.
  const bucket = (
    sent: Partial<LibraryBucketUsage> | null | undefined,
    label: LibraryLabel,
  ): LibraryBucketUsage => ({
    used: sent?.used ?? items.filter((e) => e.label === label).length,
    quota: sent?.quota ?? null,
  });
  return {
    ok: true,
    items,
    posted: bucket(data?.posted, "posted"),
    drafts: bucket(data?.drafts, "draft"),
  };
}

/** Store a message. A `posted` entry with a `message_id` upserts — re-posting
 *  the same message refreshes its one row instead of duplicating it. */
export async function createLibraryEntry(
  guildId: string,
  input: LibraryCreateInput,
): Promise<LibraryEntryResult> {
  if (!isLibraryConfigured()) {
    return {
      ok: false,
      error: "The message library isn't configured on this deployment.",
      status: 0,
    };
  }
  let res: Response;
  try {
    res = await proxyFetch(`/api/guilds/${encodeURIComponent(guildId)}/library`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the library service.", status: 0 };
  }
  if (!res.ok) return { ok: false, error: await readError(res), status: res.status };
  const entry = (await res.json().catch(() => null)) as LibraryEntryView | null;
  if (!entry?.id) return { ok: false, error: "Malformed response.", status: res.status };
  return { ok: true, entry };
}

/** Rename an entry, or save new content over a draft. */
export async function updateLibraryEntry(
  guildId: string,
  id: string,
  patch: LibraryPatchInput,
): Promise<LibraryEntryResult> {
  let res: Response;
  try {
    res = await proxyFetch(
      `/api/guilds/${encodeURIComponent(guildId)}/library/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
  } catch {
    return { ok: false, error: "Couldn't reach the library service.", status: 0 };
  }
  if (!res.ok) return { ok: false, error: await readError(res), status: res.status };
  const entry = (await res.json().catch(() => null)) as LibraryEntryView | null;
  if (!entry?.id) return { ok: false, error: "Malformed response.", status: res.status };
  return { ok: true, entry };
}

/** Delete an entry from the server's library. */
export async function deleteLibraryEntry(
  guildId: string,
  id: string,
): Promise<LibraryDeleteResult> {
  let res: Response;
  try {
    res = await proxyFetch(
      `/api/guilds/${encodeURIComponent(guildId)}/library/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  } catch {
    return { ok: false, error: "Couldn't reach the library service.", status: 0 };
  }
  if (!res.ok) return { ok: false, error: await readError(res), status: res.status };
  return { ok: true };
}
