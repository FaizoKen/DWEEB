import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "@/app/App";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { useUpdateStore } from "@/core/state/updateStore";
import { relayPopupIfApplicable } from "@/core/oauth/popupFlow";
import { botAddFlow, loginFlow, webhookFlow } from "@/core/oauth/flows";
import { isActivityMode } from "@/core/activity/runtime";
import "@/styles/global.css";

// Discord launches the Activity at our domain root with `?frame_id=…` in the
// query (the Developer Portal's Root Mapping points there). Detect that and boot
// the embedded surface instead of the web app — dynamically, so the Embedded App
// SDK is fetched only inside Discord and never weighs on the public site.
if (isActivityMode()) {
  void bootActivity();
} else if (
  // When we're an OAuth popup returning (webhook create / login / add-bot), hand
  // the result back to the window that opened us and close — never boot the full
  // app in the popup. The normal boot below is skipped in that case.
  !relayPopupIfApplicable(webhookFlow) &&
  !relayPopupIfApplicable(loginFlow) &&
  !relayPopupIfApplicable(botAddFlow)
) {
  boot();
}

async function bootActivity() {
  const { ActivityApp } = await import("@/activity/ActivityApp");
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("Missing #root element. Check index.html.");
  }
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <ActivityApp />
      </ErrorBoundary>
    </StrictMode>,
  );
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
