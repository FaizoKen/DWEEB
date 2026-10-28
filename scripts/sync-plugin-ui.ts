/**
 * Copy the shared plugin config stylesheet into every plugin's config page.
 *
 *   bun run sync:plugin-ui
 *
 * Each `plugins/<crate>/static/config.html` is served by its own crate with
 * `include_str!` and built in its own Docker context, so it can't link a common
 * file. `plugins/_shared/plugin-ui.css` is the one source; this script rewrites
 * the `<style data-plugin-ui>` block of every page from it, and
 * `src/core/plugins/pluginUi.test.ts` fails when a page's copy has drifted.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PLUGINS = join(ROOT, "plugins");
const css = readFileSync(join(PLUGINS, "_shared", "plugin-ui.css"), "utf8").trim();
const BLOCK = /<style data-plugin-ui>[\s\S]*?<\/style>/;

let changed = 0;
const missing: string[] = [];
for (const crate of readdirSync(PLUGINS)) {
  const page = join(PLUGINS, crate, "static", "config.html");
  if (!existsSync(page)) continue;
  const html = readFileSync(page, "utf8");
  if (!BLOCK.test(html)) {
    missing.push(crate);
    continue;
  }
  const next = html.replace(BLOCK, () => `<style data-plugin-ui>\n${css}\n</style>`);
  if (next !== html) {
    writeFileSync(page, next);
    changed++;
    console.log(`updated ${crate}`);
  }
}
if (missing.length) {
  console.error(`no <style data-plugin-ui> block in: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(changed ? `synced ${changed} page(s)` : "all pages already in sync");
