/**
 * App shell.
 *
 * Two full-height panes side by side — the editor (left) carries every
 * control, and the preview (right) is left uncluttered so the Discord-style
 * render dominates. There is no separate top toolbar; global actions live
 * inside the Builder's action bar.
 *
 * On narrow viewports the preview pane is hidden and slides up from the
 * bottom as a sheet when the user taps the floating live mini preview — a
 * scaled, real-time thumbnail of the message. The sheet can be dismissed by
 * swiping it down via its top drag handle. This keeps the editor full-width
 * on mobile while preserving one-tap access to the render.
 *
 * First-visit flow:
 *  1. `bootstrap()` in the store seeds either a saved draft or the showcase
 *     preset.
 *  2. If the URL carries `#s=…`, `useShareUrlBootstrap` replaces it shortly.
 *  3. From then on, every message change is persisted to `localStorage` via
 *     `useAutoSaveDraft` so a refresh restores the in-progress message.
 */

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Builder } from "@/features/builder/Builder";
import { SendCoachMark } from "@/features/builder/SendCoachMark";
import { useWelcomeAutoOpen } from "@/features/welcome/useWelcomeAutoOpen";
import { useWelcomeStore } from "@/features/welcome/welcomeStore";
import { Preview } from "@/features/preview/Preview";
import { MiniPreview } from "@/features/preview/MiniPreview";
import {
  MOBILE_SHEET_QUERY,
  usePreviewSwipeToClose,
  useIsMobileSheet,
} from "@/features/preview/previewSheet";
import { useAiStore } from "@/core/ai/aiStore";

// Interaction-gated surfaces: none are needed for first paint, so they're code-
// split out of the initial bundle and fetched the first time the user opens
// them. Each is kept mounted afterwards (its chunk is cached and any in-progress
// input — e.g. a typed webhook URL — survives close/reopen).
const ShareDialog = lazy(() =>
  import("@/features/share/ShareDialog").then((m) => ({ default: m.ShareDialog })),
);
const RemoveInteractiveConfirm = lazy(() =>
  import("@/features/share/RemoveInteractiveConfirm").then((m) => ({
    default: m.RemoveInteractiveConfirm,
  })),
);
const AiChatPanel = lazy(() =>
  import("@/features/ai/AiChatPanel").then((m) => ({ default: m.AiChatPanel })),
);
const TemplateGallery = lazy(() =>
  import("@/features/templates/TemplateGallery").then((m) => ({ default: m.TemplateGallery })),
);
const TemplateSetup = lazy(() =>
  import("@/features/templates/TemplateSetup").then((m) => ({ default: m.TemplateSetup })),
);
const FeedbackDialog = lazy(() =>
  import("@/features/feedback/FeedbackDialog").then((m) => ({ default: m.FeedbackDialog })),
);
const CollaborateDialog = lazy(() =>
  import("@/features/collaborate/CollaborateDialog").then((m) => ({
    default: m.CollaborateDialog,
  })),
);
const InstallDialog = lazy(() =>
  import("@/features/install/InstallDialog").then((m) => ({ default: m.InstallDialog })),
);
const PricingModal = lazy(() =>
  import("@/features/plan/PricingModal").then((m) => ({ default: m.PricingModal })),
);
const WelcomeVideo = lazy(() =>
  import("@/features/welcome/WelcomeVideo").then((m) => ({ default: m.WelcomeVideo })),
);
import { ToastViewport, pushToast } from "@/ui/Toast";
import { EyeIcon, SparkleIcon } from "@/ui/Icon";
import { TestModeNotice } from "./TestModeNotice";
import { UpdatePrompt } from "./UpdatePrompt";
import { type IncomingWebhook, type IncomingWebhookResult } from "@/core/guild/config";
import {
  clearPopupPending,
  consumeReturn,
  hasReturn,
  subscribePopupResult,
} from "@/core/oauth/popupFlow";
import { loginFlow, webhookFlow } from "@/core/oauth/flows";
import { useAuthStore } from "@/core/auth/authStore";
import { useTemplateGalleryStore } from "@/features/templates/templateGalleryStore";
import { shouldAutoOpenGallery, markGalleryAutoOpened } from "@/features/templates/galleryAutoOpen";
import { useTemplateSetupStore } from "@/features/templates/templateSetupStore";
import { useSendNudgeStore } from "@/core/state/sendNudgeStore";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import { usePlanStore } from "@/core/plan/planStore";
import { useCollaborateStore } from "@/features/collaborate/collaborateStore";
import { useInstallStore } from "@/features/install/installStore";
import { readShareTokenFromHash } from "@/core/serialization/url";
import { readShortLinkId } from "@/core/serialization/shortlink";
import { useShareUrlBootstrap } from "./useShareUrlBootstrap";
import { useDraftOriginBootstrap } from "./useDraftOriginBootstrap";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useAutoSaveDraft } from "./useAutoSaveDraft";
import { useAttachmentGc } from "./useAttachmentGc";
import { useTemplateDeepLink, readTemplateParam } from "./useTemplateDeepLink";
import { usePlansDeepLink, readPlansParam } from "./usePlansDeepLink";

