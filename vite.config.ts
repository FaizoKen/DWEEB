import { defineConfig, type Plugin, type ServerOptions } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// Build version, read from package.json and injected as `__APP_VERSION__` so the
// crash reporter (src/core/telemetry) can pin a report to a deploy. A literal
// string, so it's inlined and tree-shakeable — no runtime `import` of the JSON.
const APP_VERSION: string = createRequire(import.meta.url)("./package.json").version;

// Serve the dev server over HTTPS when a locally-trusted cert is present.
//
// The Discord client embeds an Activity in an iframe whose `frame-src` CSP only
// whitelists `https://localhost:*` — a plain `http://localhost` override is
// blocked outright, and a self-signed cert's warning can't be click-accepted
// inside an iframe. So local Activity dev needs a *trusted* cert. Generate one
// with mkcert (`mkcert -install` once, then `mkcert -cert-file certs/localhost.pem
// -key-file certs/localhost-key.pem localhost 127.0.0.1 ::1`) and Vite picks it
// up here. Absent the files we stay on plain HTTP, so the web app's normal dev
// loop and CI are untouched. See docs/activity.md.
function devHttps(): ServerOptions["https"] {
  const cert = path.resolve(__dirname, "certs/localhost.pem");
  const key = path.resolve(__dirname, "certs/localhost-key.pem");
  if (!fs.existsSync(cert) || !fs.existsSync(key)) return undefined;
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

// Security policy for the deployed site. GitHub Pages cannot attach response
// headers, so the policy ships as a <meta> tag injected into the built
// index.html (dev stays unrestricted so HMR's WebSocket and the local
// `http://localhost:8080` proxy keep working). Relative to the old Cloudflare
// `_headers` deployment, `frame-ancestors` / `X-Frame-Options` and
// `X-Content-Type-Options` are lost — they can't be expressed in a meta tag.
//
// `connect-src 'self' https:` is deliberate: the AI panel talks to
// user-configured gateways (any https host) and there is no same-origin proxy
// anymore, so provider hosts can't be enumerated. The tight `script-src`
// remains the real injection defense.
//
// `script-src` allows 'self' (the bundle), the GA loader host, plus a SHA-256
// for each inline <script> in the built HTML (currently just the short-link
// early-resolve snippet in index.html). The hashes let the strict policy permit
// those specific scripts without opening the door to 'unsafe-inline' — computed
// at build time below so they track the exact emitted bytes.
function buildCsp(inlineScriptHashes: readonly string[]): string {
  return [
    "default-src 'self'",
    ["script-src 'self' https://www.googletagmanager.com", ...inlineScriptHashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data: blob:",
    "media-src 'self' https: blob:",
    "font-src 'self' data:",
    // `wss:` covers the embedded Activity's collaboration WebSocket (rewritten to
    // a same-origin `/.proxy` socket inside Discord, but allowed broadly so a
    // self-hosted proxy on any host works too).
    "connect-src 'self' https: wss:",
    // Plugins render their config UI in iframes under *.dweeb.faizo.net.
    "frame-src 'self' https://*.dweeb.faizo.net",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** SHA-256 (base64, CSP `'sha256-…'` form) of every inline, executable
 *  <script> in the HTML. Scripts with `src` are served from an allowed host, and
 *  non-executable blocks (JSON-LD, importmap) are ignored by `script-src`, so
 *  both are skipped. */
function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue; // external — covered by a host source
    const type = (/\btype\s*=\s*("|')?([^"'\s>]+)/i.exec(attrs)?.[2] ?? "").toLowerCase();
    const executable =
      type === "" ||
      type === "module" ||
      type === "text/javascript" ||
      type === "application/javascript";
    if (!executable) continue;
    const digest = crypto
      .createHash("sha256")
      .update(m[2] ?? "", "utf8")
      .digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

function injectSecurityMeta(): Plugin {
  return {
    name: "inject-security-meta",
    apply: "build",
    transformIndexHtml: {
      // 'post' so Vite's built-in `%VITE_*%` env substitution (registered as a
      // 'pre' hook) has already run — we hash the exact bytes the browser will
      // execute, so the policy stays valid across proxy-URL configs.
      order: "post",
      handler(html) {
        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: buildCsp(inlineScriptHashes(html)),
              },
              injectTo: "head-prepend",
            },
            {
              tag: "meta",
              attrs: { name: "referrer", content: "strict-origin-when-cross-origin" },
              injectTo: "head-prepend",
            },
          ],
        };
      },
    },
  };
}

// Static SPA build targeting GitHub Pages.
// Share-state is encoded in the URL hash, so no SPA fallback is needed
// for share links — the server only ever sees `/`. (The deploy workflow
// still publishes a 404.html copy of the shell so stray deep links load
// the app.)
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    react(),
    injectSecurityMeta(),
    // Service worker: precache the hashed app shell so repeat visits load from
    // disk with no network round trip (GitHub Pages caps Cache-Control at ~10
    // min and can't be customized, so without this every return visit
    // re-validates each asset) and the editor works offline.
    //
    // `registerType: "prompt"` deliberately does NOT skipWaiting: a freshly
    // deployed SW precaches in the background and waits, so any tab already open
    // keeps being served the exact chunks its `index.html` references — a lazy
    // import (Share dialog, AI panel, Template gallery…) can never 404 against a
    // just-purged old chunk. The waiting worker surfaces a persistent
    // Discord-style "Update" button (see `UpdatePrompt`); clicking it activates
    // it and reloads onto the new build (otherwise it applies on next cold start).
    //
    // `manifest: false` keeps the existing hand-tuned `public/manifest.webmanifest`
    // (and its `<link rel="manifest">` in index.html) as the single source of truth.
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: false,
      workbox: {
        globPatterns: [
          "assets/**/*.{js,css}",
          "index.html",
          "favicon.svg",
          "icon-*.png",
          "apple-touch-icon.png",
          "manifest.webmanifest",
        ],
        // The embedded Activity's chunks (the Embedded App SDK + the Activity
        // shell) are only ever loaded inside Discord — which always runs online
        // and never registers this service worker. Precaching them on the web
        // surface would background-download ~60 kB gzip of code the public site
        // can't use and bloat every visitor's Cache Storage, so keep them out of
        // the precache manifest. A stray `?frame_id` visit on the web still
        // fetches them straight from the network, unchanged.
        globIgnores: ["assets/activity-sdk-*.js", "assets/ActivityApp-*.{js,css}"],
        // SPA + short-link (`/s/<id>`) navigations fall back to the cached shell.
        // The standalone legal pages and the static, pre-rendered template pages
        // (`/templates/…`, generated by scripts/gen-template-pages.ts) are real
        // static files, not app routes, so they're excluded — the SW must let
        // the network serve them rather than swap in the SPA shell.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/privacy/, /^\/terms/, /^\/templates/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
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
          // The Embedded App SDK (+ its only consumers, eventemitter3 / zod) load
          // exclusively on the Activity entry. Splitting them out keeps the web
          // app's vendor chunk — and so the public site's first paint — untouched
          // by code that never runs there.
          if (
            id.includes("@discord/embedded-app-sdk") ||
            id.includes("eventemitter3") ||
            id.includes("/zod/")
          )
            return "activity-sdk";
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
    // HTTPS only when the mkcert files exist (see `devHttps`) — needed for the
    // embedded Activity, harmless for everything else.
    https: devHttps(),
  },
  preview: {
    port: 4173,
  },
});
