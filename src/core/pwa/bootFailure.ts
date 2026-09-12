/**
 * The boot shell's terminal states.
 *
 * `index.html` ships an HTML-first shell (`<main data-seo-boot>`: the product
 * H1 plus a "Loading…" line) that `main.tsx` hands over to the app once the boot
 * chunks arrive. When they never do, nothing used to happen: the boot promise
 * rejected into the void and the visitor sat on "Loading…" for good — the
 * 2026-09-11 stale-shell page was two such dead tabs. This module authors the
 * two states the shell can end in instead, in plain DOM (the App chunk, and with
 * it every component, is exactly what didn't load) and with styles that live in
 * `global.css` next to the shell's own:
 *
 *  - `updating` — a recovery navigation is in flight (see
 *    `core/pwa/staleChunkRecovery`); the loading line says so.
 *  - `failed` — no automatic step is left. The loading line becomes a notice
 *    with one primary action.
 *
 * The product H1 is never touched: it is the page's only `<h1>` (the SEO audit
 * checks that) and its first LCP candidate. The notice carries `role="alert"`
 * itself rather than on `<main>`, which stays the main landmark, and
 * `aria-busy` is cleared first so assistive tech doesn't withhold the update.
 * No animation — nothing here needs exempting from the reduced-motion collapse.
 */

/** Why the boot ended, which picks the copy. `stale-chunk` = a chunk failed to
 *  load (probably a shell older than the deploy — the notice says "probably",
 *  because an offline tab produces the same error); `offline` = the same, but
 *  the browser says it has no network; `error` = anything else. */
export type BootNoticeReason = "stale-chunk" | "offline" | "error";

export interface BootNoticeCopy {
  lead: string;
  body: string;
  /** Muted detail line — the error message for a genuine boot bug. */
  detail?: string;
  action: string;
}

/** The copy for one ending, on one surface. Kept in one voice with
 *  `ui/ChunkErrorBoundary` ("Refresh now") and the Activity splash ("Try again"). */
export function bootNoticeCopy(
  reason: BootNoticeReason,
  surface: "web" | "activity",
  detail?: string,
): BootNoticeCopy {
  if (surface === "activity") {
    switch (reason) {
      case "stale-chunk":
        return {
          lead: "DWEEB couldn’t finish loading.",
          body: "It has probably been updated since Discord cached this Activity. Try again to load the current version.",
          action: "Try again",
        };
      case "offline":
        return {
          lead: "DWEEB couldn’t finish loading.",
          body: "Discord appears to be offline. Reconnect, then try again.",
          action: "Try again",
        };
      default:
        return {
          lead: "DWEEB couldn’t start inside Discord.",
          body: "Something went wrong before the Activity could open. Try again, or close and relaunch it.",
          detail,
          action: "Try again",
        };
    }
  }
  switch (reason) {
    case "stale-chunk":
      return {
        lead: "DWEEB couldn’t finish loading.",
        body: "It has probably been updated since your browser saved this page. Refresh to load the current version — a draft saved on this device, and this link, stay where they are.",
        action: "Refresh now",
      };
    case "offline":
      return {
        lead: "DWEEB couldn’t finish loading.",
        body: "You appear to be offline. Reconnect, then reload the page.",
        action: "Reload",
      };
    default:
      return {
        lead: "DWEEB couldn’t start.",
        body: "The editor hit an unexpected error before it could open. Reloading usually fixes it; if it keeps happening, try again in a few minutes.",
        detail,
        action: "Reload",
      };
  }
}

/** What the loading line says while a recovery navigation is in flight. */
export const UPDATING_COPY = "Updating DWEEB to the latest version…";

/**
 * The boot shell, but only while it is still parked inside `#root`. Once
 * `mount()` has re-parented it under `<body>` as the exiting overlay it belongs
 * to the app, and writing into it would paint a notice over a live editor.
 */
export function bootShell(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>("#root > [data-seo-boot]");
}

/** Say that a recovery navigation is under way, instead of "Loading…". */
export function markBootShellUpdating(): void {
  const shell = bootShell();
  if (!shell) return;
  shell.dataset.seoBootState = "updating";
  const line = shell.querySelector<HTMLElement>(".seo-boot__card > p");
  if (line) line.textContent = UPDATING_COPY;
}

/**
 * Turn the shell into the failure notice. Returns the action button, or `null`
 * when there was no shell to draw on (the caller still reports the failure).
 * Idempotent: a second call replaces the previous notice.
 */
export function renderBootNotice(copy: BootNoticeCopy): HTMLButtonElement | null {
  const shell = bootShell();
  if (!shell) return null;
  shell.setAttribute("aria-busy", "false");
  shell.dataset.seoBootState = "failed";
  const card = shell.querySelector<HTMLElement>(".seo-boot__card") ?? shell;

  const notice = document.createElement("div");
  notice.className = "seo-boot__notice";
  notice.setAttribute("role", "alert");

  const lead = document.createElement("p");
  lead.className = "seo-boot__lead";
  lead.textContent = copy.lead;
  const body = document.createElement("p");
  body.textContent = copy.body;
  notice.append(lead, body);
  if (copy.detail) {
    const detail = document.createElement("p");
    detail.className = "seo-boot__detail";
    detail.textContent = copy.detail;
    notice.append(detail);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "seo-boot__action";
  button.textContent = copy.action;
  notice.append(button);

  const previous =
    card.querySelector<HTMLElement>(":scope > .seo-boot__notice") ??
    card.querySelector<HTMLElement>(":scope > p");
  if (previous) previous.replaceWith(notice);
  else card.append(notice);
  return button;
}
