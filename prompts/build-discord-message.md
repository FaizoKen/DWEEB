# AI Prompt — generate a Discord Webhook Builder payload

A self-contained prompt you paste into any chat AI (ChatGPT, Claude, Gemini,
etc.). Tweak the **"What I want"** block at the bottom, send it, and the AI
returns a JSON payload you can drop straight into the Builder.

## How to use the AI's output

The AI returns one JSON object — that's the "URL data" (the Components V2
wire payload that gets compressed into a `#s=…` share link).

1. Open the Discord Webhook Builder.
2. Click **Share** → **Import** tab.
3. Paste the JSON the AI gave you and click **Replace message**.
4. Switch back to the **Share** tab to copy the share URL, or **Send** it to a
   webhook.

> Why not a ready-made URL? The share link is LZ-String compressed and no
> LLM does that arithmetic reliably. JSON is the canonical wire format the
> Builder accepts in the Import panel — it's the same payload, one step
> earlier in the pipeline.

---

## The prompt (copy everything below this line)

```
You are generating a Discord webhook message in the Components V2 wire format
for the open-source Discord Webhook Builder. Output ONE JSON object and
NOTHING ELSE — no prose, no markdown fence, no commentary. The JSON must be
directly parseable by `JSON.parse`.

# Top-level shape

{
  "username":     string?       // ≤ 80 chars, optional webhook display name
  "avatar_url":   string?       // ≤ 2048 chars https URL, optional
  "tts":          boolean?      // optional, default false
  "thread_name":  string?       // ≤ 100 chars, forum/media channels only
  "applied_tags": string[]?     // ≤ 5 forum-tag snowflakes
  "allowed_mentions": {
    "parse":  ("roles" | "users" | "everyone")[]?,
    "roles":  string[]?,        // snowflakes
    "users":  string[]?,        // snowflakes
    "replied_user": boolean?
  }?,
  "components": TopLevel[]      // REQUIRED, 1–10 entries, order = render order
}

Do NOT emit `content`, `embeds`, `poll`, `stickers`, `sticker_ids`, `flags`,
or `message_reference`. Components V2 forbids them. All visible message text
lives inside TextDisplay components.

# Component types (each object has a numeric `type` discriminator)

Top-level allowed: Container(17), ActionRow(1), Section(9), TextDisplay(10),
                   MediaGallery(12), Separator(14), File(13).

Container children allowed: ActionRow, TextDisplay, Section, MediaGallery,
                            Separator, File. NO nested Container.

Component shapes:

  TextDisplay (10)
    { "type": 10, "content": string }              // ≤ 4000 chars, markdown OK

  Separator (14)
    { "type": 14, "divider"?: boolean, "spacing"?: 1 | 2 }   // 1=small 2=large

  Section (9)  — 1–3 TextDisplay children + one accessory
    { "type": 9,
      "components": [TextDisplay, ...],            // 1–3 items
      "accessory":  Button | Thumbnail }

  Thumbnail (11)  — only valid as a Section accessory
    { "type": 11,
      "media":       { "url": string },            // https://… or attachment://name
      "description"?: string,                      // ≤ 1024 chars
      "spoiler"?:     boolean }

  MediaGallery (12)  — 1–10 items
    { "type": 12,
      "items": [
        { "media": { "url": string },
          "description"?: string,                  // ≤ 1024 chars
          "spoiler"?: boolean }
      ] }

  File (13)
    { "type": 13,
      "file": { "url": "attachment://filename.ext" },   // must reference an upload
      "spoiler"?: boolean }

  ActionRow (1)  — EITHER up to 5 Buttons OR exactly one Select (never mixed)
    { "type": 1, "components": Button[] | [Select] }

  Button (2) — pick ONE of the three variants:
    Link:        { "type": 2, "style": 5, "label"?: string, "emoji"?: PartialEmoji, "url": string,    "disabled"?: boolean }
    Premium:     { "type": 2, "style": 6, "sku_id": string, "disabled"?: boolean }
    Interactive: { "type": 2, "style": 1|2|3|4, "label"?: string, "emoji"?: PartialEmoji, "custom_id": string, "disabled"?: boolean }
      // style 1=Primary(blurple) 2=Secondary(grey) 3=Success(green) 4=Danger(red)
      // label ≤ 80, custom_id ≤ 100, url ≤ 512.
      // Interactive buttons only fire if the webhook owner is a bot/app.

  PartialEmoji
    { "id"?: string|null, "name"?: string|null, "animated"?: boolean }
      // For unicode emoji set `name` to the literal character.
      // For custom emoji set `id` to the snowflake and `name` to its handle.

  Selects (interactive — only a bot/app receives the response):
    StringSelect (3):
      { "type": 3, "custom_id": string,
        "options": [{ "label": string, "value": string,
                      "description"?: string, "emoji"?: PartialEmoji,
                      "default"?: boolean }],     // 1–25 options
        "placeholder"?: string, "min_values"?: number, "max_values"?: number,
        "disabled"?: boolean }
    UserSelect (5)        — adds optional `default_values: [{id, type:"user"}]`
    RoleSelect (6)        — adds optional `default_values: [{id, type:"role"}]`
    MentionableSelect (7) — `default_values` of user|role entries
    ChannelSelect (8)     — adds optional `channel_types: number[]` and
                            `default_values: [{id, type:"channel"}]`

  Container (17)
    { "type": 17,
      "accent_color"?: number | null,              // 0xRRGGBB integer, or null
      "spoiler"?: boolean,
      "components": ContainerChild[] }             // ≤ 10 entries

# Hard limits (the Builder validates against these — exceeding them = invalid)

- TOTAL components in message (nested counted): 40
- Top-level components: 10
- Container children: 10
- Section TextDisplays: 1–3
- MediaGallery items: 10
- ActionRow buttons: 5
- Combined character cap across every text field: 4000
- TextDisplay content: 4000
- Button label: 80, custom_id: 100, url: 512
- Select custom_id: 100, placeholder: 150, options: 25
- Webhook username: 80, avatar URL: 2048
- Snowflake IDs: numeric strings, ≤ 25 chars

# Markdown inside TextDisplay

Standard Discord markdown works: **bold**, *italic*, __underline__, ~~strike~~,
`inline code`, ``` fenced blocks ```, > quotes, `# / ## / ###` headings,
`- ` lists, `[label](https://url)` links, `<@123>` user / `<@&123>` role /
`<#123>` channel mentions, `<t:1700000000:R>` timestamps, custom emoji
`<:name:123>` / animated `<a:name:123>`. Discord-only: `-# subtext` prefix
for muted small text.

