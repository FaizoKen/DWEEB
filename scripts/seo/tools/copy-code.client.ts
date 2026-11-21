/**
 * Browser half of `copy-code.ts`: give every code block a Copy button.
 * Bundled by `tools/bundle.ts`; loaded as a module script, so it runs once the
 * document has been parsed.
 */

interface AnalyticsWindow extends Window {
  gtag?: (command: "event", name: string, params: Record<string, never>) => void;
}

const RESET_AFTER_MS = 2000;

function liveRegion(): HTMLElement {
  const region = document.createElement("div");
  region.className = "sr-only";
  region.setAttribute("aria-live", "polite");
  document.body.append(region);
  return region;
}

function enhance(): void {
  if (!navigator.clipboard?.writeText) return;
  const blocks = document.querySelectorAll<HTMLPreElement>("pre.code-block");
  if (!blocks.length) return;
  const status = liveRegion();

  for (const pre of blocks) {
    const code = pre.querySelector("code");
    if (!code || pre.parentElement?.classList.contains("copy-wrap")) continue;
    const label = pre.getAttribute("aria-label") || "code";

    const wrap = document.createElement("div");
    wrap.className = "copy-wrap";
    pre.before(wrap);
    wrap.append(pre);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-btn";
    button.textContent = "Copy";
    button.setAttribute("aria-label", `Copy ${label}`);
    let timer = 0;
    button.addEventListener("click", () => {
      void navigator.clipboard.writeText(code.textContent ?? "").then(
        () => {
          button.textContent = "Copied";
          button.dataset.state = "done";
          status.textContent = "Copied to the clipboard.";
          // Counts that a copy happened on this page; nothing about what.
          (window as AnalyticsWindow).gtag?.("event", "code_copied", {});
        },
        () => {
          // The browser refused the clipboard (no permission, or the page
          // isn't focused). Select the text so a copy by hand is one step.
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(code);
          selection?.removeAllRanges();
          selection?.addRange(range);
          button.textContent = "Text selected";
          status.textContent = "Couldn't copy automatically. The text is selected — copy it now.";
        },
      );
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        button.textContent = "Copy";
        delete button.dataset.state;
      }, RESET_AFTER_MS);
    });
    wrap.append(button);
  }
}

enhance();
