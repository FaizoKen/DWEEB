/**
 * Managed fields — component fields a plugin may own (lock + set), beyond the
 * always-locked `custom_id` and the string-select option list
 * (`managesSelectOptions`).
 *
 * Some plugins only work when a component is configured a certain way — a menu
 * that grants exactly one role needs `min_values`/`max_values` pinned to 1, say.
 * Left editable, the dashboard lets a user widen that and silently break the
 * plugin. So a plugin declares the fields it owns in its manifest
 * (`managesFields`), hands back their values on `save`, and DWEEB writes them
 * onto the component and **locks** them in the inspector — exactly as it already
 * does for the plugin-owned `custom_id` and wired select options.
 *
 * The locked-field *names* must live in the manifest (static) because, on reload
 * of a draft or share link, DWEEB recomputes the attachment purely from the
 * `custom_id` prefix and the save payload is long gone. The *values* ride the
 * `save` message (dynamic: a menu's `max_values` may equal its role count), and
 * are clamped here against Discord's limits before they ever touch a component.
 *
 * Only behaviour-critical select fields are lockable today; cosmetic fields
 * (placeholder is editable unless claimed, button label/colour/emoji) stay the
 * user's. The set is intentionally small and easy to extend — add a name here,
 * a clamp in {@link sanitizeManagedFields}, and a locked branch in the relevant
 * inspector.
 */

import { LIMITS } from "@/core/schema/limits";

/** The component fields a plugin may declare it owns, in `managesFields`. */
export const MANAGED_FIELDS = ["min_values", "max_values", "placeholder", "disabled"] as const;

export type ManagedField = (typeof MANAGED_FIELDS)[number];

const MANAGED_FIELD_SET: ReadonlySet<string> = new Set(MANAGED_FIELDS);

/** Human label for a managed field, for the "Set by X" inspector notes. */
export const MANAGED_FIELD_LABELS: Record<ManagedField, string> = {
  min_values: "Min selections",
  max_values: "Max selections",
  placeholder: "Placeholder",
  disabled: "Disabled",
};

export function isManagedField(v: unknown): v is ManagedField {
  return typeof v === "string" && MANAGED_FIELD_SET.has(v);
}

/**
 * Parse a manifest's declared `managesFields`, dropping unknown names and
 * duplicates. Returns `undefined` when nothing usable survives so the manifest
 * stays free of an empty array — mirrors the validate-and-drop parse style.
 */
export function parseManagedFields(raw: unknown): ManagedField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ManagedField[] = [];
  for (const v of raw) if (isManagedField(v) && !out.includes(v)) out.push(v);
  return out.length ? out : undefined;
}

/** The values a plugin hands back for the fields it owns. */
export interface ManagedFieldValues {
  min_values?: number;
  max_values?: number;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Validate + clamp the plugin-supplied field values before they're written onto
 * a component. Only fields the plugin actually declared in its manifest
 * (`allowed`) are accepted — a plugin can't quietly seize a field it never said
 * it owns — and each survivor is clamped to Discord's limits. Returns
 * `undefined` when nothing usable survives, so callers treat "no managed values"
 * uniformly. Never trusts the shape the iframe sent, like every inbound field.
 */
export function sanitizeManagedFields(
  raw: unknown,
  allowed: ManagedField[] | undefined,
): ManagedFieldValues | undefined {
  if (!allowed?.length || !raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const allow = new Set(allowed);
  const out: ManagedFieldValues = {};

  if (allow.has("min_values")) {
    const v = clampInt(o.min_values, LIMITS.SELECT_MIN_VALUES, LIMITS.SELECT_MAX_VALUES);
    if (v !== undefined) out.min_values = v;
  }
  if (allow.has("max_values")) {
    const v = clampInt(o.max_values, 1, LIMITS.SELECT_MAX_VALUES);
    if (v !== undefined) out.max_values = v;
  }
  if (allow.has("placeholder") && typeof o.placeholder === "string") {
    out.placeholder = o.placeholder.slice(0, LIMITS.SELECT_PLACEHOLDER);
  }
  if (allow.has("disabled") && typeof o.disabled === "boolean") {
    out.disabled = o.disabled;
  }

  return Object.keys(out).length ? out : undefined;
}

function clampInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(min, Math.min(max, Math.round(v)));
}
