/**
 * One-shot auto-play of the intro film for brand-new users.
 *
 * On a genuine first visit the film opens right on top of the landing Template
 * Gallery (its overlay sits above the gallery's), so closing it lands the user
 * exactly where the first-visit flow already starts: "Message directory". No
 * sequencing dance is needed — the film is the front layer, everything else
 * proceeds untouched beneath it.
 *
 * Stands down entirely on deep-linked loads (a share/short link being decoded,
 * a `?template=`/`?plans=`/`?custom-bot=` param, or a webhook-create redirect) —
 * the visitor
 * came for something specific, so nothing is recorded and a later organic
 * visit still gets the one auto-play. Pre-film users (evidence of prior use)
 * get a single toast pointing at the More menu's "Watch the intro" instead.
 *
 * The decision itself lives in `welcomeGate`; the "shown" record is written
 * the moment the film auto-opens, so auto-play is strictly one-shot even if
 * the tab closes mid-film.
 */

import { useEffect, useState } from "react";
import { hasReturn } from "@/core/oauth/popupFlow";
import { webhookFlow } from "@/core/oauth/flows";
import { readShareTokenFromHash } from "@/core/serialization/url";
import { readShortLinkId } from "@/core/serialization/shortlink";
import { readTemplateParam } from "@/app/useTemplateDeepLink";
import { readPlansParam } from "@/app/usePlansDeepLink";
import { readCustomBotParam } from "@/core/guild/customBotLink";
import { pushToast } from "@/ui/Toast";
import { welcomeAutoDecision, writeWelcomeRecord } from "./welcomeGate";
import { useWelcomeStore } from "./welcomeStore";

/** Small settle delay so the app shell paints beneath the film first. */
const OPEN_DELAY_MS = 400;
/** The announce toast waits out the initial layout + gallery entrance. */
const ANNOUNCE_DELAY_MS = 1500;

/** True when this load is a dedicated flow the film must not interrupt. */
function isDeepLinkedLoad(): boolean {
  return (
    hasReturn(webhookFlow) ||
    !!readShareTokenFromHash(window.location.hash) ||
    !!readShortLinkId(window.location.pathname) ||
    !!readTemplateParam(window.location.search) ||
    !!readPlansParam(window.location.search) ||
    !!readCustomBotParam(window.location.search)
  );
}

export function useWelcomeAutoOpen(): void {
  // Decided once per load, during first render — before App's mount effects
  // run (in particular before the gallery auto-open stamps its own record,
  // which the gate reads as "evidence of prior use").
  const [decision] = useState(welcomeAutoDecision);

  useEffect(() => {
    if (decision === "no" || isDeepLinkedLoad()) return;

    if (decision === "show") {
      const t = setTimeout(() => {
        writeWelcomeRecord("shown");
        useWelcomeStore.getState().openWelcome();
      }, OPEN_DELAY_MS);
      return () => clearTimeout(t);
    }

    // "announce" — pre-film user: one quiet pointer at the replayable film.
    const t = setTimeout(() => {
      writeWelcomeRecord("announced");
      pushToast('New: an intro film — find "Watch the intro" under More.', "info");
    }, ANNOUNCE_DELAY_MS);
    return () => clearTimeout(t);
  }, [decision]);
}
