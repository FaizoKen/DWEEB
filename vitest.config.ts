import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Standalone Vitest config — deliberately NOT the app's `vite.config.ts`.
 *
 * The app config pulls in the React SWC plugin, the PWA service-worker builder
 * and the CSP/asset machinery, none of which a pure-logic unit test needs. The
 * suite here targets the framework-free core (serialization, schema validation,
 * placeholder substitution), so we give it the minimum: the `@/…` path alias
 * (kept in sync with `tsconfig.app.json` / `vite.config.ts`) and Node's
 * environment. No jsdom — the modules under test guard every browser global
 * (`localStorage`, `indexedDB`) behind a `typeof … === "undefined"` check, and
 * `crypto.getRandomValues` / `structuredClone` are Node built-ins.
 *
 * The `react` → `preact/compat` aliases mirror `vite.config.ts` so the few tests
 * that touch element helpers (`Children.map`, `cloneElement`) run against the
 * runtime we actually ship. They are not interchangeable: Preact's `Children.map`
 * wraps a lone child into an array where React's does not, and that difference is
 * precisely what `ui/Field` has to get right. Testing against real React would
 * prove nothing about production.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      { find: /^react$/, replacement: "preact/compat" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fixture builders and the golden generator are not tests.
    exclude: ["**/node_modules/**", "**/__fixtures__/**", "src/test/**"],
  },
});
