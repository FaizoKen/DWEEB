/**
 * Bundle the guide tools' browser scripts into `dist/` at generation time.
 *
 * The generated pages ship no application bundle, so a tool's script cannot
 * come from Vite's build — and copying the formatter into a hand-written file
 * under `public/` would let the page and the editor drift apart. Instead each
 * tool's `*.client.ts` imports straight from `src/` and is bundled here, with
 * Bun's own bundler (the generator already runs under Bun, and resolves the
 * `@/…` alias from the root tsconfig the same way). The audit then fails any
 * generated page whose first-party `<script src>` is missing from `dist/`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TIMESTAMP_TOOL_SCRIPT } from "./timestamp-generator";

/** The slice of `Bun.build` this uses; bun-types is not a project dependency. */
interface BunBundler {
  build(options: {
    entrypoints: string[];
    target: "browser";
    format: "esm";
    minify: boolean;
  }): Promise<{
    success: boolean;
    logs: unknown[];
    outputs: { text(): Promise<string> }[];
  }>;
}

const TOOL_ENTRIES: readonly { entry: string; publicPath: string }[] = [
  {
    entry: fileURLToPath(new URL("./timestamp-generator.client.ts", import.meta.url)),
    publicPath: TIMESTAMP_TOOL_SCRIPT,
  },
];

/** Bundle every guide tool into `dist`; returns the site paths written. */
export async function bundleGuideTools(dist: string): Promise<string[]> {
  const bun = (globalThis as { Bun?: BunBundler }).Bun;
  if (!bun) {
    throw new Error(
      "Guide tools are bundled with Bun.build — run the generator with `bun scripts/gen-template-pages.ts`.",
    );
  }
  const written: string[] = [];
  for (const { entry, publicPath } of TOOL_ENTRIES) {
    const result = await bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      minify: true,
    });
    const [output] = result.outputs;
    if (!result.success || !output || result.outputs.length !== 1) {
      throw new Error(`Bundling ${entry} failed:\n${result.logs.map(String).join("\n")}`);
    }
    const file = join(dist, publicPath.slice(1));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await output.text(), "utf8");
    written.push(publicPath);
  }
  return written;
}
