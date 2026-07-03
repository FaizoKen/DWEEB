/**
 * Button inspector.
 *
 * Switching styles is a structural change (Link buttons need `url`, others
 * need `custom_id`, Premium needs `sku_id`) so we go through `replaceNode`
 * instead of `patchNode` — otherwise stale fields from the previous style
 * would leak into the exported payload.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { useUiPrefs } from "@/core/state/uiPrefs";
import { LIMITS } from "@/core/schema/limits";
import { LINK_PLUGINS } from "@/core/plugins/registry";
import { matchLinkPlugin } from "@/core/plugins/linkManifest";
import {
  ButtonStyle,
  ComponentType,
  type ButtonComponent,
  type ButtonStyleValue,
  type InteractiveButtonComponent,
  type LinkButtonComponent,
  type PremiumButtonComponent,
} from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import { PlaceholderInput } from "@/ui/PlaceholderInput";
import { useMessagePlaceholders } from "@/features/builder/useMessagePlaceholders";
import { CapabilityNote } from "./CapabilityNote";
import { EmojiField } from "./EmojiField";

interface Props {
  node: ButtonComponent;
}

const STYLE_OPTIONS: Array<{ value: ButtonStyleValue; label: string }> = [
  { value: ButtonStyle.Primary, label: "Primary (blurple)" },
  { value: ButtonStyle.Secondary, label: "Secondary (grey)" },
  { value: ButtonStyle.Success, label: "Success (green)" },
  { value: ButtonStyle.Danger, label: "Danger (red)" },
  { value: ButtonStyle.Link, label: "Link" },
  { value: ButtonStyle.Premium, label: "Premium" },
];

export function ButtonInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const replace = useMessageStore((s) => s.replaceNode);
  const advancedMode = useUiPrefs((s) => s.advancedMode);
  const placeholders = useMessagePlaceholders();
  // The link plugin owning this button's URL (by template-prefix match), if
  // any — recomputed from the URL alone, same as custom_id plugin bindings.
  const linkPlugin =
    node.style === ButtonStyle.Link ? matchLinkPlugin(LINK_PLUGINS, node.url) : null;

  const changeStyle = (next: ButtonStyleValue) => {
    if (next === node.style) return;
    if (next === ButtonStyle.Link) {
      replace<LinkButtonComponent>(node._id, makeLink(node));
    } else if (next === ButtonStyle.Premium) {
      replace<PremiumButtonComponent>(node._id, makePremium(node));
    } else {
      replace<InteractiveButtonComponent>(node._id, makeInteractive(node, next));
    }
  };

  return (
    <>
      {/* The interactive-button capability notice now lives above the Action
          panel the Inspector renders ahead of these fields. The Premium note
          stays here — a Premium button isn't a plugin target, so it has no
          Action panel to hang under. */}
      {node.style === ButtonStyle.Premium ? (
        <CapabilityNote>
          <strong>Needs app monetization.</strong> A Premium button only works if the owning app has
          a product set up — otherwise it can't charge anyone.
        </CapabilityNote>
      ) : null}
      <Field label="Style">
        {(id) => (
          <Select
            id={id}
            value={String(node.style)}
            onChange={(e) => changeStyle(Number(e.currentTarget.value) as ButtonStyleValue)}
          >
            {STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {node.style !== ButtonStyle.Premium ? (
        <Field label="Label" hint={`Max ${LIMITS.BUTTON_LABEL} characters.`}>
          {(id) => (
            <PlaceholderInput
              id={id}
              maxLength={LIMITS.BUTTON_LABEL}
              value={"label" in node ? (node.label ?? "") : ""}
              placeholders={placeholders}
              onChange={(value) =>
                patch<LinkButtonComponent>(node._id, {
                  label: value || undefined,
                })
              }
            />
          )}
        </Field>
      ) : null}

      {node.style === ButtonStyle.Link ? (
        // The URL *is* the plugin binding, but unlike a plugin-owned custom_id
        // it's human-meaningful and the attachment above is recomputed from it
        // live — so the field stays freely editable and the plugin *follows*
        // the URL. Paste a finished link and the matching chip (and its param
        // fields) light up by themselves; edit away from the template and the
        // chip detaches; paste another plugin's URL and the chip swaps.
        <Field
          label="URL"
          hint={
            linkPlugin ? (
              <>
                Linked to <strong>{linkPlugin.name}</strong> — the plugin follows this URL: paste
                your finished link or edit freely. Placeholders fill in when the message is sent.
              </>
            ) : (
              "Must be https:// (or a placeholder that resolves to one)."
            )
          }
        >
          {(id) => (
            <PlaceholderInput
              id={id}
              type="url"
              maxLength={LIMITS.BUTTON_URL}
              value={node.url}
              placeholders={placeholders}
              onChange={(value) => patch<LinkButtonComponent>(node._id, { url: value })}
            />
          )}
        </Field>
      ) : null}

      {node.style === ButtonStyle.Premium ? (
        <Field label="SKU ID" hint="Discord SKU snowflake.">
          {(id) => (
            <TextInput
              id={id}
              value={node.sku_id}
              onChange={(e) =>
                patch<PremiumButtonComponent>(node._id, {
                  sku_id: e.currentTarget.value,
                })
              }
            />
          )}
        </Field>
      ) : null}

      {node.style !== ButtonStyle.Premium ? (
        <EmojiField
          emoji={node.emoji}
          advancedMode={advancedMode}
          onChange={(emoji) => patch<EmojiEditableButton>(node._id, { emoji })}
        />
      ) : null}

      <Switch
        checked={node.disabled ?? false}
        onChange={(e) =>
          patch<LinkButtonComponent>(node._id, {
            disabled: e.currentTarget.checked || undefined,
          })
        }
        label="Disabled"
      />
      {/* The interaction's custom_id lives in the Action panel the Inspector
          renders above these fields — it's bound to (or freed from) a plugin
          there, so the two halves of that one decision stay together. */}
    </>
  );
}

function makeLink(prev: ButtonComponent): Omit<LinkButtonComponent, "_id"> {
  return {
    type: ComponentType.Button,
    style: ButtonStyle.Link,
    label: "label" in prev ? prev.label : "Open link",
    url: "url" in prev ? prev.url : "https://discord.com",
    disabled: prev.disabled,
    emoji: "emoji" in prev ? prev.emoji : undefined,
  };
}

function makePremium(prev: ButtonComponent): Omit<PremiumButtonComponent, "_id"> {
  return {
    type: ComponentType.Button,
    style: ButtonStyle.Premium,
    sku_id: "sku_id" in prev ? prev.sku_id : "",
    disabled: prev.disabled,
  };
}

function makeInteractive(
  prev: ButtonComponent,
  style: Exclude<ButtonStyleValue, typeof ButtonStyle.Link | typeof ButtonStyle.Premium>,
): Omit<InteractiveButtonComponent, "_id"> {
  return {
    type: ComponentType.Button,
    style,
    label: "label" in prev ? prev.label : "Click me",
    custom_id: "custom_id" in prev ? prev.custom_id : "btn_action",
    disabled: prev.disabled,
    emoji: "emoji" in prev ? prev.emoji : undefined,
  };
}

/** The button variants that carry an emoji (everything but Premium). */
type EmojiEditableButton = LinkButtonComponent | InteractiveButtonComponent;
