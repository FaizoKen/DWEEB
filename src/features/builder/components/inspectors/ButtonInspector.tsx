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
  type PremiumButtonComponent,
} from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";

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

  return (
    <>
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
  };
}
