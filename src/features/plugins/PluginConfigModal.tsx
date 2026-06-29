/**
 * Plugin configuration modal.
 *
 * Hosts the plugin's own config UI inside a sandboxed iframe and runs the
 * postMessage handshake (`usePluginConfig`). DWEEB renders no part of the
 * config form — it only frames it, validates what comes back, and hands the
 * resulting `custom_id` to the caller.
 */

import { useEffect } from "react";
import { Modal } from "@/ui/Modal";
import {
  PLUGIN_IFRAME_SANDBOX,
  PLUGIN_IFRAME_SANDBOX_PROXIED,
  type PluginTheme,
} from "@/core/plugins/protocol";
import { isActivityProxiedPlugins, proxiedPluginConfigUrl } from "@/core/activity/runtime";
import type { PluginManifest } from "@/core/plugins/manifest";
import type { PluginTarget } from "@/core/plugins/targets";
import { usePluginConfig, type PluginSaveResult } from "./usePluginConfig";
import styles from "./PluginConfigModal.module.css";

interface Props {
  manifest: PluginManifest;
  target: PluginTarget;
  /** Current custom_id when reconfiguring; undefined when attaching fresh. */
  customId?: string;
  /** A manifest preset id to pre-apply on a fresh attach (library/template pick). */
  preset?: string;
  onSave: (result: PluginSaveResult) => void;
  onClose: () => void;
}

/**
 * DWEEB ships a single dark UI, so the plugin frame is always dark too. We
 * deliberately ignore the OS `prefers-color-scheme` hint here — following it
 * made the config form render light (white) on a light-mode OS while the rest
 * of the app stayed dark. If the app ever gains a real light theme, resolve it
 * from that, not from the OS.
 */
function resolveTheme(): PluginTheme {
  return "dark";
}

const DEFAULT_HEIGHT = 440;

export function PluginConfigModal({ manifest, target, customId, preset, onSave, onClose }: Props) {
  const { iframeRef, height } = usePluginConfig({
    manifest,
    target,
    customId,
    preset,
    theme: resolveTheme(),
    onSave,
    onCancel: onClose,
  });

  // Re-key warning: this component is mounted fresh per open by the parent
  // (keyed on the binding), so the hook's nonce resets each time. Nothing to do
  // here beyond focusing the frame once it's in the DOM.
  useEffect(() => {
    const t = setTimeout(() => iframeRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [iframeRef]);

  // Inside a real Discord Activity the cross-origin plugin frame is CSP-blocked
  // (renders blank), so load it through the proxy — same-origin, hence the
  // opaque-origin sandbox (see the constants). Everywhere else: load it directly.
  const proxied = isActivityProxiedPlugins();

  return (
    <Modal open title={`Configure ${manifest.name}`} onClose={onClose}>
      <div className={styles.frameWrap}>
        <iframe
          ref={iframeRef}
          className={styles.frame}
          src={proxiedPluginConfigUrl(manifest.configUrl)}
          sandbox={proxied ? PLUGIN_IFRAME_SANDBOX_PROXIED : PLUGIN_IFRAME_SANDBOX}
          title={`${manifest.name} configuration`}
          style={{ height: height ?? DEFAULT_HEIGHT }}
          // The plugin owns everything inside; it cannot reach the parent except
          // through the audited postMessage channel.
          referrerPolicy="no-referrer"
        />
      </div>
      <p className={styles.note}>
        Configuration is handled by <strong>{manifest.name}</strong>. DWEEB only stores the
        resulting action id on this component.
      </p>
    </Modal>
  );
}
