/**
 * A generic, swap-proof OAuth-popup engine.
 *
 * Several flows here send the user to Discord and back: signing in, adding the
 * bot to a server, adding a server's own custom bot, and creating a webhook.
 * Running each in a popup keeps the in-progress message on screen instead of
 * throwing the whole builder away on a full-page redirect. They all share one
 * hard problem, so they share one implementation parameterised by a
 * {@link PopupFlow} descriptor.
 *
 * The hard problem: Discord's `oauth2/authorize` page swaps the popup into a new
 * browsing-context group. That SEVERS the opener's `popup` handle (so polling it
 * is useless — `popup.closed` reads true), NULLS the popup's `window.opener`, and
 * rewrites `window.name`. So none of the obvious "is this my popup / reach my
 * popup" references survive the round-trip.
 *
 * What *does* survive a context-group swap is per-origin web storage. So every
 * flow uses a localStorage HANDSHAKE: the opener marks "a <kind> popup is
 * pending" before opening it; the returning popup recognises itself purely from
 * that flag, and hands its result back over BOTH a BroadcastChannel and a
 * localStorage poll/`storage` event (each origin-global, swap-proof). The
 * opener's handle poll is kept as a fast best-effort extra. Browsers that block
 * the popup fall back to a full-page redirect, so a flow always completes.
 *
 * A result proves nothing about who asked for it: any page can open a DWEEB
 * window, or link to one, carrying a return URL of its choosing. So a result is
 * acted on only by the tab that started the flow — the opener holding a live
 * attempt for a popup, or the tab that redirected itself for a full-page return.
 * Without that, a crafted `#dweeb_webhook=<their webhook>` opened Send prefilled
 * with a stranger's webhook, and a click on Send posted the draft to them.
 *
 * All storage keys, the BroadcastChannel, and the popup's `window.name` are
 * derived from `flow.kind`, so flows never collide.
 */

/**
 * Describes one OAuth popup flow. `R` is the (JSON-serialisable) result the
 * popup hands back — a webhook URL, a "logged in", an added guild id, etc.
 */
export interface PopupFlow<R> {
  /** Unique slug. Namespaces every storage key, the BroadcastChannel, and the
   *  popup's `window.name` (`dweeb_<kind>`, `dweeb_<kind>_pending`, …). */
  kind: string;
  /** Read this flow's result out of a URL (the popup's own, or the opener
   *  reading the popup's, or the main tab on a full-page return) WITHOUT mutating
   *  it. Returns null when `loc` isn't a return for this flow. */
  parse(loc: { hash: string; search: string }): R | null;
  /** Whether a parsed result represents the user backing out / an error. */
  isError(result: R): boolean;
  /** Stable identity of a success (e.g. the webhook URL, or the added guild id),
   *  used to recognise one delivery arriving over several channels. */
  successKey(result: R): string;
  /** Whether every open tab acts on this flow's popup result, rather than only
   *  the tab that started the flow. Only for a result with nothing worth
   *  forging — the login flow's "finished" signal, which merely makes a tab
   *  re-read the session cookie every tab already shares — so a sign-in in one
   *  tab signs the others in too. */
  everyTab?: boolean;
  /** Fragment param names this flow leaves in the URL, stripped on a full-page
   *  return so the credential/marker doesn't linger in the address bar. */
  stripHashKeys?: string[];
  /** Query param names to strip on a full-page return (e.g. the bot-add flow). */
  stripSearchKeys?: string[];
  /** Shown in the popup's body just before it self-closes. */
  doneMessage?: string;
}

/** How long a pending-popup mark stays valid — long enough for a slow OAuth,
 *  short enough that an abandoned attempt can't haunt a later page load. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** The same result arriving twice this close together is one delivery that came
 *  over two channels (or from both the opener's handle poll and the popup's own
 *  relay) — not a second run of the flow, such as signing in again later. */
const DUPLICATE_WINDOW_MS = 3000;

const channelName = (kind: string) => `dweeb_${kind}`;
const pendingKey = (kind: string) => `dweeb_${kind}_pending`;
const resultKey = (kind: string) => `dweeb_${kind}_result`;
const selfRedirectKey = (kind: string) => `dweeb_${kind}_self_redirect`;
const attemptKey = (kind: string) => `dweeb_${kind}_attempt`;

