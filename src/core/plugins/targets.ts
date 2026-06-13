/**
 * Plugin targets — the stable, plugin-facing names for the interactive
 * component kinds a plugin can attach to.
 *
 * Plugin authors should never see Discord's numeric `ComponentType` wire
 * values; those can shift and leak an implementation detail. This module is the
 * single translation layer between the editor's component nodes and the stable
 * string enum the manifest declares.
 *
 * "Interactive" mirrors the capability inspector's definition (`capability.ts`):
 * every select menu, plus buttons that carry a `custom_id` (i.e. not Link and
 * not Premium). Those are exactly the components that fire a Discord
 * interaction a microservice can handle.
 */

import { isActionRow, isButton, isContainer, isSection, isSelect } from "@/core/schema/guards";
import {
  ButtonStyle,
  ComponentType,
  type AnyComponent,
  type EditorId,
  type WebhookMessage,
} from "@/core/schema/types";
import type { PluginManifest } from "./manifest";

export type PluginTarget =
  | "button"
  | "string_select"
  | "user_select"
  | "role_select"
  | "mentionable_select"
  | "channel_select";

/** Every legal target, used to validate a manifest's `targets` array. */
export const ALL_PLUGIN_TARGETS: readonly PluginTarget[] = [
  "button",
  "string_select",
  "user_select",
  "role_select",
  "mentionable_select",
  "channel_select",
];

/**
 * The plugin target a node represents, or `null` when the node isn't an
 * interactive component a plugin can attach to (Link/Premium buttons, layout
 * components, etc.).
 */
export function targetOf(node: AnyComponent): PluginTarget | null {
  if (isButton(node)) {
    // Link and Premium buttons carry no custom_id — nothing for a plugin to own.
    if (node.style === ButtonStyle.Link || node.style === ButtonStyle.Premium) return null;
    return "button";
  }
  if (isSelect(node)) {
    switch (node.type) {
      case ComponentType.StringSelect:
        return "string_select";
      case ComponentType.UserSelect:
        return "user_select";
      case ComponentType.RoleSelect:
        return "role_select";
      case ComponentType.MentionableSelect:
        return "mentionable_select";
      case ComponentType.ChannelSelect:
        return "channel_select";
    }
  }
  return null;
}

/** True when a plugin can be attached to this node. */
export function isPluginTarget(node: AnyComponent): boolean {
  return targetOf(node) !== null;
}

/** Plugins from a list that declare support for `target`. */
export function pluginsForTarget(
  plugins: PluginManifest[],
  target: PluginTarget,
): PluginManifest[] {
  return plugins.filter((p) => p.targets.includes(target));
}

/**
 * The plugin that owns a given `custom_id`, by prefix match, or `null`. This is
 * how a draft or share link re-binds to a plugin on reload without DWEEB
 * storing anything beyond the `custom_id` itself. The longest matching prefix
 * wins so a more specific plugin isn't shadowed by a broader one.
 */
export function matchPlugin(
  plugins: PluginManifest[],
  customId: string | undefined,
): PluginManifest | null {
  if (!customId) return null;
  let best: PluginManifest | null = null;
  for (const p of plugins) {
    if (customId.startsWith(p.customIdPrefix)) {
      if (!best || p.customIdPrefix.length > best.customIdPrefix.length) best = p;
    }
  }
  return best;
}

/** One interactive component bound (by `custom_id` prefix) to a plugin. */
export interface PluginBoundComponent {
  customId: string;
  plugin: PluginManifest;
}

/**
 * Every interactive component in a message whose `custom_id` belongs to a
 * registered plugin. These are exactly the components that only respond when
 * the message's interactions reach the DWEEB dispatcher — Discord delivers
 * component clicks to the app that owns the webhook, so posting them through
 * a webhook owned by an unrelated app leaves them permanently dead. Callers
 * use this to decide whether that mismatch is worth warning about.
 */
export function pluginBoundComponents(
  plugins: PluginManifest[],
  message: WebhookMessage,
): PluginBoundComponent[] {
  const out: PluginBoundComponent[] = [];
  for (const node of walkAll(message)) {
    if (targetOf(node) === null) continue;
    const customId = (node as { custom_id?: unknown }).custom_id;
    if (typeof customId !== "string") continue;
    const plugin = matchPlugin(plugins, customId);
    if (plugin) out.push({ customId, plugin });
  }
  return out;
}

/** An interactive component carrying a `custom_id`, paired with its editor id. */
export interface InteractiveNode {
  nodeId: EditorId;
  customId: string;
}

/**
 * Every interactive component in the message that carries a `custom_id`, with
 * the editor id of the owning node so a caller can jump to it. Unlike
 * {@link pluginBoundComponents} this needs no plugin registry — it's the raw
 * list of attachable components, which callers cross-reference against their
 * own state (e.g. the per-binding guild cache) to spot a misconfiguration.
 */
export function interactiveComponents(message: WebhookMessage): InteractiveNode[] {
  const out: InteractiveNode[] = [];
  for (const node of walkAll(message)) {
    if (targetOf(node) === null) continue;
    const customId = (node as { custom_id?: unknown }).custom_id;
    if (typeof customId === "string") out.push({ nodeId: node._id, customId });
  }
  return out;
}

/** Yields every node (top-level + nested), mirroring the capability walker. */
function* walkAll(message: WebhookMessage): Generator<AnyComponent> {
  for (const top of message.components) yield* deep(top);
}

function* deep(node: AnyComponent): Generator<AnyComponent> {
  yield node;
  if (isContainer(node)) {
    for (const child of node.components) yield* deep(child);
  } else if (isSection(node)) {
    for (const t of node.components) yield t;
    yield node.accessory;
  } else if (isActionRow(node)) {
    for (const child of node.components) yield child;
  }
}
