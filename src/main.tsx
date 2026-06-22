import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "@/app/App";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { useUpdateStore } from "@/core/state/updateStore";
import { relayWebhookPopupIfApplicable } from "@/core/guild/config";
import "@/styles/global.css";

// When we're the `webhook.incoming` OAuth popup, hand the created webhook back
// to the window that opened us and close — never boot the full app in the
// popup. The normal boot below is skipped in that case.
if (!relayWebhookPopupIfApplicable()) {
  boot();
}

function boot() {
  // Register the precache service worker (production only — the dev SW would
  // fight HMR). A new deploy installs in the background and waits (see the
  // `registerType: "prompt"` rationale in vite.config.ts), so this never
  // hot-swaps chunks under an open tab. When it's ready we surface a persistent
  // Discord-style "Update" button (see `UpdatePrompt`); clicking it activates the
  // waiting worker via this same `updateSW` and reloads onto the new build.
  if (import.meta.env.PROD) {
    const updateSW = registerSW({
      onNeedRefresh() {
        useUpdateStore.getState().markReady(updateSW);
      },
    });
  }

  const container = document.getElementById("root");
  if (!container) {
    throw new Error("Missing #root element. Check index.html.");
  }

  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