/* ── this tab's attempts ────────────────────────────────────────────────── */

/**
 * Popup attempts this tab started, by kind → start time. Only a tab holding a
 * live attempt acts on a popup result (bar {@link PopupFlow.everyTab} flows):
 * the result channels are origin-global, so the arrival of a result says nothing
 * about who asked for it. Kept in memory and mirrored to sessionStorage, which
 * is per tab and survives the opener being reloaded mid-flow.
 */
const attempts = new Map<string, number>();

function markAttempt(kind: string): void {
  const now = Date.now();
  attempts.set(kind, now);
  try {
    sessionStorage.setItem(attemptKey(kind), String(now));
  } catch {
    /* the in-memory copy still covers this page */
  }
}

/** When this tab's live attempt for `kind` started, or null without one. */
function attemptStartedAt(kind: string): number | null {
  const now = Date.now();
  const inMemory = attempts.get(kind);
  if (inMemory !== undefined && now - inMemory < PENDING_TTL_MS) return inMemory;
  try {
    const stored = Number(sessionStorage.getItem(attemptKey(kind)));
    if (stored > 0 && now - stored < PENDING_TTL_MS) return stored;
  } catch {
    /* storage blocked: memory was the only record */
  }
  return null;
}

function endAttempt(kind: string): void {
  attempts.delete(kind);
  try {
    sessionStorage.removeItem(attemptKey(kind));
  } catch {
    /* ignore */
  }
}

/** Flows whose full-page return this load proved it started — recorded by
 *  {@link relayPopupIfApplicable}, which consumes the sessionStorage mark before
 *  the app (and {@link consumeReturn}) gets to run. */
const selfRedirectedReturns = new Set<string>();

/** Whether this tab redirected itself into `kind`'s flow. One use per load. */
function takeSelfRedirect(kind: string): boolean {
  if (selfRedirectedReturns.delete(kind)) return true;
  try {
    if (sessionStorage.getItem(selfRedirectKey(kind)) != null) {
      sessionStorage.removeItem(selfRedirectKey(kind));
      return true;
    }
  } catch {
    /* no storage — nothing can prove it */
  }
  return false;
}

/* ── pending-mark handshake ─────────────────────────────────────────────── */

function markPending(kind: string): void {
  try {
    localStorage.setItem(pendingKey(kind), String(Date.now()));
  } catch {
    /* storage blocked — opener/name detection still covers the common case */
  }
}

/** Clear the pending mark only — NOT the result. The result must outlive this so
 *  the opener's poll / storage listener can still pick it up; the consumer
 *  ({@link subscribePopupResult}) drops the result key once it has applied it. */
export function clearPopupPending(flow: PopupFlow<unknown>): void {
  try {
    localStorage.removeItem(pendingKey(flow.kind));
  } catch {
    /* ignore */
  }
}

function isPending(kind: string): boolean {
  try {
    const v = localStorage.getItem(pendingKey(kind));
    return v != null && Date.now() - Number(v) < PENDING_TTL_MS;
  } catch {
    return false;
  }
}

/** Hand a result back to the opener over every swap-proof channel we have. */
function deliverResult<R>(flow: PopupFlow<R>, result: R): void {
  // BroadcastChannel (fast).
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(channelName(flow.kind));
      channel.postMessage(result);
      setTimeout(() => channel.close(), 1000);
    } catch {
      /* fall through to storage */
    }
  }
  // Durable handoff: the opener reads this back by POLLING localStorage (and via
  // the `storage` event where it crosses the swap). Left in place for the
  // consumer to drop — see {@link subscribePopupResult}.
  try {
    localStorage.setItem(resultKey(flow.kind), JSON.stringify({ at: Date.now(), result }));
  } catch {
    /* ignore */
  }
}

/* ── opener side: open / navigate / watch / fall back ───────────────────── */

