/**
 * Applies a `?template=<id>` deep link on first load.
 *
 * The static, SEO-focused template pages under `/templates/<slug>/` (generated
 * by `scripts/gen-template-pages.ts`) link into the app with
 * `/?template=<id>` — their "Open in DWEEB" call to action. This hook reads that
 * param, loads the matching template into the editor exactly as picking it from
 * the Template Gallery would (fresh ids, guided setup for interactive ones, a
 * "go Send" nudge otherwise), and strips the param from the address bar.
 *
 * The template catalogue (`@/data/presets`) is otherwise only reached through
 * the lazily-loaded gallery, so it's imported on demand here too — a plain visit
 * (no `?template=`) never pulls it into the main bundle.
 */

import { useEffect, useRef } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useSendNudgeStore } from "@/core/state/sendNudgeStore";
import { isRegisteredPluginId } from "@/core/plugins/registry";
import { useTemplateSetupStore } from "@/features/templates/templateSetupStore";
import { pushToast } from "@/ui/Toast";

/** The `?template=<id>` value, validated to the id shape templates use. */
export function readTemplateParam(search: string): string | null {
  const id = new URLSearchParams(search).get("template");
  return id && /^[a-z0-9-]{1,40}$/i.test(id) ? id : null;
}

function stripTemplateParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("template");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

export function useTemplateDeepLink(): void {
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const id = readTemplateParam(window.location.search);
    if (!id) return;

    void (async () => {
      const { TEMPLATES } = await import("@/data/presets");
      const template = TEMPLATES.find((t) => t.id === id);
      // Clear the param either way so a refresh starts clean.
      stripTemplateParam();
      if (!template) {
        pushToast("That template link wasn't found — starting you in the editor.", "info");
        return;
      }

      replaceMessage(template.message);

      // Mirror the gallery's pick behaviour: a template with a resolvable
      // plugin slot (interactive or link) hands off to the guided setup;
      // everything else points the user straight at Send.
      const canSetup =
        !!template.pluginSlots?.length &&
        template.pluginSlots.some((slot) => isRegisteredPluginId(slot.pluginId));
      if (canSetup) {
        useTemplateSetupStore.getState().begin(template.id);
      } else {
        useSendNudgeStore.getState().nudge();
      }

      pushToast(`Loaded the “${template.name}” template — make it yours, then Send.`, "success");
    })();
  }, [replaceMessage]);
}