export function App() {
  useShareUrlBootstrap();
  useDraftOriginBootstrap();
  useTemplateDeepLink();
  usePlansDeepLink();
  useKeyboardShortcuts();
  useAutoSaveDraft();
  useAttachmentGc();
  // First-visit onboarding: plays the intro film once, layered over the
  // landing gallery; see the hook for the gating.
  useWelcomeAutoOpen();

  // The Share dialog is shared by every editor CTA; `shareInitialTab` picks
  // which panel each entry point lands on so each button feels dedicated even
  // though they reuse the same dialog.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareInitialTab, setShareInitialTab] = useState<
    "send" | "update" | "share" | "restore" | "json" | "import" | "about"
  >("send");
  // Latches true on first open so the lazy chunk is fetched once and the dialog
  // stays mounted thereafter (preserving SendPanel's in-progress input).
  const [shareMounted, setShareMounted] = useState(false);
  // A webhook just created via Discord's `webhook.incoming` redirect, picked up
  // from the URL fragment on load and handed to the Send panel to prefill.
  const [incomingWebhook, setIncomingWebhook] = useState<IncomingWebhook | undefined>(undefined);

  // Confirmation popup for clearing interactive components. It opens *after*
  // the Share dialog closes, so it floats over the editor rather than the menu.
  const [confirmStripOpen, setConfirmStripOpen] = useState(false);
  const [confirmMounted, setConfirmMounted] = useState(false);

  // `previewOpen` only matters on mobile, where the preview pane is a
  // bottom sheet. On desktop the CSS keeps both panes visible regardless.
  const [previewOpen, setPreviewOpen] = useState(false);

  // Whether the sheet's <Preview> should be in the tree. On mobile a second
  // live <Preview> already renders inside the MiniPreview thumbnail, so keeping
  // the (off-screen) sheet preview mounted while the sheet is closed just
  // doubles the per-keystroke render + markdown parse for nothing. So on mobile
  // we mount it only while open, lingering ~300ms past close (just over the
  // sheet's 260ms slide-down) so it animates out with its content intact. On
  // desktop the sheet *is* the permanent preview column, so it always renders.
  const [previewMounted, setPreviewMounted] = useState(false);
  useEffect(() => {
    if (previewOpen) {
      setPreviewMounted(true);
      return;
    }
    const t = window.setTimeout(() => setPreviewMounted(false), 300);
    return () => window.clearTimeout(t);
  }, [previewOpen]);

  // Gates the live mini preview, which is a mobile-only affordance (and mounts
  // its own <Preview />, so we keep it off the desktop tree entirely).
  const isMobileSheet = useIsMobileSheet();

  // The AI assistant docks as a third column on desktop and a floating window
  // over the preview on mobile; `aiOpen` drives the app-shell grid switch.
  const aiOpen = useAiStore((s) => s.open);
  const openAi = useAiStore((s) => s.openPanel);
  const closeAi = useAiStore((s) => s.closePanel);

  // The full-screen Template Gallery. Auto-opens when useful — first visit, or a
  // fresh session where the user isn't mid-edit (see `shouldAutoOpenGallery`) —
  // and is reopenable any time from the Builder action bar or the Saved menu.
  const galleryOpen = useTemplateGalleryStore((s) => s.open);
  const openGallery = useTemplateGalleryStore((s) => s.openGallery);

  // The quick-feedback dialog, summoned from the Builder's "More" menu or the
  // About panel. Mounted lazily only while open (its in-progress text resets on
  // close, which is fine for a one-off report).
  const feedbackOpen = useFeedbackStore((s) => s.open);

  // The pricing modal — summoned from the account menu or a maxed-out quota's
  // "Upgrade" link. Shows the Free/Plus/Pro tiers and points "Upgrade" at
  // RoleLogic's checkout. Mounted lazily only while open.
  const pricingOpen = usePlanStore((s) => s.open);

  // The "Collaborate in Discord" dialog — summoned from the Builder's "More"
  // menu. Mints a voice-channel Activity invite so a group co-edits in one shared
  // instance. Mounted lazily only while open.
  const collaborateOpen = useCollaborateStore((s) => s.open);

  // The "Install app" dialog — summoned from the Builder's "More" menu. Replays
  // the captured native PWA prompt on Chromium, or shows per-platform manual
  // steps elsewhere. Mounted lazily only while open.
  const installOpen = useInstallStore((s) => s.open);

  // The intro film — auto-played once for brand-new users (layered over the
  // landing gallery) and replayable from the "More" menu. Mounted lazily only
  // while open so the video modal never weighs on the initial bundle.
  const welcomeOpen = useWelcomeStore((s) => s.open);

  // Guided setup for an interactive template the gallery just applied: wires its
  // paired plugin(s), then closes, leaving the editor in front.
  const setupTemplateId = useTemplateSetupStore((s) => s.templateId);
  // A "go post" nudge (raised when setup finishes): raise the mobile preview so
  // the message is visible. The Send button's own pulse is wired in the Builder.
  const sendNudge = useSendNudgeStore((s) => s.token);

  // Mount the AI panel the first time it opens through any path (FAB or
  // keyboard shortcut), then keep it mounted so its slide animation and draft
  // survive subsequent toggles.
  const [aiMounted, setAiMounted] = useState(false);
  useEffect(() => {
    if (aiOpen) setAiMounted(true);
  }, [aiOpen]);

  // The mobile chat floats over the preview, so dismissing the preview also
  // dismisses the chat — leaving a stranded chat over the builder would be odd.
  const closePreview = () => {
    setPreviewOpen(false);
    if (aiOpen) closeAi();
  };

  const { sheetRef, swipeProps } = usePreviewSwipeToClose(closePreview);

  const openShareDialog = (tab: typeof shareInitialTab) => {
    setShareMounted(true);
    setShareInitialTab(tab);
    setShareOpen(true);
  };

  // Apply a webhook handed back by the `webhook.incoming` flow — whether from the
  // fragment on a full-page return or a popup (which can arrive twice: the popup's
  // own broadcast and the main window's poll re-broadcast). Dedupe successes by
  // URL so it only opens once; an `error` marker means the user backed out or
  // Discord returned nothing, so just say so.
  const handledWebhookRef = useRef("");
  const handleIncomingWebhook = (result: IncomingWebhookResult) => {
    clearPopupPending(webhookFlow); // a result arrived — no popup is in flight anymore
    if ("error" in result) {
      pushToast("No webhook was created. You can try again or paste a URL.", "info");
      return;
    }
    if (handledWebhookRef.current === result.url) return;
    handledWebhookRef.current = result.url;
    setIncomingWebhook(result);
    openShareDialog("send");
  };

  // Full-page return: the new webhook's URL is in the fragment. Pull it out
  // (clears it from the address bar) and apply it. Runs once on load.
  useEffect(() => {
    const result = consumeReturn(webhookFlow);
    if (result) handleIncomingWebhook(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Popup return: the flow ran in a popup (so the builder stayed put) and posted
  // its result back over a same-origin channel. Apply it the same way.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => subscribePopupResult(webhookFlow, handleIncomingWebhook), []);

  // Login popup return: the session cookie is already set (origin-global), so we
  // just re-read it and flip to "authed". A blocked-popup full-page login is
  // handled by the reload's `init()` instead — here we only clear the
  // `#dweeb_login` marker it leaves, and note a cancel.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(
    () =>
      subscribePopupResult(loginFlow, (r) => void useAuthStore.getState().completeLogin("ok" in r)),
    [],
  );
  useEffect(() => {
    const r = consumeReturn(loginFlow);
    if (r && "error" in r) {
      pushToast("Sign-in didn’t finish — you can try again.", "info");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Landing screen: auto-open the Template Gallery when it's actually useful —
  // a first visit, or a fresh session where the user isn't mid-edit — instead of
  // on every refresh (see `shouldAutoOpenGallery`). It stays reopenable any time
  // from the Builder action bar or the Saved menu. Stands down entirely when
  // we'd be interrupting a dedicated flow: a share/short link being decoded into
  // the editor, or a webhook redirect about to open the Send panel.
  useEffect(() => {
    if (hasReturn(webhookFlow)) return;
    if (readShareTokenFromHash(window.location.hash) || readShortLinkId(window.location.pathname)) {
      return;
    }
    // A `?template=` deep link (from a static template page's "Open in DWEEB"
    // CTA) loads that template straight into the editor — don't shove the
    // gallery in front of it.
    if (readTemplateParam(window.location.search)) return;
    // A `?plans=` deep link (the Activity's "Upgrade" hand-off) opens the pricing
    // modal — don't also throw the gallery in front of it.
    if (readPlansParam(window.location.search)) return;
    if (!shouldAutoOpenGallery()) return;
    markGalleryAutoOpened();
    openGallery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Post-setup nudge: the editor's preview is the desktop's side column already,
  // but a mobile sheet — raise it so the user sees the message before tapping
  // Send (which the SendCoachMark spotlights). Read the layout live so this only
  // depends on the nudge token firing.
  useEffect(() => {
    if (sendNudge === 0) return;
    if (window.matchMedia(MOBILE_SHEET_QUERY).matches) setPreviewOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendNudge]);

  // Close the Share dialog and hand off to the confirmation popup over the editor.
  const requestRemoveInteractive = () => {
    setShareOpen(false);
    setConfirmMounted(true);
    setConfirmStripOpen(true);
  };

  // On mobile the AI chat floats over the preview, so opening the assistant
  // brings the (full-screen) preview up first — you watch the message build as
  // you chat. On desktop both panes are always visible, so this is harmless.
  const openAiWithPreview = () => {
    setPreviewOpen(true);
    openAi();
  };

  return (
    <>
      <TestModeNotice />
      <div
        className="app-shell"
        data-preview-open={previewOpen ? "true" : "false"}
        data-ai-open={aiOpen ? "true" : "false"}
      >
        <h1 className="sr-only">
          DWEEB — the visual Discord webhook and embed builder. Build, preview, and send rich
          Discord messages with Components V2: containers, sections, buttons, select menus, and
          media.
        </h1>
        <section
          className="app-shell__pane app-shell__pane--builder"
          aria-label="Component builder"
        >
          <Builder
            onShare={() => openShareDialog("share")}
            onExport={() => openShareDialog("json")}
            onImport={() => openShareDialog("import")}
            onSend={() => openShareDialog("send")}
            onUpdate={() => openShareDialog("update")}
            onRestore={() => openShareDialog("restore")}
            onAbout={() => openShareDialog("about")}
          />
        </section>
        {/* Dismiss scrim for the mobile preview sheet. The sheet only rises to
          85dvh, leaving the top of the builder (action bar + username/avatar)
          peeking above it — without this, a tap there edits those fields
          instead of closing the preview. It sits just under the sheet, so it
          catches the stray tap and dismisses. Driven by `data-preview-open`
          in global.css; inert on desktop where the preview is a side column. */}
        <div className="preview-scrim" aria-hidden="true" onClick={closePreview} />
        <section
          ref={sheetRef}
          className="app-shell__pane app-shell__pane--preview"
          aria-label="Message preview"
          aria-hidden={previewOpen ? undefined : "true"}
        >
          {!isMobileSheet || previewMounted ? (
            <Preview onClose={closePreview} swipeProps={swipeProps} />
          ) : null}
        </section>

        {aiMounted ? (
          <Suspense fallback={null}>
            <AiChatPanel />
          </Suspense>
        ) : null}

        <div className="fab-stack">
          {/* Live mini preview: a tappable, real-time thumbnail of the message
            that opens the full preview sheet. Mobile only — on desktop the
            preview is already a permanent side column. Sits above the action
            row, so the corner reads as a stacked widget. */}
          {isMobileSheet && !previewOpen ? (
            <MiniPreview onOpen={() => setPreviewOpen(true)} />
          ) : null}

          <div className="fab-row">
            {/* Explicit "open the full preview" toggle, beneath its thumbnail.
              Mobile only — the desktop preview is always visible. */}
            {isMobileSheet && !previewOpen ? (
              <button
                type="button"
                className="preview-fab"
                onClick={() => setPreviewOpen(true)}
                aria-label="Show preview"
              >
                <EyeIcon size={18} />
                <span>Preview</span>
              </button>
            ) : null}

            <button
              type="button"
              className="ai-fab"
              onClick={openAiWithPreview}
              aria-label="Open the AI assistant"
            >
              <SparkleIcon size={20} />
              <span>AI Assistant</span>
            </button>
          </div>
        </div>

        {shareMounted ? (
          <Suspense fallback={null}>
            <ShareDialog
              open={shareOpen}
              onClose={() => setShareOpen(false)}
              initialTab={shareInitialTab}
              onRequestRemoveInteractive={requestRemoveInteractive}
              initialWebhook={incomingWebhook}
            />
          </Suspense>
        ) : null}
        {confirmMounted ? (
          <Suspense fallback={null}>
            <RemoveInteractiveConfirm
              open={confirmStripOpen}
              onClose={() => setConfirmStripOpen(false)}
            />
          </Suspense>
        ) : null}
        {galleryOpen ? (
          <Suspense fallback={null}>
            <TemplateGallery />
          </Suspense>
        ) : null}
        {setupTemplateId ? (
          <Suspense fallback={null}>
            <TemplateSetup templateId={setupTemplateId} />
          </Suspense>
        ) : null}
        {feedbackOpen ? (
          <Suspense fallback={null}>
            <FeedbackDialog />
          </Suspense>
        ) : null}
        {pricingOpen ? (
          <Suspense fallback={null}>
            <PricingModal />
          </Suspense>
        ) : null}
        {collaborateOpen ? (
          <Suspense fallback={null}>
            <CollaborateDialog />
          </Suspense>
        ) : null}
        {installOpen ? (
          <Suspense fallback={null}>
            <InstallDialog />
          </Suspense>
        ) : null}
        {welcomeOpen ? (
          <Suspense fallback={null}>
            <WelcomeVideo />
          </Suspense>
        ) : null}
        <SendCoachMark />
        <UpdatePrompt />
        <ToastViewport />
      </div>
    </>
  );
}
