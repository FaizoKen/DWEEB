/**
 * Boot-shell surface contract.
 *
 * `index.html` ships one HTML-first shell for BOTH surfaces, and it paints the
 * chrome its surface is about to commit to: the web app's two editor panes, or
 * the Activity's flat splash background. Deciding which has to happen before
 * first paint — the shell paints from the render-blocking stylesheet, long
 * before any module runs — so an inline script stamps `data-surface` and
 * global.css branches on it. That is a second copy of the Activity detection
 * `isActivityMode()` owns, in a file no bundler or type-checker links to the
 * first, so these tests pin the two together: if the launch signal ever stops
 * being `frame_id`, the stamp goes stale silently and the Activity boots
 * wearing the web app's chrome, then changes out of it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const INDEX_HTML = read("../../../index.html");
const GLOBAL_CSS = read("../../styles/global.css");
const RUNTIME_TS = read("./runtime.ts");

describe("the pre-paint surface stamp", () => {
  it("keys off the same launch parameter isActivityMode() reads", () => {
    // Both must resolve the surface from `frame_id`; `isActivityMode()` is the
    // authority, the stamp is the copy that runs early enough to style with.
    expect(RUNTIME_TS).toContain('has("frame_id")');
    expect(INDEX_HTML).toContain('has("frame_id")');
  });

  it("marks only the Activity, so an unstamped document is the web app", () => {
    // The stamp is best-effort (an unparseable query, a blocked inline script).
    // Failing open has to land on the web chrome, which is what every other
    // page load is, rather than on a surface nobody reached.
    expect(INDEX_HTML).toContain('document.documentElement.dataset.surface = "activity"');
    expect(GLOBAL_CSS).toContain('html:not([data-surface="activity"]) .seo-boot');
  });

  it("keeps the shell's markup hooks the stylesheet and mount() both need", () => {
    expect(INDEX_HTML).toMatch(/<main class="seo-boot" data-seo-boot\b/);
  });
});
