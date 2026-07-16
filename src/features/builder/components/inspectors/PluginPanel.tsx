/**
 * Action panel — wire up what happens when an interactive component is used.
 *
 * Rendered by the Inspector for any button (except Premium) and any select. It
 * owns the one decision the component makes — its action — and keeps together
 * the value that *is* that decision:
 *
 *  - For a **select** or an **interactive button**, that's the `custom_id`
 *    Discord delivers on use, and the plugin (if any) that claims it by prefix.
 *  - For a **Link button**, it's the `url`, and the URL-based link plugin that
 *    claims it by template prefix.
 *
 * A button can take *either* kind of action, so its "Browse plugins" library
 * lists both — interactive plugins that DWEEB handles, and link plugins that
 * open an external page — in one modal. Picking across the divide switches the
 * button's style to match (a link plugin makes it a Link; an interactive plugin
 * makes it a normal button) and, on a fresh attach, names the button after the
 * plugin and enables it, so a picked action arrives ready to use. On reload we
 * recompute the attachment purely from the id/url via `matchPlugin` /
 * `matchLinkPlugin`, so nothing plugin-specific is ever persisted on the message.
 *
 * When no registry ships (`isPluginRegistryConfigured()` is false and no link
 * plugins bundled) the plugin half is dormant and we render just the bare
 * `custom_id` field — the editor looks exactly as it did before plugins existed.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { usePluginRegistry } from "@/core/state/pluginRegistryStore";
import { isActivityMode, openExternalUrl } from "@/core/activity/runtime";
import {
  clearPluginSummary,
  getPluginSummary,
  setPluginSummary,
} from "@/core/state/pluginSummaryCache";
import {
  isPluginRegistryConfigured,
  isLinkPluginRegistryConfigured,
  LINK_PLUGINS,
} from "@/core/plugins/registry";
import { LIMITS } from "@/core/schema/limits";
import { clearPluginEditToken } from "@/core/plugins/editTokenCache";
import type { PluginManifest } from "@/core/plugins/manifest";
import {
  matchLinkPlugin,
  unfilledLinkTokens,
  type LinkPluginManifest,
} from "@/core/plugins/linkManifest";
import { matchPlugin, pluginsForTarget, targetOf, type PluginTarget } from "@/core/plugins/targets";
import { isButton } from "@/core/schema/guards";
import {
  ButtonStyle,
  ComponentType,
  type AnyComponent,
  type ButtonComponent,
  type InteractiveButtonComponent,
  type LinkButtonComponent,
  type PartialEmoji,
  type StringSelectComponent,
} from "@/core/schema/types";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { AlertTriangleIcon, ChevronRightIcon, PuzzleIcon } from "@/ui/Icon";
import { PluginConfigModal } from "@/features/plugins/PluginConfigModal";
import { LinkPluginConfigModal } from "@/features/plugins/LinkPluginConfigModal";
import { PluginIcon } from "@/features/plugins/PluginIcon";
import { PluginLibraryModal } from "@/features/plugins/PluginLibraryModal";
import type { PluginSaveResult } from "@/features/plugins/usePluginConfig";
import type { LinkPluginSaveResult } from "@/features/plugins/useLinkPluginConfig";
import { useLinkPluginStatus } from "@/features/plugins/useLinkPluginStatus";
import { CustomIdField } from "./CustomIdField";
import { emojiFromString } from "./EmojiField";
import styles from "./PluginPanel.module.css";

interface Props {
  node: AnyComponent;
}

/** A neutral custom_id to fall back to on detach (won't match any plugin prefix). */
const DETACH_DEFAULTS: Record<PluginTarget, string> = {
  button: "button_action",
  string_select: "string_select",
  user_select: "user_select",
  role_select: "role_select",
  mentionable_select: "mentionable_select",
  channel_select: "channel_select",
};

/** The URL a detached Link button falls back to — the fresh-Link default, which
 *  matches no link-plugin template prefix. */
const DETACHED_URL = "https://discord.com";

function currentCustomId(node: AnyComponent): string | undefined {
  return "custom_id" in node ? (node as { custom_id?: string }).custom_id : undefined;
}

