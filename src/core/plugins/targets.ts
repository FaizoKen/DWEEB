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

import {
  isActionRow,
  isButton,
  isContainer,
  isSection,
  isSelect,
  isTextDisplay,
} from "@/core/schema/guards";
import {
  ButtonStyle,
  ComponentType,
  type AnyComponent,
  type EditorId,
  type WebhookMessage,
} from "@/core/schema/types";
import type { PluginManifest } from "./manifest";
import { linkUrlPrefix, type LinkPluginManifest } from "./linkManifest";

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
    // Link and Premium buttons carry no custom_id — nothing for a plugin to
    // own here. (Link buttons instead take the URL-based plugins that bind by
    // `url` prefix — see `linkManifest.ts`.)
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

/**
 * A specific, human noun for a component target — for UI that must tell several
 * otherwise-identical plugin slots apart (e.g. the four Picker menus in the
 * Server Directory template). The generic "menu"/"button" can't distinguish a
 * channel menu from a role menu; these can.
 */
export function targetNoun(target: PluginTarget): string {
  switch (target) {
    case "button":
      return "button";
    case "string_select":
      return "options menu";
    case "user_select":
      return "member menu";
    case "role_select":
      return "role menu";
    case "mentionable_select":
      return "member / role menu";
    case "channel_select":
      return "channel menu";
  }
}

/** Plugins from a list that declare support for `target`. */
export function pluginsForTarget(
  plugins: PluginManifest[],
  target: PluginTarget,
): PluginManifest[] {
  return plugins.filter((p) => p.targets.includes(target));
}

/**
 * The plugin's ready-made presets that apply to a given component target. A
 * preset with no `targets` applies to every kind the plugin supports; one that
 * lists targets is shown only for those (e.g. a Quick Replies topic-menu preset
 * surfaces on a select, not a button). Empty when the plugin ships no presets.
 */
export function presetsForTarget(manifest: PluginManifest, target: PluginTarget) {
  return (manifest.presets ?? []).filter((p) => !p.targets || p.targets.includes(target));
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

/**
 * Locate an interactive component by its current `custom_id`, returning its
 * editor id + resolved target, or `null`. The guided template-setup flow uses
 * this to map each declared plugin slot — keyed by the placeholder `custom_id`
 * the template ships — to the live component, so it can wire several plugins in
 * one message without the user hunting for any of them.
 */
export function targetableNodeByCustomId(
  message: WebhookMessage,
  customId: string,
): { nodeId: EditorId; target: PluginTarget } | null {
  for (const node of walkAll(message)) {
    const t = targetOf(node);
    if (!t) continue;
    if ((node as { custom_id?: unknown }).custom_id === customId) {
      return { nodeId: node._id, target: t };
    }
  }
  return null;
}

/**
 * Locate the Link button bound (by URL prefix) to the given link plugin,
 * returning its editor id, or `null`. The link-slot counterpart of
 * {@link targetableNodeByCustomId}: the guided template-setup flow uses it to
 * map a declared link slot — identified only by its plugin id, since a Link
 * button carries no `custom_id` — to the live component holding that plugin's
 * URL. First match wins; a template shipping two buttons on the same link
 * plugin would need per-slot disambiguation that nothing requires yet.
 */
export function linkButtonNodeByPlugin(
  message: WebhookMessage,
  manifest: LinkPluginManifest,
): EditorId | null {
  const prefix = linkUrlPrefix(manifest.url);
  for (const node of walkAll(message)) {
    if (!isButton(node) || node.style !== ButtonStyle.Link) continue;
    if (node.url.startsWith(prefix)) return node._id;
  }
  return null;
}

/**
 * The live URL of a Link button tracked by editor id, or `null` when the node
 * is gone or isn't a Link button (anymore). Companion to
 * {@link linkButtonNodeByPlugin} for UI that resolved a node once and needs to
 * read the current binding back off the message — the template-setup checklist
 * rendering a link slot's param inputs.
 */
export function linkButtonUrlById(message: WebhookMessage, nodeId: EditorId): string | null {
  for (const node of walkAll(message)) {
    if (node._id !== nodeId) continue;
    return isButton(node) && node.style === ButtonStyle.Link ? node.url : null;
  }
  return null;
}

/**
 * How a single interactive component reads to a member, for UI that lists
 * several of them at once and must say which is which. `label` is the control's
 * own visible text (a button's label or a select's placeholder); `context` is
 * the nearest line of message text *before* it — typically the section heading
 * above a menu — with light markdown stripped. Together they answer "which part
 * of the message is this, and for what". Either may be absent.
 */
export interface ComponentIdentity {
  label?: string;
  context?: string;
}

/**
 * Resolve the {@link ComponentIdentity} of the interactive component with the
 * given editor id. Walks the message in document order, remembering the last
 * text block seen, so when the target is reached its preceding heading is in
 * hand. Returns an empty object when the node isn't found.
 */
export function componentIdentity(message: WebhookMessage, nodeId: EditorId): ComponentIdentity {
  let lastText: string | undefined;
  let result: ComponentIdentity | undefined;
  const visit = (node: AnyComponent): void => {
    if (result) return;
    if (isTextDisplay(node)) {
      lastText = node.content;
      return;
    }
    if (node._id === nodeId) {
      const own =
        isButton(node) && "label" in node
          ? node.label
          : isSelect(node)
            ? node.placeholder
            : undefined;
      result = {
        ...(own ? { label: own } : {}),
        ...(lastText ? { context: plainText(lastText) } : {}),
      };
      return;
    }
    if (isContainer(node)) for (const child of node.components) visit(child);
    else if (isSection(node)) {
      for (const t of node.components) visit(t);
      visit(node.accessory);
    } else if (isActionRow(node)) for (const child of node.components) visit(child);
  };
  for (const top of message.components) {
    visit(top);
    if (result) break;
  }
  return result ?? {};
}

/**
 * First non-empty line of message text with light markdown stripped — enough to
 * read a heading like "**🧭 Channels** — find a place…" as plain
 * "🧭 Channels — find a place…" for a one-line label.
 */
function plainText(content: string): string {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? content;
  return firstLine
    .replace(/^#{1,6}\s+/, "") // heading markers
    .replace(/[*_~`]/g, "") // emphasis / inline code
    .replace(/\s+/g, " ")
    .trim();
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
