/**
 * Styles every guide tool shares: the panel, its intro, labelled fields and
 * buttons. Each tool appends its own rules; only the page carrying a tool
 * inlines any of this.
 */
export const TOOL_BASE_CSS = `
.tool{margin:26px 0;padding:20px 22px;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius)}
.tool h2{font-size:22px;margin:0 0 8px}
.tool-intro{color:var(--muted);margin:0 0 16px;max-width:74ch}
.tool-controls{display:grid;gap:12px;margin-bottom:12px}
.tool-fields{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
.tool-field{display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:600;color:var(--dim);min-width:0}
.tool-field-wide{width:100%}
.tool-field input,.tool-field select{font:inherit;font-size:15px;font-weight:400;color:var(--text);background:#1e1f22;border:1px solid var(--border);border-radius:8px;padding:9px 11px;min-height:42px;color-scheme:dark;width:100%;max-width:440px}
.tool-field input:focus,.tool-field select:focus{outline:2px solid #a6baff;outline-offset:1px}
.tool-btn{font:inherit;font-size:14px;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:8px;padding:9px 16px;min-height:42px;cursor:pointer}
.tool-btn:hover{filter:brightness(1.08)}
.tool-btn:disabled,.tool-field input:disabled,.tool-field select:disabled{opacity:.6;cursor:default;filter:none}
.tool-copy{min-height:34px;padding:6px 14px;background:#4e5058}
.tool-copy[data-copied]{background:var(--green)}
.tool-status{color:var(--muted);font-size:14px;margin:0 0 4px;min-height:1.6em}
.tool-note{color:var(--dim);font-size:13px;margin:10px 0 0}
.tool-note code{font:12px ui-monospace,Menlo,Consolas,monospace}
@media(max-width:560px){.tool{padding:16px}.tool-fields>.tool-field{flex:1 1 140px}}
`;

/**
 * Copy text to the clipboard and flash the button. Falls back to selecting a
 * hidden textarea when the async Clipboard API is unavailable (an insecure
 * context or an old engine), and reports which happened.
 */
export async function copyToClipboard(text: string, button: HTMLElement): Promise<boolean> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
  }
  if (ok) {
    const label = button.textContent;
    button.setAttribute("data-copied", "");
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.removeAttribute("data-copied");
      button.textContent = label;
    }, 1600);
  }
  return ok;
}