/** The plugin target a button/select maps to for the interactive library —
 *  "button" for any non-Premium button (Link included, since picking an
 *  interactive plugin converts it), else the select's own target. */
function actionTarget(node: AnyComponent): PluginTarget | null {
  if (isButton(node)) return node.style === ButtonStyle.Premium ? null : "button";
  return targetOf(node);
}

/** The custom_id field's wording + cap, per kind of component. */
function idFieldProps(target: PluginTarget): { maxLength: number; hint: string } {
  if (target === "button") {
    return {
      maxLength: LIMITS.BUTTON_CUSTOM_ID,
      hint: "Your bot receives this when the button is clicked — set it to wire up the action.",
    };
  }
  return {
    maxLength: LIMITS.SELECT_CUSTOM_ID,
    hint: "Sent to your bot when a user changes the selection — set it to wire up the action.",
  };
}

/** Display label + emoji a plugin/preset lends a freshly-attached button. */
interface Presentation {
  label: string;
  emoji?: string;
}

/** The button fields a fresh attach overwrites — narrow enough to apply to a
 *  Link or an interactive button alike (no `style`, which each conversion sets
 *  itself). `disabled: undefined` clears a disabled state (enables the button). */
interface PresentationFields {
  label?: string;
  emoji?: PartialEmoji;
  disabled?: boolean | undefined;
}

/**
 * The label / emoji / enabled state to stamp on a button when a plugin is
 * *freshly* attached — the "make it look like the plugin" step. Picking a plugin
 * from the library is an explicit "adopt this action" gesture, so we overwrite
 * the button's label and emoji outright with the plugin/preset's own — a summary
 * label the plugin handed back wins over the preset name, and a preset with no
 * emoji clears whatever emoji was there, so the button ends up looking exactly
 * like the action it now runs. The button is always enabled — a just-attached
 * action should be live. Only runs on a fresh attach; reconfiguring an
 * already-attached plugin passes no presentation, so the user's tweaks stand.
 *
 * Guards against a doubled glyph: if the chosen label text already carries the
 * (unicode) emoji we'd stamp, we leave the dedicated emoji slot empty instead of
 * rendering the same glyph twice (e.g. a summary label like "Pong! 🏓").
 */
function presentationFields(chosen: Presentation, overrideLabel?: string): PresentationFields {
  const label = overrideLabel || chosen.label;
  const trimmed = label ? label.slice(0, LIMITS.BUTTON_LABEL) : undefined;
  const emoji = emojiFromString(chosen.emoji);
  const alreadyInLabel =
    !!emoji && !emoji.id && !!emoji.name && !!trimmed && trimmed.includes(emoji.name);
  const out: PresentationFields = {
    disabled: undefined,
    emoji: alreadyInLabel ? undefined : emoji,
  };
  if (trimmed) out.label = trimmed;
  return out;
}

/** Build a fresh interactive button from any button node, adopting `customId`
 *  and the presentation overrides — used when a Link button is converted by
 *  attaching an interactive plugin. */
function toInteractiveButton(
  prev: ButtonComponent,
  customId: string,
  overrides: PresentationFields,
): Omit<InteractiveButtonComponent, "_id"> {
  const emoji = "emoji" in overrides ? overrides.emoji : "emoji" in prev ? prev.emoji : undefined;
  const prevLabel = "label" in prev ? prev.label : undefined;
  return {
    type: ComponentType.Button,
    // A Link/Premium source has no interactive style to keep — default to blurple.
    style:
      prev.style === ButtonStyle.Link || prev.style === ButtonStyle.Premium
        ? ButtonStyle.Primary
        : prev.style,
    label: overrides.label ?? prevLabel ?? "Click me",
    custom_id: customId,
    ...(emoji ? { emoji } : {}),
    ...(overrides.disabled ? { disabled: overrides.disabled } : {}),
  };
}

/** Build a fresh Link button from any button node — used when an interactive
 *  button is converted by attaching a link plugin. */