# Style rules for the output

- Output JSON only. No code fence, no explanation, no trailing text.
- Do not invent component types or fields that are not listed above.
- Do not include any `id` field, any `_id` field, or any field set to `null`
  unless explicitly described above (`accent_color` and `allowed_mentions`
  fields may be null).
- Prefer one Container with a meaningful `accent_color` when the message has
  a clear theme (announcement, success, warning, error). Use plain top-level
  TextDisplay/Section for short or stylistically flat messages.
- Keep image URLs to https://. If you have no real image to reference, omit
  the gallery/thumbnail rather than inventing one.
- Mentions in TextDisplay only ping if `allowed_mentions` whitelists them.
  If the message includes `@everyone` / role / user mentions that should
  resolve to real pings, set `allowed_mentions` accordingly; otherwise omit
  it so mentions render inert.

# Minimal example (a banner + two buttons inside one accented container)

{
  "username": "Release Bot",
  "components": [
    {
      "type": 17,
      "accent_color": 5793266,
      "components": [
        { "type": 10, "content": "# 🚀 v1.4.0 is live\nChangelog below." },
        { "type": 14, "divider": true, "spacing": 1 },
        { "type": 10, "content": "- Faster cold start\n- Dark-mode polish\n- Bug fixes" },
        { "type": 1, "components": [
          { "type": 2, "style": 5, "label": "Release notes", "url": "https://example.com/releases/1.4.0" },
          { "type": 2, "style": 5, "label": "Report an issue", "url": "https://example.com/issues/new" }
        ]}
      ]
    }
  ]
}

# What I want

<!-- EDIT THIS BLOCK BEFORE SENDING THE PROMPT TO THE AI -->

Purpose / theme: <e.g. "release announcement for v2.0 of my OSS project">
Tone:            <e.g. "celebratory but technical">
Username:        <e.g. "Release Bot", or leave blank to omit>
Accent color:    <e.g. "blurple #5865F2", or "no accent">
Must include:
  - <e.g. "a heading with the version number">
  - <e.g. "a 3–5 bullet changelog">
  - <e.g. "two link buttons: 'Release notes' → URL, 'Report bug' → URL">
Must NOT include:
  - <e.g. "no images, no mentions">
Image URLs (if any): <paste real https URLs, or write "none">

Now return the JSON for that message and nothing else.
```
