/**
 * Reusable emoji editor for the two things Discord lets carry a `PartialEmoji`:
 * a **button** and a **string-select option**. Both store the same
 * `{ id?, name?, animated? }` shape, so the token parsing, the cross-server
 * picker, and the raw id/animated controls (behind a collapsed disclosure)
 * are identical — this is the one place that knows how to edit one.
 *
 * Discord's `PartialEmoji` covers two distinct cases:
 *  - Unicode emoji (🔥): `{ name: "🔥" }` — no id. The glyph lives in `name`.
 *  - Custom guild emoji: `{ id: "<snowflake>", name: "<alias>", animated?: bool }`.
 *
 * The text input takes a raw unicode glyph or a pasted Discord token
 * (`<:name:id>` / `<a:name:id>`) — most users grab those from the client by
 * escaping a message. The trailing button opens the same cross-server
 * {@link GuildEmojiPanel} the markdown toolbar uses; its chosen token is parsed
 * straight back into the `PartialEmoji` shape.
 */

import type { PartialEmoji } from "@/core/schema/types";
import { Disclosure } from "@/ui/Disclosure";
import { Field } from "@/ui/Field";
import { Menu } from "@/ui/Menu";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import { EmojiIcon } from "@/ui/Icon";
import { GuildEmojiPanel } from "@/features/guild/MentionPicker";
import styles from "./EmojiField.module.css";

interface Props {
  emoji: PartialEmoji | undefined;
  /** Called with the cleaned emoji, or `undefined` when it's been emptied. */
  onChange: (emoji: PartialEmoji | undefined) => void;
}

export function EmojiField({ emoji: current, onChange }: Props) {
  const emoji = current ?? {};

  // Normalise on every edit: drop empty fields, omit `animated` unless set, and
  // collapse a fully-empty emoji to `undefined` so the wire payload stays clean.
  const setEmoji = (next: PartialEmoji | undefined) => {
    const cleaned =
      next && (next.name || next.id)
        ? {
            ...(next.id ? { id: next.id } : {}),
            ...(next.name ? { name: next.name } : {}),
            ...(next.animated ? { animated: true } : {}),
          }
        : undefined;
    onChange(cleaned);
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
            Paste a unicode emoji (🔥) or a custom token like <code>{"<:name:123…>"}</code>.
          </>
        }
      >
        {(id) => (
          <div className={styles.emojiRow}>
            <TextInput
              id={id}
              className={styles.emojiInput}
              value={emoji.name ?? ""}
              onChange={(e) => onNameChange(e.currentTarget.value)}
              placeholder="🔥  ·  thinking  ·  <a:wave:123…>"
            />
            <Menu
              align="end"
              trigger={
                <button
                  type="button"
                  className={styles.pickBtn}
                  aria-label="Pick a custom emoji"
                  title="Pick a custom emoji"
                >
                  <EmojiIcon size={16} />
                </button>
              }
            >
              {(close) => (
                <GuildEmojiPanel
                  onPick={(snippet) => {
                    const parsed = parseDiscordEmojiToken(snippet);
                    if (parsed) setEmoji(parsed);
                    close();
                  }}
                />
              )}
            </Menu>
          </div>
        )}
      </Field>
      <Disclosure label="Advanced emoji options">
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
      </Disclosure>
    </>
  );
}

/**
 * Turn a raw emoji string — a unicode glyph (`🔥`) or a Discord custom token
 * (`<:name:id>`) — into a {@link PartialEmoji}, or `undefined` when empty. The
 * one-shot converter used when something other than the editor supplies an
 * emoji (e.g. a plugin's `defaultEmoji` stamped onto a button on attach).
 */
export function emojiFromString(raw: string | undefined): PartialEmoji | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return parseDiscordEmojiToken(trimmed) ?? { name: trimmed };
}

/** Parse `<:name:id>` / `<a:name:id>` into a PartialEmoji. Returns null when not a token. */
export function parseDiscordEmojiToken(raw: string): PartialEmoji | null {
  const m = /^<(a)?:([\w~]+):(\d{15,25})>$/.exec(raw.trim());
  if (!m) return null;
  return {
    id: m[3]!,
    name: m[2]!,
    ...(m[1] ? { animated: true } : {}),
  };
}