function toLinkButton(
  prev: ButtonComponent,
  url: string,
  overrides: PresentationFields,
): Omit<LinkButtonComponent, "_id"> {
  const emoji = "emoji" in overrides ? overrides.emoji : "emoji" in prev ? prev.emoji : undefined;
  const prevLabel = "label" in prev ? prev.label : undefined;
  return {
    type: ComponentType.Button,
    style: ButtonStyle.Link,
    label: overrides.label ?? prevLabel ?? "Open link",
    url,
    ...(emoji ? { emoji } : {}),
    ...(overrides.disabled ? { disabled: overrides.disabled } : {}),
  };
}

/** The config-iframe session in flight: which plugin, the id being edited (if
 *  reconfiguring), the preset to seed a fresh attach, and the button
 *  presentation to apply on save (only set for a fresh attach). */
interface Configuring {
  manifest: PluginManifest;
  customId?: string;
  preset?: string;
  presentation?: Presentation;
}

/** A link plugin's config-iframe session in flight. `presentation` is set for
 *  a fresh attach only, exactly like the interactive {@link Configuring}. */
interface ConfiguringLink {
  manifest: LinkPluginManifest;
  presentation?: Presentation;
}

/** The button's URL when it's a *finished* binding worth echoing to the config
 *  iframe as `init.linkUrl` — not the manifest's raw template, and not a
 *  half-filled template still carrying a fill-me `{token}`. */
function finishedLinkUrl(
  manifest: LinkPluginManifest,
  url: string | undefined,
): string | undefined {
  if (!url || url === manifest.url) return undefined;
  return unfilledLinkTokens(url).length === 0 ? url : undefined;
}

