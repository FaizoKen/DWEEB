import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "@/app/App";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { pushToast } from "@/ui/Toast";
import "@/styles/global.css";

// Register the precache service worker (production only — the dev SW would
// fight HMR). A new deploy installs in the background and waits (see the
// `registerType: "prompt"` rationale in vite.config.ts), so this never
// hot-swaps chunks under an open tab; we just let the user know an update is
// ready and it takes effect on the next cold start.
if (import.meta.env.PROD) {
  registerSW({
    onNeedRefresh() {
      pushToast("A new version of DWEEB is ready — reopen to update.", "info");
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
