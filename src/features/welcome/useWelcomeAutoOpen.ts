/**
 * One-shot discovery prompt for the optional intro film.
 *
 * New users already land in the Template Gallery, so interrupting them with a
 * second overlay and a multi-megabyte autoplay film is counterproductive. A
 * one-time toast points to More ▸ Watch the intro instead; the media is loaded
 * only after the user explicitly asks for it.
 *
 * Stands down entirely on deep-linked loads (a share/short link being decoded,
 * a `?template=`/`?plans=`/`?custom-bot=` param, or a webhook-create redirect) —
 * the visitor
 * came for something specific, so nothing is recorded and a later organic
 * visit still gets the one prompt. Pre-film users (evidence of prior use)
 * get a single toast pointing at the More menu's "Watch the intro" instead.
 *
 * The decision itself lives in `welcomeGate`; an "announced" record keeps the
 * prompt one-shot. Legacy "shown" records remain valid and suppress it too.
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

/** Let the initial layout + gallery entrance settle before the quiet prompt. */
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

    const t = setTimeout(() => {
      writeWelcomeRecord("announced");
      pushToast('Want a quick tour? Choose "Watch the intro" under More.', "info");
    }, ANNOUNCE_DELAY_MS);
    return () => clearTimeout(t);
  }, [decision]);
}