export function PluginPanel({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const replace = useMessageStore((s) => s.replaceNode);
  const status = usePluginRegistry((s) => s.status);
  const plugins = usePluginRegistry((s) => s.plugins);
  const load = usePluginRegistry((s) => s.load);
  const reload = usePluginRegistry((s) => s.reload);

  const [configuring, setConfiguring] = useState<Configuring | null>(null);
  const [configuringLink, setConfiguringLink] = useState<ConfiguringLink | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // The raw custom_id is the secondary, hand-wiring path — kept collapsed so the
  // ready-made plugin card stays the focus. Only shown for id-bearing components.
  const [showManualId, setShowManualId] = useState(false);

  // Lazy, idempotent: only the first targetable node to render triggers a fetch.
  useEffect(() => {
    if (isPluginRegistryConfigured()) load();
  }, [load]);

  const target = actionTarget(node);
  if (!target) return null;

  const isBtn = isButton(node);
  const linkStyle = isBtn && node.style === ButtonStyle.Link;

  const registryOn = isPluginRegistryConfigured();
  // Link plugins only apply to buttons (they bind by URL, which selects lack).
  const linkOn = isBtn && isLinkPluginRegistryConfigured();

  const customId = currentCustomId(node);
  const attached = registryOn && !linkStyle ? matchPlugin(plugins, customId) : null;
  const attachedLink = linkStyle && linkOn ? matchLinkPlugin(LINK_PLUGINS, node.url) : null;

  const interactiveAvailable = registryOn ? pluginsForTarget(plugins, target) : [];
  const linkAvailable = linkOn ? LINK_PLUGINS : [];
  const totalAvailable = interactiveAvailable.length + linkAvailable.length;

  const { maxLength, hint } = idFieldProps(target);

  // The raw custom_id field — only exists for id-bearing components (not a Link
  // button, whose URL lives in the ButtonInspector). Locked read-only while a
  // plugin owns it (the attachment *is* this value).
  const idField = linkStyle ? null : (
    <CustomIdField
      node={node as AnyComponent & { custom_id: string }}
      maxLength={maxLength}
      hint={hint}
      attachedPlugin={attached}
    />
  );

  // Nothing on offer for this component → behave exactly as before plugins
  // existed: the bare id field (or nothing, for a Link button whose URL editor
  // lives below in the ButtonInspector).
  if (!registryOn && !linkOn) return linkStyle ? null : idField;

  const writeCustomId = (next: string) =>
    patch<InteractiveButtonComponent>(node._id, { custom_id: next });

  // ── Attach / detach ──────────────────────────────────────────────────────

  const handleSave = (ctx: Configuring) => (result: PluginSaveResult) => {
    const { manifest, customId: editingId, presentation } = ctx;
    // Adopting a new id supersedes the old binding's cached summary.
    if (editingId && editingId !== result.customId) clearPluginSummary(editingId);

    if (isBtn) {
      // The plugin owns the custom_id; a fresh attach also names + enables the
      // button, with the plugin's own summary label (when it sent one) winning
      // over the manifest/preset name.
      const fields: Partial<InteractiveButtonComponent> = { custom_id: result.customId };
      if (result.fields) Object.assign(fields, result.fields);
      const shown = presentation ? presentationFields(presentation, result.summary?.label) : {};
      Object.assign(fields, shown);
      if (linkStyle) {
        // Link → interactive: replace so the url is shed and the style/custom_id
        // are set cleanly rather than left half-converted.
        replace<InteractiveButtonComponent>(
          node._id,
          toInteractiveButton(node, result.customId, shown),
        );
      } else {
        patch<InteractiveButtonComponent>(node._id, fields);
      }
    } else {
      // A select: the plugin owns the custom_id and may hand back the exact
      // option list to wire; both lock in their inspectors while attached.
      const fields: Partial<StringSelectComponent> = { custom_id: result.customId };
      if (target === "string_select" && result.options?.length) fields.options = result.options;
      // Fields the plugin owns (e.g. min/max selections) — sanitized + limited
      // to the manifest's declared set by usePluginConfig.
      if (result.fields) Object.assign(fields, result.fields);
      patch<StringSelectComponent>(node._id, fields);
    }

    // Cache the summary plus, for a guild-scoped plugin, the guild it targets and
    // any static placeholder values. All expendable cosmetics.
    if (result.summary || result.guildId || result.values) {
      const summary = result.summary ?? { label: manifest.name };
      setPluginSummary(result.customId, manifest.id, summary, result.guildId, result.values);
    }
    setConfiguring(null);
  };

  const handleDetach = () => {
    if (customId) {
      clearPluginSummary(customId);
      if (attached) clearPluginEditToken(customId, attached.id);
    }
    writeCustomId(DETACH_DEFAULTS[target]);
  };

  const handleDetachLink = () => {
    if (linkStyle && node.url) clearPluginSummary(node.url);
    patch<LinkButtonComponent>(node._id, { url: DETACHED_URL });
  };

  // Adopt a link plugin: convert an interactive button to a Link (or just
  // repoint an existing Link button), naming + enabling it on a fresh attach.
  // A plugin with a config iframe opens it right away — the picked action
  // should arrive configured, mirroring the interactive attach flow.
  const attachLink = (manifest: LinkPluginManifest) => {
    if (!isBtn) return;
    const presentation: Presentation = {
      label: manifest.name,
      emoji: manifest.defaultEmoji,
    };
    const overrides = presentationFields(presentation);
    if (linkStyle) {
      patch<LinkButtonComponent>(node._id, { url: manifest.url, ...overrides });
    } else {
      replace<LinkButtonComponent>(node._id, toLinkButton(node, manifest.url, overrides));
    }
    if (manifest.configUrl) setConfiguringLink({ manifest, presentation });
  };

  // Adopt what a link plugin's config iframe handed back: the URL is the whole
  // binding (already validated against the manifest prefix by the hook); the
  // summary/guild ride in the same expendable cache the interactive chips use,
  // keyed by the URL. A fresh attach also restamps the button's presentation so
  // a summary label ("Staff Application") wins over the manifest name.
  const handleLinkSave = (ctx: ConfiguringLink) => (result: LinkPluginSaveResult) => {
    if (!isBtn) return;
    if (linkStyle && node.url && node.url !== result.url) clearPluginSummary(node.url);
    const shown = ctx.presentation
      ? presentationFields(ctx.presentation, result.summary?.label)
      : {};
    patch<LinkButtonComponent>(node._id, { url: result.url, ...shown });
    if (result.summary || result.guildId) {
      const summary = result.summary ?? { label: ctx.manifest.name };
      setPluginSummary(result.url, ctx.manifest.id, summary, result.guildId);
    }
    setConfiguringLink(null);
  };

  // Open the config iframe for a picked interactive plugin, carrying the
  // presentation to apply on save (fresh attach only).
  const openConfig = (manifest: PluginManifest, presetId?: string) => {
    const preset = presetId ? manifest.presets?.find((p) => p.id === presetId) : undefined;
    setConfiguring({
      manifest,
      preset: presetId,
      presentation: {
        label: preset?.name ?? manifest.name,
        emoji: preset?.emoji ?? manifest.defaultEmoji,
      },
    });
  };

  // ── Chooser: attached chip, a status line, or the library trigger ──────────
  let chooser: ReactNode;
  let offersBrowse = false;
  if (attached) {
    chooser = (
      <AttachedChip
        manifest={attached}
        customId={customId}
        onReconfigure={() => setConfiguring({ manifest: attached, customId })}
        onDetach={handleDetach}
      />
    );
  } else if (attachedLink) {
    chooser = (
      <LinkAttachedChip
        manifest={attachedLink}
        url={linkStyle ? node.url : undefined}
        onConfigure={
          attachedLink.configUrl ? () => setConfiguringLink({ manifest: attachedLink }) : undefined
        }
        onDetach={handleDetachLink}
      />
    );
  } else if (status === "loading") {
    chooser = <p className={styles.muted}>Loading plugins…</p>;
  } else if (status === "error") {
    chooser = (
      <p className={styles.muted}>
        Couldn't load plugins.{" "}
        <button type="button" className={styles.link} onClick={reload}>
          Retry
        </button>
      </p>
    );
  } else if (totalAvailable === 0) {
    chooser = <p className={styles.muted}>No plugins available for this component type.</p>;
  } else {
    offersBrowse = true;
    chooser = (
      <button type="button" className={styles.browse} onClick={() => setLibraryOpen(true)}>
        <span className={styles.browseIcon} aria-hidden>
          <PuzzleIcon size={20} />
        </span>
        <span className={styles.browseBody}>
          <span className={styles.browseTitle}>Browse plugins</span>
          <span className={styles.browseSub}>
            Let a ready-made action handle this — no bot code needed.
          </span>
        </span>
        <span className={styles.browseEnd}>
          <span className={styles.browseCount}>{totalAvailable}</span>
          <ChevronRightIcon size={18} className={styles.browseChevron} aria-hidden />
        </span>
      </button>
    );
  }

  const sub = linkStyle
    ? "Where this link takes people."
    : target === "button"
      ? "What happens when someone clicks this button."
      : "What happens when someone uses this menu.";

  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <span className={styles.title}>Action</span>
        <span className={styles.sub}>{sub}</span>
      </div>

      {chooser}

      {/* The plugin *is* the custom_id / url. A Link button's URL editor lives in
          the ButtonInspector below, so nothing shows here for it. For an
          id-bearing component we lead with the plugin card and tuck the raw field
          behind a disclosure while the library is on offer; once attached (or
          with no library) the field shows directly. */}
      {linkStyle ? null : offersBrowse ? (
        <div className={styles.manual}>
          <button
            type="button"
            className={styles.manualToggle}
            onClick={() => setShowManualId((v) => !v)}
            aria-expanded={showManualId}
          >
            <ChevronRightIcon
              size={14}
              className={cn(styles.manualChevron, showManualId && styles.manualChevronOpen)}
              aria-hidden
            />
            <span className={styles.manualLabel}>Set the ID manually</span>
            <span className={styles.manualNote}>for your own bot</span>
          </button>
          {showManualId ? idField : null}
        </div>
      ) : (
        idField
      )}

      {libraryOpen ? (
        <PluginLibraryModal
          plugins={interactiveAvailable}
          linkPlugins={linkAvailable}
          target={target}
          onPick={(manifest, preset) => {
            setLibraryOpen(false);
            openConfig(manifest, preset);
          }}
          onPickLink={(manifest) => {
            setLibraryOpen(false);
            attachLink(manifest);
          }}
          onClose={() => setLibraryOpen(false)}
        />
      ) : null}

      {configuring ? (
        <PluginConfigModal
          key={`${configuring.manifest.id}:${configuring.customId ?? configuring.preset ?? "new"}`}
          manifest={configuring.manifest}
          target={target}
          customId={configuring.customId}
          preset={configuring.preset}
          onSave={handleSave(configuring)}
          onClose={() => setConfiguring(null)}
        />
      ) : null}

      {configuringLink && isBtn ? (
        <LinkPluginConfigModal
          key={`link:${configuringLink.manifest.id}`}
          manifest={configuringLink.manifest}
          linkUrl={linkStyle ? finishedLinkUrl(configuringLink.manifest, node.url) : undefined}
          onSave={handleLinkSave(configuringLink)}
          onClose={() => setConfiguringLink(null)}
        />
      ) : null}
    </div>
  );
}

