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
import { PLUGIN_IFRAME_SANDBOX, type PluginTheme } from "@/core/plugins/protocol";
import type { PluginManifest } from "@/core/plugins/manifest";
import type { PluginTarget } from "@/core/plugins/targets";
import { usePluginConfig, type PluginSaveResult } from "./usePluginConfig";
import styles from "./PluginConfigModal.module.css";

interface Props {
  manifest: PluginManifest;
  target: PluginTarget;
  /** Current custom_id when reconfiguring; undefined when attaching fresh. */
  customId?: string;
  onSave: (result: PluginSaveResult) => void;
  onClose: () => void;
}

/** App ships a single dark theme; fall back to the OS hint if that ever changes. */
function resolveTheme(): PluginTheme {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

const DEFAULT_HEIGHT = 440;

export function PluginConfigModal({ manifest, target, customId, onSave, onClose }: Props) {
  const { iframeRef, height } = usePluginConfig({
    manifest,
    target,
    customId,
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

  return (
    <Modal open title={`Configure ${manifest.name}`} onClose={onClose}>
      <div className={styles.frameWrap}>
        <iframe
          ref={iframeRef}
          className={styles.frame}
          src={manifest.configUrl}
          sandbox={PLUGIN_IFRAME_SANDBOX}
          title={`${manifest.name} configuration`}
          style={{ height: height ?? DEFAULT_HEIGHT }}
          // The plugin owns everything inside; it cannot reach the parent except
          // through the audited postMessage channel.
          referrerPolicy="no-referrer"
        />
      </div>
      <p className={styles.note}>
        Configuration is handled by <strong>{manifest.name}</strong>
        {manifest.publisher ? ` · ${manifest.publisher}` : ""}. DWEEB only stores the resulting
        action id on this component.
      </p>
    </Modal>
  );
}
