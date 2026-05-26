import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

// Static SPA build targeting Cloudflare Pages.
// Share-state is encoded in the URL hash, so no SPA fallback is needed
// for share links — the server only ever sees `/`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
    sourcemap: false,
    // The on-device AI runtime (@mlc-ai/web-llm + tvmjs) is a multi-MB chunk,
    // but it's loaded via dynamic import() only when a user opens the AI panel
    // and loads a model — it never touches the initial app payload. Raise the
    // warning ceiling so this expected, intentionally-lazy chunk isn't flagged.
    chunkSizeWarningLimit: 7000,
    rollupOptions: {
      output: {
        manualChunks: {
          // Split the compression lib so the main bundle stays tiny.
          // Decoding is only needed when the user lands on a share URL.
          serializer: ["lz-string"],
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
