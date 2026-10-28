/**
 * Every plugin config page carries an identical copy of the shared stylesheet.
 *
 * The pages live in separate crates (each built in its own Docker context), so
 * the shared look is copied into each one by `bun run sync:plugin-ui`. This
 * fails when a page was edited by hand, or the stylesheet changed without a
 * sync — the drift that once left nine pages with nine slightly different looks.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PLUGINS = fileURLToPath(new URL("../../../plugins/", import.meta.url));
const shared = readFileSync(join(PLUGINS, "_shared", "plugin-ui.css"), "utf8").trim();
const pages = readdirSync(PLUGINS)
  .map((crate) => ({ crate, path: join(PLUGINS, crate, "static", "config.html") }))
  .filter(({ path }) => existsSync(path));

describe("plugin config pages", () => {
  it("are all found", () => {
    expect(pages.length).toBeGreaterThanOrEqual(9);
  });

  for (const { crate, path } of pages) {
    it(`${crate} carries the current shared stylesheet (run \`bun run sync:plugin-ui\`)`, () => {
      const html = readFileSync(path, "utf8");
      const block = html.match(/<style data-plugin-ui>\n([\s\S]*?)\n<\/style>/);
      expect(block, "missing <style data-plugin-ui> block").not.toBeNull();
      expect(block![1]).toBe(shared);
    });

    it(`${crate} keeps Save in the sticky action bar`, () => {
      const html = readFileSync(path, "utf8");
      const start = html.indexOf('<div class="bar">');
      expect(start, "missing the .bar action bar").toBeGreaterThan(-1);
      const bar = html.slice(start, html.indexOf("</div>\n", html.indexOf('id="save"', start)));
      expect(bar).toContain('id="save"');
      expect(bar).toContain('id="cancel"');
    });
  }
});
