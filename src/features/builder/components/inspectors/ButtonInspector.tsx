/**
 * Button inspector.
 *
 * Switching styles is a structural change (Link buttons need `url`, others
 * need `custom_id`, Premium needs `sku_id`) so we go through `replaceNode`
 * instead of `patchNode` — otherwise stale fields from the previous style
 * would leak into the exported payload.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import {
  ButtonStyle,
  ComponentType,
  type ButtonComponent,
  type ButtonStyleValue,
  type InteractiveButtonComponent,
  type LinkButtonComponent,
  type PartialEmoji,
  type PremiumButtonComponent,
} from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import { CapabilityNote } from "./CapabilityNote";

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

  const isInteractive =
    node.style !== ButtonStyle.Link && node.style !== ButtonStyle.Premium;

  return (
    <>
      {isInteractive ? (
        <CapabilityNote>
          <strong>Needs an application-owned webhook.</strong> Discord rejects
          messages with interactive buttons when sent through a regular
          user-created webhook. Use a Link button if you just want a hyperlink.
        </CapabilityNote>
      ) : null}
      {node.style === ButtonStyle.Premium ? (
        <CapabilityNote>
          <strong>Needs app monetization.</strong> Premium buttons require the
          webhook's application to have a configured SKU; without that, the
          button can't actually charge anyone.
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
            <TextInput
              id={id}
              maxLength={LIMITS.BUTTON_LABEL}
              value={"label" in node ? node.label ?? "" : ""}
              onChange={(e) =>
                patch<LinkButtonComponent>(node._id, {
                  label: e.currentTarget.value || undefined,
                })
              }
            />
          )}
        </Field>
      ) : null}

      {node.style === ButtonStyle.Link ? (
        <Field label="URL" hint="Must be https://.">
          {(id) => (
            <TextInput
              id={id}
              type="url"
              maxLength={LIMITS.BUTTON_URL}
              value={node.url}
              onChange={(e) =>
                patch<LinkButtonComponent>(node._id, { url: e.currentTarget.value })
              }
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

      {node.style !== ButtonStyle.Link && node.style !== ButtonStyle.Premium ? (
        <Field
          label="custom_id"
          hint="Your bot receives this when the button is clicked."
        >
          {(id) => (
            <TextInput
              id={id}
              maxLength={LIMITS.BUTTON_CUSTOM_ID}
              value={node.custom_id}
              onChange={(e) =>
                patch<InteractiveButtonComponent>(node._id, {
                  custom_id: e.currentTarget.value,
                })
              }
            />
          )}
        </Field>
      ) : null}

      {node.style !== ButtonStyle.Premium ? <EmojiEditor node={node} /> : null}

      <Switch
        checked={node.disabled ?? false}
        onChange={(e) =>
          patch<LinkButtonComponent>(node._id, {
            disabled: e.currentTarget.checked || undefined,
          })
        }
        label="Disabled"
      />
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

/**
 * Emoji editor for Link/Interactive buttons.
 *
 * Discord's `PartialEmoji` shape covers two distinct cases:
 *  - Unicode emoji (🔥): `{ name: "🔥" }` — no id.
 *  - Custom guild emoji: `{ id: "<snowflake>", name: "<alias>", animated?: bool }`.
 *
 * We expose three controls (unicode/name + id + animated) and accept a paste
 * of the raw Discord token (`<:name:id>` / `<a:name:id>`) as a shortcut — most
 * users grab those from the client by escaping a message.
 */
type EmojiEditableButton = LinkButtonComponent | InteractiveButtonComponent;

function EmojiEditor({ node }: { node: EmojiEditableButton }) {
  const patch = useMessageStore((s) => s.patchNode);
  const emoji = node.emoji ?? {};

  const setEmoji = (next: PartialEmoji | undefined) => {
    const cleaned =
      next && (next.name || next.id)
        ? {
            ...(next.id ? { id: next.id } : {}),
            ...(next.name ? { name: next.name } : {}),
            ...(next.animated ? { animated: true } : {}),
          }
        : undefined;
    patch<EmojiEditableButton>(node._id, { emoji: cleaned });
  };

  const onNameChange = (raw: string) => {
    const parsed = parseDiscordEmojiToken(raw);
    if (parsed) {
      setEmoji(parsed);
      return;
    }
    setEmoji({ ...emoji, name: raw || undefined });
  };

  return (
    <>
      <Field
        label="Emoji"
        hint={
          <>
            Paste a unicode emoji (🔥) or a custom token like{" "}
            <code>{"<:name:123…>"}</code>.
          </>
        }
      >
        {(id) => (
          <TextInput
            id={id}
            value={emoji.name ?? ""}
            onChange={(e) => onNameChange(e.currentTarget.value)}
            placeholder="🔥  ·  thinking  ·  <a:wave:123…>"
          />
        )}
      </Field>
      <Field label="Custom emoji ID" hint="Required for guild emoji; leave blank for unicode.">
        {(id) => (
          <TextInput
            id={id}
            value={emoji.id ?? ""}
            inputMode="numeric"
            onChange={(e) =>
              setEmoji({ ...emoji, id: e.currentTarget.value.replace(/[^\d]/g, "") || undefined })
            }
            placeholder="e.g. 1185234567890123456"
          />
        )}
      </Field>
      {emoji.id ? (
        <Switch
          checked={emoji.animated ?? false}
          onChange={(e) => setEmoji({ ...emoji, animated: e.currentTarget.checked || undefined })}
          label="Animated (GIF)"
        />
      ) : null}
    </>
  );
}

/** Parse `<:name:id>` / `<a:name:id>` into a PartialEmoji. Returns null when not a token. */
function parseDiscordEmojiToken(raw: string): PartialEmoji | null {
  const m = /^<(a)?:([\w~]+):(\d{15,25})>$/.exec(raw.trim());
  if (!m) return null;
  return {
    id: m[3]!,
    name: m[2]!,
    ...(m[1] ? { animated: true } : {}),
  };
}