/** Centered popup window features, sized for an OAuth consent screen. */
function centeredFeatures(): string {
  const w = 520;
  const h = 720;
  const baseLeft = window.screenLeft ?? window.screenX ?? 0;
  const baseTop = window.screenTop ?? window.screenY ?? 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || w;
  const vh = window.innerHeight || document.documentElement.clientHeight || h;
  const left = baseLeft + Math.max(0, (vw - w) / 2);
  const top = baseTop + Math.max(0, (vh - h) / 2);
  return `popup=yes,width=${w},height=${h},left=${left},top=${top}`;
}

/**
 * Open a blank, centered popup for `flow` — synchronously, so it isn't caught by
 * the popup blocker (the OAuth URL often isn't known until after an `await`,
 * which would break the user-gesture if we opened then). Navigate it with
 * {@link navigatePopup} once the URL is ready, then hand it to {@link watchPopup}.
 * Returns `null` when unsupported or blocked, so the caller falls back to
 * {@link redirectFullPage}.
 */
export function openPopup(flow: PopupFlow<unknown>): Window | null {
  if (typeof window === "undefined") return null;
  const popup = window.open("about:blank", channelName(flow.kind), centeredFeatures());
  if (!popup) return null;
  markPending(flow.kind); // the handshake the returning popup recognises itself by
  markAttempt(flow.kind); // and what lets THIS tab act on the result it brings
  return popup;
}

/** Point an already-open popup (from {@link openPopup}) at the OAuth URL. */
export function navigatePopup(popup: Window, url: string): void {
  popup.location.href = url;
  popup.focus?.();
}

/**
 * Best-effort fast path: poll the popup handle and, if it survives the OAuth hop,
 * read the result off `popup.location` the moment it returns to our origin and
 * close it. Often the handle is severed by Discord's context-group swap (then
 * `popup.closed` reads true and this just stops) — in which case the popup's own
 * relay delivers via the storage handshake instead. Harmless either way.
 */
export function watchPopup<R>(flow: PopupFlow<R>, popup: Window): void {
  if (typeof window === "undefined") return;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearTimeout(cap);
  };
  const timer = window.setInterval(() => {
    if (done) return;
    if (popup.closed) {
      stop();
      return;
    }
    let hash = "";
    let search = "";
    try {
      // Both throw while cross-origin, or if the handle was severed.
      hash = popup.location.hash;
      search = popup.location.search;
    } catch {
      return;
    }
    const result = flow.parse({ hash, search });
    if (!result) return;
    deliverResult(flow, result);
    clearPopupPending(flow);
    try {
      popup.close();
    } catch {
      /* user can close it; result already delivered */
    }
    stop();
  }, 120);
  const cap = window.setTimeout(stop, 5 * 60 * 1000);
}

/**
 * Full-page fallback for when the popup couldn't open (blocked / unsupported):
 * mark this tab so its OAuth return is handled in place (not mistaken for a
 * popup), drop any stale handshake state, then navigate it into the flow. The
 * result comes back via the URL on reload (see {@link consumeReturn}).
 */
export function redirectFullPage(flow: PopupFlow<unknown>, url: string): void {
  // No popup is in flight — this tab handles its own return; drop stale state.
  clearPopupPending(flow);
  try {
    localStorage.removeItem(resultKey(flow.kind));
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.setItem(selfRedirectKey(flow.kind), "1");
  } catch {
    // No sessionStorage — the return still boots and consumes the URL; it just
    // can't prove it redirected itself. Harmless for an ordinary main tab.
  }
  window.location.assign(url);
}

/* ── popup side: relay back to the opener ───────────────────────────────── */

/**
 * When this page load is a `flow` popup returning with a result in the URL,
 * deliver it to the opener (storage handshake + BroadcastChannel) and keep from
 * booting the whole app in the popup. Returns true when handled (the entry point
 * then skips boot). Recognised by the localStorage pending-mark — which, unlike
 * `window.opener`/`window.name`/the popup handle, survives Discord's
 * context-group swap. A self-redirected main tab is positively excluded so it's
 * never mistaken for a popup. Call once per flow, before React mounts.
 */
