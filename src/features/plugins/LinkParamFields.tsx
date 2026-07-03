/**
 * Inputs for a link plugin's user params (`manifest.params`) — the per-button
 * values only the admin knows (a form id, a page slug), which the core tokens
 * can't supply. Shared by the inspector's Action panel and the guided
 * template-setup checklist so "finish the button's link" looks the same in
 * both places.
 *
 * The values live nowhere but the button URL itself: each keystroke re-writes
 * the URL from the manifest template (`writeLinkParams`), and the shown value
 * is read back out of the live URL (`readLinkParams`) — so a reloaded draft or
 * share link round-trips with zero extra state, exactly like the binding.
 * A `pattern` mismatch shows inline as a nudge; the hard gate on an *unfilled*
 * param is the message validator's, not this component's.
 */

import {
  readLinkParams,
  writeLinkParams,
  isValidLinkParamValue,
} from "@/core/plugins/linkManifest";
import type { LinkPluginManifest } from "@/core/plugins/linkManifest";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";

interface Props {
  manifest: LinkPluginManifest;
  /** The bound button's current URL — the single source the values render from. */
  url: string;
  /** Receives the re-written URL on every edit (goes straight to `patchNode`). */
  onWrite: (url: string) => void;
}

export function LinkParamFields({ manifest, url, onWrite }: Props) {
  const params = manifest.params;
  if (!params?.length) return null;
  const values = readLinkParams(manifest, url);
  return (
    <>
      {params.map((param) => {
        const value = values[param.token] ?? "";
        // Judge the trimmed value, like the validator: a not-yet-blurred
        // trailing space shouldn't flash the error mid-word.
        const invalid = !isValidLinkParamValue(param, value.trim());
        return (
          <Field
            key={param.token}
            label={param.label}
            hint={param.hint}
            error={invalid ? `This doesn't look like a valid ${param.label}.` : null}
          >
            {(id) => (
              <TextInput
                id={id}
                value={value}
                placeholder={param.placeholder}
                invalid={invalid}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) =>
                  onWrite(
                    writeLinkParams(manifest, { ...values, [param.token]: e.currentTarget.value }),
                  )
                }
                // Values splice in exactly as typed (trimming per keystroke
                // would eat interior spaces mid-word), so square away any
                // accidental padding once the field is left.
                onBlur={() =>
                  onWrite(writeLinkParams(manifest, { ...values, [param.token]: value.trim() }))
                }
              />
            )}
          </Field>
        );
      })}
    </>
  );
}
