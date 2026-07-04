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
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fixture builders and the golden generator are not tests.
    exclude: ["**/node_modules/**", "**/__fixtures__/**", "src/test/**"],
  },
});