export function relayPopupIfApplicable<R>(flow: PopupFlow<R>): boolean {
  if (typeof window === "undefined") return false;
  const result = flow.parse({ hash: window.location.hash, search: window.location.search });
  if (!result) return false;

  // A tab that redirected itself owns its return — even if it has an opener.
  // Remembered for `consumeReturn`, since the mark itself is spent here.
  let selfRedirected = false;
  try {
    selfRedirected = sessionStorage.getItem(selfRedirectKey(flow.kind)) != null;
    if (selfRedirected) sessionStorage.removeItem(selfRedirectKey(flow.kind));
  } catch {
    /* sessionStorage blocked — the pending mark below still gates us */
  }
  if (selfRedirected) {
    selfRedirectedReturns.add(flow.kind);
    return false;
  }

  // Only the pending mark — set by `openPopup` in one of this browser's DWEEB
  // tabs moments ago — makes this load a popup returning to its opener.
  // `window.opener` and `window.name` prove nothing: a page that opens a DWEEB
  // window chooses both, along with the URL it carries.
  if (!isPending(flow.kind)) return false;

  deliverResult(flow, result);
  clearPopupPending(flow);
  window.name = "";
  if (document.body) {
    document.body.textContent = flow.doneMessage ?? "You can close this window.";
  }
  // Close ourselves shortly after delivering (the opener may also close us first).
  window.setTimeout(() => {
    try {
      window.close();
    } catch {
      /* ignore */
    }
  }, 1200);
  return true;
}

/* ── opener side: receive the result ────────────────────────────────────── */

/**
 * Subscribe to results posted back from a `flow` popup. Listens on THREE channels
 * because Discord's context-group swap breaks the obvious ones:
 *
 *  - BroadcastChannel — fast, usually works.
 *  - `storage` event — fast where it crosses the swap.
 *  - a localStorage POLL — the bulletproof path: localStorage *values* are shared
 *    across all same-origin contexts regardless of browsing-context group (even
 *    when the events/opener/handle aren't), so reading the key always sees what
 *    the popup wrote.
 *
 * All three funnel through one `deliver` that dedupes successes by
 * {@link PopupFlow.successKey}, drops the stored keys, and ignores anything
 * staler than the pending TTL. Returns an unsubscribe function.
 */
export function subscribePopupResult<R>(
  flow: PopupFlow<R>,
  handler: (result: R) => void,
): () => void {
  const cleanups: Array<() => void> = [];
  // The last delivery, so the same result reaching us again over another
  // channel moments later counts once — while the same result arriving later
  // still (signing in again after signing out, re-adding the bot to the same
  // server) is a new run of the flow and is delivered. A page-lifetime "seen
  // that key" swallowed every such second run.
  let last: { key: string; at: number } | null = null;

  /** `storedAt` is the handoff's write time, for a result read from storage. */
  const deliver = (result: R | null, storedAt?: number) => {
    if (result == null) return;
    // Only the tab that started this flow acts on its result, unless it's one
    // every tab may act on. A tab without a live attempt leaves the stored
    // handoff alone: the tab that owns it may still be about to read it.
    const since = attemptStartedAt(flow.kind);
    if (since === null && !flow.everyTab) return;
    // A handoff written before this attempt began is an earlier run's leftover
    // (a duplicate write that landed after its delivery), never this attempt's
    // answer.
    if (since !== null && storedAt !== undefined && storedAt < since) {
      try {
        localStorage.removeItem(resultKey(flow.kind));
      } catch {
        /* ignore */
      }
      return;
    }
    // Drop the handoff FIRST — even for a duplicate — so a redundant write (e.g.
    // the handle poll re-broadcasting after the channel already delivered) can't
    // linger in localStorage and re-fire on a later load.
    try {
      localStorage.removeItem(resultKey(flow.kind));
      localStorage.removeItem(pendingKey(flow.kind));
    } catch {
      /* ignore */
    }
    const key = flow.isError(result) ? "\u0000error" : flow.successKey(result);
    const now = Date.now();
    // The first result answers this tab's attempt, which ends it — so the same
    // result arriving again finds no attempt. A tab acting on another tab's run
    // (an `everyTab` flow) has no attempt to end, and recognises a repeat by
    // its timing instead.
    if (since === null && last && last.key === key && now - last.at < DUPLICATE_WINDOW_MS) return;
    last = { key, at: now };
    endAttempt(flow.kind);
    handler(result);
  };

  // Read a result sitting in localStorage (poll + storage-event path).
  const consumeStored = () => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(resultKey(flow.kind));
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { at?: number; result?: R };
      const fresh = !parsed.at || Date.now() - parsed.at < PENDING_TTL_MS;
      if (parsed.result != null && fresh) {
        deliver(parsed.result, typeof parsed.at === "number" ? parsed.at : undefined);
        return;
      }
    } catch {
      /* malformed — drop it below */
    }
    try {
      localStorage.removeItem(resultKey(flow.kind));
    } catch {
      /* ignore */
    }
  };

  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(channelName(flow.kind));
      channel.onmessage = (e: MessageEvent) => deliver(e.data as R);
      cleanups.push(() => channel.close());
    } catch {
      /* the storage channels still deliver */
    }
  }

  if (typeof window !== "undefined") {
    const onStorage = (e: StorageEvent) => {
      if (e.key === resultKey(flow.kind) && e.newValue) consumeStored();
    };
    window.addEventListener("storage", onStorage);
    cleanups.push(() => window.removeEventListener("storage", onStorage));

    const pollId = window.setInterval(consumeStored, 400);
    cleanups.push(() => clearInterval(pollId));

    consumeStored(); // apply a result that landed before this mount
  }

  return () => cleanups.forEach((c) => c());
}

