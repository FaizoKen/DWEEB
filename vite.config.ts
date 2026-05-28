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
    rollupOptions: {
      output: {
        manualChunks: {
          // Split the compression lib so the main bundle stays tiny.
          // Decoding is only needed when the user lands on a share URL.
          serializer: ["lz-string"],
          // Pin the WebLLM runtime to its own chunk so the chunk name is stable
          // and obvious in network panels. It's only fetched when the user
          // actually sends a message with the local provider.
          "web-llm": ["@mlc-ai/web-llm"],
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
