import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

// Static SPA build targeting Cloudflare Pages.
// Share-state is encoded in the URL hash, so no SPA fallback is needed
// for share links — the server only ever sees `/`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // React is aliased to Preact's compat layer to shrink the runtime: the
    // vendor chunk drops from ~47 kB gzip to ~12 kB. The app keeps writing
    // standard React + @types/react; only the bundled runtime changes. Exact
    // regex matches avoid the `react` prefix swallowing `react/jsx-runtime` or
    // `react-dom/client`.
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      { find: /^react$/, replacement: "preact/compat" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react-dom\/client$/, replacement: "preact/compat/client" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
      { find: /^react\/jsx-dev-runtime$/, replacement: "preact/jsx-dev-runtime" },
    ],
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
    sourcemap: false,
    // Terser squeezes a few percent more out of the JS than esbuild's minifier
    // (multiple compress passes + better property mangling on our shapes). The
    // slower build is paid once at deploy time; the smaller chunk is paid by
    // every visitor. No `drop_console` — the only `console.*` left is the
    // ErrorBoundary diagnostic, which we keep.
    minify: "terser",
    terserOptions: {
      compress: { passes: 2, ecma: 2020 },
      format: { comments: false },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // lz-string is only reached through lazy paths (share-link decode and
          // the Share dialog), so keep it in its own chunk instead of letting it
          // ride along in the always-loaded vendor chunk.
          if (id.includes("lz-string")) return "serializer";
          // Everything else from node_modules (React, ReactDOM, scheduler,
          // zustand, nanoid) is on the critical path. Group it into one vendor
          // chunk that only changes when dependencies do — so app-code edits
          // don't bust its long-term cache.
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
  },
});