/* ── full-page return helpers (main tab) ────────────────────────────────── */

/**
 * Non-destructive check for a pending `flow` return in the current URL — true
 * when this load is such a return, without mutating the URL. Lets first-load UX
 * stand down so it doesn't pop over a flow that's about to take over.
 */
export function hasReturn(flow: PopupFlow<unknown>): boolean {
  if (typeof window === "undefined") return false;
  return flow.parse({ hash: window.location.hash, search: window.location.search }) != null;
}

/**
 * Read — and immediately strip — a `flow` result from the current URL after a
 * full-page (popup-blocked) return. Returns the result, or null when this load
 * isn't such a return. The flow's markers are wiped right away so a credential
 * doesn't linger in the address bar or history; anything else in the URL is kept.
 *
 * Only a tab that sent itself into the flow ({@link redirectFullPage}) gets the
 * result back. Anyone can send a link carrying a return: a crafted
 * `#dweeb_webhook=` URL used to open Send prefilled with the sender's webhook.
 * Such a link is still stripped, and otherwise ignored.
 */
export function consumeReturn<R>(flow: PopupFlow<R>): R | null {
  if (typeof window === "undefined") return null;
  const parsed = flow.parse({ hash: window.location.hash, search: window.location.search });
  if (!parsed) return null;
  const result = takeSelfRedirect(flow.kind) ? parsed : null;

  const url = new URL(window.location.href);
  for (const key of flow.stripSearchKeys ?? []) url.searchParams.delete(key);
  let hash = url.hash.replace(/^#/, "");
  if (hash && flow.stripHashKeys?.length) {
    const hp = new URLSearchParams(hash);
    for (const key of flow.stripHashKeys) hp.delete(key);
    hash = hp.toString();
  }
  const search = url.searchParams.toString();
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`,
  );
  return result;
}

/* ── terminal popup (no return handshake) ───────────────────────────────── */

/**
 * Open an external URL in a centered popup window for a flow that doesn't return
 * to us (e.g. adding a server's own custom bot — Discord shows its own
 * "Authorized" page, with no `redirect_uri` back here). Keeps the opener's dialog
 * on screen underneath. Falls back to a new tab if the popup is blocked.
 */
export function openExternalPopup(url: string, name: string): void {
  if (typeof window === "undefined" || !url) return;
  const popup = window.open(url, name, centeredFeatures());
  if (popup) {
    popup.focus?.();
    return;
  }
  // Blocked — a plain new tab still gets the user there.
  window.open(url, "_blank", "noopener,noreferrer");
}