function AttachedChip({
  manifest,
  customId,
  onReconfigure,
  onDetach,
}: {
  manifest: PluginManifest;
  customId: string | undefined;
  onReconfigure: () => void;
  onDetach: () => void;
}) {
  const cached = getPluginSummary(customId);
  const label = cached?.summary.label ?? manifest.name;
  const detail = cached?.summary.description ?? manifest.description;

  // A guild-scoped binding (Self Role et al.) carries the server it was set up
  // for. Surface that here so a wrong-server binding is caught while editing —
  // not only at the Send page, where the destination is finally chosen and the
  // hard block lives. The guild is only cached for guild-scoped plugins, so for
  // every other binding this line simply doesn't render.
  const targetGuildId = cached?.guildId;
  const authGuilds = useAuthStore((s) => s.guilds);
  // Signed out: with no session we can't resolve the id to a server name (the
  // line falls back to the raw id) and there's no connected guild to compare
  // against, so the mismatch caution below can never fire. Flag it as its own
  // caution that prompts sign-in, so a wrong-server binding still gets a second
  // look here rather than slipping through to the Send page unchecked.
  const signedOut = useAuthStore((s) => s.status) === "anon";
  // The connected guild is the closest thing the editor has to a "current
  // server": when one is connected and it differs from the binding's target,
  // the line escalates from a neutral fact to a caution. With nothing connected
  // there's no destination to judge against, so we never cry wolf — the real
  // block still happens at send time against the chosen webhook's guild.
  const connectedGuildId = useGuildStore((s) => s.guildId);

  const targetName =
    (targetGuildId && authGuilds.find((g) => g.id === targetGuildId)?.name) || targetGuildId;
  const mismatch = !!targetGuildId && connectedGuildId !== "" && connectedGuildId !== targetGuildId;
  const connectedName =
    authGuilds.find((g) => g.id === connectedGuildId)?.name ?? "a different server";
  const warn = mismatch || signedOut;

  return (
    <div className={styles.chip}>
      <PluginIcon manifest={manifest} summaryIcon={cached?.summary.icon} />
      <div className={styles.chipText}>
        <span className={styles.chipName}>{label}</span>
        {detail ? <span className={styles.chipDesc}>{detail}</span> : null}
        {targetGuildId ? (
          <span
            className={cn(styles.chipTarget, warn && styles.chipTargetWarn)}
            title={targetGuildId}
          >
            {warn ? (
              <AlertTriangleIcon size={12} className={styles.chipTargetIcon} aria-hidden />
            ) : null}
            {mismatch
              ? `Targets ${targetName} — you're connected to ${connectedName}`
              : signedOut
                ? `Targets ${targetName} — sign in to verify the server`
                : `Targets ${targetName}`}
          </span>
        ) : null}
        <span className={styles.chipMeta}>via {manifest.name}</span>
      </div>
      <div className={styles.chipActions}>
        <Button size="sm" variant="secondary" onClick={onReconfigure}>
          Reconfigure
        </Button>
        <Button size="sm" variant="ghost" onClick={onDetach}>
          Detach
        </Button>
      </div>
    </div>
  );
}

