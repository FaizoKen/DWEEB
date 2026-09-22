/**
 * Link-plugin configuration modal.
 *
 * The Link-button sibling of `PluginConfigModal`: frames the link plugin's own
 * config UI (`manifest.configUrl`) in the same sandboxed iframe and runs the
 * `useLinkPluginConfig` handshake, whose validated save hands back the
 * button's **URL** instead of a `custom_id`. DWEEB renders no part of the
 * form — it only frames it and adopts what validates.
 *
 * It carries the same host-side failure surfaces as `PluginConfigModal`, and
 * for the same reason: a cover over the frame while the handshake is
 * outstanding, a retryable notice (and this dialog's only footer) once it times
 * out, and the hook's `saveError` under it when a returned URL is refused.
 */

import { useEffect } from "react";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { cn } from "@/lib/cn";
import {
  PLUGIN_IFRAME_SANDBOX,
  PLUGIN_IFRAME_SANDBOX_PROXIED,
  type PluginTheme,
} from "@/core/plugins/protocol";
import { isActivityProxiedPlugins, proxiedPluginConfigUrl } from "@/core/activity/runtime";
import type { LinkPluginManifest } from "@/core/plugins/linkManifest";
import { PLUGIN_RESOURCE_LABELS } from "@/core/plugins/resources";
import {
  linkFrameTimeoutMessage,
  useLinkPluginConfig,
  type LinkPluginSaveResult,
} from "./useLinkPluginConfig";
import styles from "./PluginConfigModal.module.css";

interface Props {
  /** Must carry a `configUrl` — the caller only offers Configure when it does. */
  manifest: LinkPluginManifest;
  /** The button's current URL when reconfiguring an existing binding. */
  linkUrl?: string;
  onSave: (result: LinkPluginSaveResult) => void;
  onClose: () => void;
}

/** Single dark UI — same reasoning as PluginConfigModal's resolveTheme. */
function resolveTheme(): PluginTheme {
  return "dark";
}

const DEFAULT_HEIGHT = 440;

export function LinkPluginConfigModal({ manifest, linkUrl, onSave, onClose }: Props) {
  const { iframeRef, height, saveError, frameState, frameKey, retry } = useLinkPluginConfig({
    manifest,
    linkUrl,
    theme: resolveTheme(),
    onSave,
    onCancel: onClose,
  });

  useEffect(() => {
    const t = setTimeout(() => iframeRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [iframeRef]);

  const onRetry = () => {
    retry();
    // The Retry control unmounts with the failure notice it belongs to, so hand
    // focus to the replacement frame rather than letting it fall to <body>.
    requestAnimationFrame(() => iframeRef.current?.focus());
  };

  const proxied = isActivityProxiedPlugins();
  const configUrl = manifest.configUrl;
  if (!configUrl) return null;

  return (
    <Modal
      open
      title={`Configure ${manifest.name}`}
      onClose={onClose}
      footer={
        // Only a frame that never answered needs host-rendered controls — a
        // live plugin renders its own Save/Cancel inside the iframe.
        frameState === "timeout" ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" onClick={onRetry}>
              Retry
            </Button>
          </>
        ) : undefined
      }
    >
      <div className={styles.frameWrap}>
        <iframe
          // Bumped by Retry: a new element is the only way to re-request a
          // document the browser already failed (or cached) for this src.
          key={frameKey}
          ref={iframeRef}
          className={styles.frame}
          src={proxiedPluginConfigUrl(configUrl)}
          sandbox={proxied ? PLUGIN_IFRAME_SANDBOX_PROXIED : PLUGIN_IFRAME_SANDBOX}
          title={`${manifest.name} configuration`}
          style={{ height: height ?? DEFAULT_HEIGHT }}
          referrerPolicy="no-referrer"
        />
        {frameState !== "ready" ? (
          <div className={styles.frameCover}>
            {frameState === "loading" ? (
              <p className={styles.frameCoverText} role="status">
                Loading {manifest.name}…
              </p>
            ) : (
              <p className={cn(styles.frameCoverText, styles.frameCoverFailed)} role="alert">
                {linkFrameTimeoutMessage(manifest.name)}
              </p>
            )}
          </div>
        ) : null}
      </div>
      {saveError ? (
        <p className={styles.error} role="alert">
          {saveError}
        </p>
      ) : null}
      <p className={styles.note}>
        Configuration is handled by <strong>{manifest.name}</strong>. DWEEB only stores the
        resulting link URL on this button.
        {manifest.resources?.length ? (
          <>
            {" "}
            This plugin may request{" "}
            <strong>
              {manifest.resources.map((resource) => PLUGIN_RESOURCE_LABELS[resource]).join(", ")}
            </strong>
            .
          </>
        ) : (
          " It has not declared access to editor data."
        )}
      </p>
    </Modal>
  );
}
