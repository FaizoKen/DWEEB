/**
 * Capability banner for an interaction component (an interactive button or any
 * select). Lifted out of the per-type inspectors so the Inspector can render it
 * above the Action panel: the notice frames the whole interaction, and the
 * action it warns about then reads as the first thing inside that frame.
 *
 * Plugin-aware — when a plugin owns the component the warning softens to an
 * "info" note naming it, mirroring how the rest of the inspector reacts to an
 * attached plugin. Rendered only for plugin-target nodes, so the button/select
 * split below is the only distinction it has to make.
 */

import { isSelect } from "@/core/schema/guards";
import type { AnyComponent } from "@/core/schema/types";
import { useAttachedPlugin } from "@/features/plugins/useAttachedPlugin";
import { CapabilityNote } from "./CapabilityNote";

export function InteractionNotice({ node }: { node: AnyComponent }) {
  const attachedPlugin = useAttachedPlugin(node);
  const select = isSelect(node);

  if (attachedPlugin) {
    return (
      <CapabilityNote tone="info">
        <strong>Handled by {attachedPlugin.name}.</strong> {select ? "Selections" : "Clicks"} are
        processed by the plugin's service — send this message through an application-owned webhook
        so they reach it.
      </CapabilityNote>
    );
  }

  return (
    <CapabilityNote>
      <strong>Needs an application-owned webhook.</strong>{" "}
      {select ? (
        <>
          Discord rejects messages containing select menus when sent through a regular user-created
          webhook — only application/bot-owned webhooks can post them.
        </>
      ) : (
        <>
          Discord rejects messages with interactive buttons when sent through a regular user-created
          webhook. Use a Link button if you just want a hyperlink.
        </>
      )}
    </CapabilityNote>
  );
}
