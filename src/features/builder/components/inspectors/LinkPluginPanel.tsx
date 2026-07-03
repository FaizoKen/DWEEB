/**
 * Link action panel — point a Link button at a URL-based external plugin.
 *
 * The Link-button sibling of {@link PluginPanel}, rendered by the Inspector in
 * the same slot (a Link button carries no `custom_id`, so the interactive panel
 * never applies to it). It owns the one decision a Link button makes — where it
 * takes people — and the binding *is* the button's `url`: picking a plugin
 * writes the manifest's URL template onto the button, and on reload the
 * attachment is recomputed purely from that URL via `matchLinkPlugin`, so
 * nothing plugin-specific is ever persisted on the message.
 *
 * There is no config iframe and no save protocol — a link plugin is manifest
 * data only. The per-server half lives on the external service itself, reached
 * through the chip's "Set up" action (`setupUrl`).
 *
 * Self-gating: renders nothing unless the node is a Link button and at least
 * one link plugin ships in the registry, so the editor looks exactly as it did
 * before link plugins existed.
 */

import { useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { LINK_PLUGINS, isLinkPluginRegistryConfigured } from "@/core/plugins/registry";
import { matchLinkPlugin, type LinkPluginManifest } from "@/core/plugins/linkManifest";
import { isButton } from "@/core/schema/guards";
import { ButtonStyle, type AnyComponent, type LinkButtonComponent } from "@/core/schema/types";
import { Button } from "@/ui/Button";
import { ChevronRightIcon, GlobeIcon } from "@/ui/Icon";
import { PluginIcon } from "@/features/plugins/PluginIcon";
import { LinkPluginLibraryModal } from "@/features/plugins/LinkPluginLibraryModal";
import { LinkParamFields } from "@/features/plugins/LinkParamFields";
import styles from "./PluginPanel.module.css";

interface Props {
  node: AnyComponent;
}

/**
 * A neutral URL to fall back to on detach — the same default a fresh Link
 * button gets (`makeLink` in the ButtonInspector), matching no template prefix.
 */
const DETACHED_URL = "https://discord.com";

export function LinkPluginPanel({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const [libraryOpen, setLibraryOpen] = useState(false);

  if (!isButton(node) || node.style !== ButtonStyle.Link) return null;
  // No link plugins bundled → the whole panel is dormant, like PluginPanel
  // without a registry.
  if (!isLinkPluginRegistryConfigured()) return null;

  const attached = matchLinkPlugin(LINK_PLUGINS, node.url);

  const writeUrl = (url: string) => patch<LinkButtonComponent>(node._id, { url });

  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <span className={styles.title}>Action</span>
        <span className={styles.sub}>Where this link takes people.</span>
      </div>

      {attached ? (
        <>
          <LinkAttachedChip manifest={attached} onDetach={() => writeUrl(DETACHED_URL)} />
          {/* The plugin's user params (a form id, a page slug) — the piece of
              the URL only this admin knows. Typing splices it into the locked
              URL below; until filled, the validator blocks send rather than
              letting a dead link post. */}
          <LinkParamFields manifest={attached} url={node.url} onWrite={writeUrl} />
        </>
      ) : (
        <button type="button" className={styles.browse} onClick={() => setLibraryOpen(true)}>
          <span className={styles.browseIcon} aria-hidden>
            <GlobeIcon size={20} />
          </span>
          <span className={styles.browseBody}>
            <span className={styles.browseTitle}>Browse link plugins</span>
            <span className={styles.browseSub}>
              Point this button at a ready-made service — works on any webhook, never expires.
            </span>
          </span>
          <span className={styles.browseEnd}>
            <span className={styles.browseCount}>{LINK_PLUGINS.length}</span>
            <ChevronRightIcon size={18} className={styles.browseChevron} aria-hidden />
          </span>
        </button>
      )}

      {/* The URL field itself stays in the ButtonInspector below — it's a core
          Link-button field, not a power-user fallback like the raw custom_id,
          so it isn't tucked behind a disclosure. It locks while attached. */}

      {libraryOpen ? (
        <LinkPluginLibraryModal
          plugins={LINK_PLUGINS}
          onPick={(manifest) => {
            setLibraryOpen(false);
            // Adopting the template is the whole attach: core {tokens} in it
            // (e.g. {server_id}) resolve at send from the destination webhook.
            writeUrl(manifest.url);
          }}
          onClose={() => setLibraryOpen(false)}
        />
      ) : null}
    </div>
  );
}

function LinkAttachedChip({
  manifest,
  onDetach,
}: {
  manifest: LinkPluginManifest;
  onDetach: () => void;
}) {
  const by = manifest.publisher ?? manifest.name;
  return (
    <>
      <div className={styles.chip}>
        <PluginIcon manifest={manifest} />
        <div className={styles.chipText}>
          <span className={styles.chipName}>{manifest.name}</span>
          {manifest.description ? (
            <span className={styles.chipDesc}>{manifest.description}</span>
          ) : null}
          <span className={styles.chipMeta}>via {by} — external link service</span>
        </div>
        <div className={styles.chipActions}>
          {manifest.setupUrl ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => window.open(manifest.setupUrl, "_blank", "noopener,noreferrer")}
            >
              Set up
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onDetach}>
            Detach
          </Button>
        </div>
      </div>
      {/* DWEEB can't verify the external service's per-server state, so the one
          thing that can go quietly wrong — posting the button before the server
          is registered — is called out persistently, not just in the library. */}
      {manifest.setupUrl ? (
        <p className={styles.muted}>
          {manifest.setupHint ??
            `The link only works once your server is set up with ${by} — “Set up” takes you there.`}{" "}
          {manifest.homepage ? (
            <a className={styles.link} href={manifest.homepage} target="_blank" rel="noreferrer">
              Learn more
            </a>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