/** The attached-plugin chip for a Link button. A link plugin's per-server half
 *  lives on the external service, reached via "Set up" — and, when the manifest
 *  declares a `statusUrl`, probed live so the chip shows a real
 *  **Ready / Needs setup** state for the connected server instead of a
 *  permanent warning. A manifest `configUrl` additionally offers **Configure**
 *  (the service's own picker iframe). Mirrors the interactive
 *  {@link AttachedChip} visually. */
function LinkAttachedChip({
  manifest,
  url,
  onConfigure,
  onDetach,
}: {
  manifest: LinkPluginManifest;
  /** The button's current URL — keys the expendable per-binding summary. */
  url: string | undefined;
  /** Present when the manifest declares a config iframe. */
  onConfigure?: () => void;
  onDetach: () => void;
}) {
  const by = manifest.publisher ?? manifest.name;
  // Captured as locals so the click handlers close over a definite string (the
  // guards below already narrow them, but TS won't carry that into a callback).
  const { setupUrl, homepage } = manifest;

  // Per-binding summary a config iframe handed back on save (keyed by the URL —
  // the binding — exactly as interactive chips key by custom_id). Expendable:
  // a miss falls back to the manifest's own name/description.
  const cached = getPluginSummary(url);
  const label = cached?.summary.label ?? manifest.name;
  const detail = cached?.summary.description ?? manifest.description;

  // Live per-server setup state, resolved against the connected guild.
  // "unknown" (no probe, no connected server, probe failed) renders exactly
  // the pre-probe chip. See useLinkPluginStatus.
  const setupStatus = useLinkPluginStatus(manifest);
  const connectedGuildId = useGuildStore((s) => s.guildId);
  const authGuilds = useAuthStore((s) => s.guilds);
  const connectedName =
    authGuilds.find((g) => g.id === connectedGuildId)?.name ?? "the connected server";

  return (
    <>
      <div className={styles.chip}>
        <PluginIcon manifest={manifest} summaryIcon={cached?.summary.icon} />
        <div className={styles.chipText}>
          <span className={styles.chipName}>{label}</span>
          {detail ? <span className={styles.chipDesc}>{detail}</span> : null}
          {setupStatus !== "unknown" ? (
            <span
              className={cn(
                styles.chipTarget,
                setupStatus === "needs-setup" && styles.chipTargetWarn,
              )}
            >
              {setupStatus === "needs-setup" ? (
                <AlertTriangleIcon size={12} className={styles.chipTargetIcon} aria-hidden />
              ) : null}
              {setupStatus === "ready"
                ? `Set up for ${connectedName} — the link is live`
                : `Not set up for ${connectedName} yet — the link won't do anything`}
            </span>
          ) : null}
          <span className={styles.chipMeta}>via {by} — external link service</span>
        </div>
        <div className={styles.chipActions}>
          {onConfigure ? (
            <Button size="sm" variant="secondary" onClick={onConfigure}>
              Configure
            </Button>
          ) : null}
          {setupUrl ? (
            // `openExternalUrl`, not a raw `window.open`: inside the Activity's
            // sandboxed iframe a `window.open` is silently blocked, so the link
            // has to go through the host SDK (this panel renders on both surfaces).
            <Button
              size="sm"
              variant={onConfigure ? "ghost" : "secondary"}
              onClick={() => void openExternalUrl(setupUrl)}
            >
              Set up
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onDetach}>
            Detach
          </Button>
        </div>
      </div>
      {/* When the probe answered "ready" the stock warning would cry wolf, so it
          only shows while the per-server state is unverified or needs work. */}
      {setupUrl && setupStatus !== "ready" ? (
        <p className={styles.muted}>
          {manifest.setupHint ??
            `The link only works once your server is set up with ${by} — “Set up” takes you there.`}{" "}
          {homepage ? (
            <a
              className={styles.link}
              href={homepage}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                // Keep the real anchor for the web app (right-click, a11y), but in
                // the Activity a target="_blank" navigation is blocked — intercept
                // and hand the URL to the Discord client instead.
                if (isActivityMode()) {
                  e.preventDefault();
                  void openExternalUrl(homepage);
                }
              }}
            >
              Learn more
            </a>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
