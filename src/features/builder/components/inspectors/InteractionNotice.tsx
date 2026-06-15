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
        <strong>Handled by {attachedPlugin.name}.</strong> Send through a bot- or app-owned webhook
        so {select ? "selections" : "clicks"} reach it.
      </CapabilityNote>
    );
  }

  return (
    <CapabilityNote>
      <strong>Needs an app-owned webhook.</strong>{" "}
      {select ? (
        <>A regular webhook can't post select menus — only a bot- or app-owned one can.</>
      ) : (
        <>A regular webhook can't post clickable buttons. Just want a link? Use a Link button.</>
      )}
    </CapabilityNote>
  );
}
