/**
 * React binding for the browser install-signal store in `core/pwa`.
 *
 * Kept apart from the store module so that module stays framework-free (it's
 * imported from the entry chunk and from node-environment tests), while the
 * hook here lives with the feature that renders it.
 */

import { useSyncExternalStore } from "react";
import {
  getInstallSnapshot,
  subscribeInstall,
  type InstallSnapshot,
} from "@/core/pwa/installPrompt";

/** Live install state: whether we're already installed and whether a native
 *  prompt is ready to replay. Drives the Builder menu entry and the dialog. */
export function useInstallState(): InstallSnapshot {
  return useSyncExternalStore(subscribeInstall, getInstallSnapshot, getInstallSnapshot);
}
