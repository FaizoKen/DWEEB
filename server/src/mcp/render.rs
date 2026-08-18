//! Text rendering of a Components V2 message.
//!
//! A model building a Discord message is working blind: it emits JSON and never
//! sees what lands in the channel. The JSON is a poor substitute, because
//! nesting, ordering, and the button/select split are exactly what it gets
//! wrong and exactly what a flat object literal hides.
//!
//! So this re-states the payload as the structure a reader sees: one line per
//! component, indented by nesting, with text, media, and each button's target
//! inline. Not a pixel preview — that is the web app's job, and
//! `create_share_link` is how a person gets to it.

use serde_json::Value;

use super::components::{button_style, component_type as ct};

/// Longest run of message text reproduced before it is elided. One text block
/// may legally hold the whole 4000-character budget; the outline exists to show
/// shape, and the caller already has the exact text.
const MAX_TEXT: usize = 600;

pub fn outline(message: &Value) -> String {
    let mut lines = header(message);
    lines.push(String::new());
    let components = message
        .get("components")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if components.is_empty() {
        lines.push("(no components — Discord rejects an empty Components V2 message)".into());
        return lines.join("\n");
    }
    for node in components {
        render_node(node, 0, &mut lines);
    }
    lines.join("\n")
}

fn header(message: &Value) -> Vec<String> {
    let top = message
        .get("components")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let total = super::components::count_components(message);
    let chars = super::components::count_characters(message);
    let mut lines = vec![format!(
        "Message · {top} top-level · {total} components total · {chars} characters"
    )];
    if let Some(v) = string(message, "username") {
        lines.push(format!("Posts as: {}", quote(v)));
    }
    if let Some(v) = string(message, "avatar_url") {
        lines.push(format!("Avatar: {v}"));
    }
    if let Some(v) = string(message, "thread_name") {
        lines.push(format!("Forum post title: {}", quote(v)));
    }
    let tags: Vec<&str> = array(message, "applied_tags")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if !tags.is_empty() {
        lines.push(format!("Forum tags: {}", tags.join(", ")));
    }
    let flags = message.get("flags").and_then(Value::as_u64).unwrap_or(0);
    if flags & super::components::FLAG_SUPPRESS_NOTIFICATIONS != 0 {
        lines.push("Silent send: notifications suppressed".into());
    }
    if message.get("tts").and_then(Value::as_bool) == Some(true) {
        lines.push("TTS: set (ignored — Components V2 has no plain content to read)".into());
    }
    lines
}

fn render_node(node: &Value, depth: usize, out: &mut Vec<String>) {
    let pad = "  ".repeat(depth);
    let body = "  ".repeat(depth + 1);
    let kind = node.get("type").and_then(Value::as_u64).unwrap_or(0);
    let head = format!("{pad}{} {}", glyph(kind), label(kind));

    match kind {
        ct::TEXT_DISPLAY => {
            out.push(head);
            out.extend(text_block(string(node, "content").unwrap_or(""), &body));
        }
        ct::CONTAINER => {
            let mut flags = vec![accent(node)];
            if node.get("spoiler").and_then(Value::as_bool) == Some(true) {
                flags.push("spoiler".into());
            }
            out.push(format!("{head} — {}", flags.join(", ")));
            for child in array(node, "components") {
                render_node(child, depth + 1, out);
            }
        }
        ct::SECTION => {
            out.push(head);
            for child in array(node, "components") {
                render_node(child, depth + 1, out);
            }
            match node.get("accessory").filter(|v| v.is_object()) {
                Some(accessory) => {
                    out.push(format!("{body}accessory:"));
                    render_node(accessory, depth + 2, out);
                }
                None => out.push(format!("{body}accessory: (missing — Discord requires one)")),
            }
        }
        ct::ACTION_ROW => {
            let children = array(node, "components");
            out.push(format!(
                "{head} — {} item{}",
                children.len(),
                if children.len() == 1 { "" } else { "s" }
            ));
            for child in children {
                render_node(child, depth + 1, out);
            }
        }
        ct::BUTTON => out.push(format!("{pad}{} {}", glyph(kind), describe_button(node))),
        ct::STRING_SELECT
        | ct::USER_SELECT
        | ct::ROLE_SELECT
        | ct::MENTIONABLE_SELECT
        | ct::CHANNEL_SELECT => {
            out.push(format!("{head} — {}", describe_select(node, kind)));
            if kind == ct::STRING_SELECT {
                let options = array(node, "options");
                for (i, option) in options.iter().enumerate() {
                    let mut bits = vec![
                        format!(
                            "{}{}",
                            emoji_prefix(option.get("emoji")),
                            string(option, "label").unwrap_or("(no label)")
                        ),
                        format!("value {}", quote(string(option, "value").unwrap_or(""))),
                    ];
                    if let Some(d) = string(option, "description") {
                        bits.push(quote(d));
                    }
                    if option.get("default").and_then(Value::as_bool) == Some(true) {
                        bits.push("selected by default".into());
                    }
                    out.push(format!("{body}{}. {}", i + 1, bits.join(" · ")));
                }
                if options.is_empty() {
                    out.push(format!("{body}(no options — Discord requires 1–25)"));
                }
            }
        }
        ct::MEDIA_GALLERY => {
            let items = array(node, "items");
            out.push(format!(
                "{head} — {} item{}",
                items.len(),
                if items.len() == 1 { "" } else { "s" }
            ));
            for (i, item) in items.iter().enumerate() {
                let mut bits = vec![media_of(item.get("media"))];
                if let Some(d) = string(item, "description") {
                    bits.push(format!("alt {}", quote(d)));
                }
                if item.get("spoiler").and_then(Value::as_bool) == Some(true) {
                    bits.push("spoiler".into());
                }
                out.push(format!("{body}{}. {}", i + 1, bits.join(" · ")));
            }
        }
        ct::THUMBNAIL => {
            let mut bits = vec![media_of(node.get("media"))];
            if let Some(d) = string(node, "description") {
                bits.push(format!("alt {}", quote(d)));
            }
            out.push(format!("{head} — {}", bits.join(" · ")));
        }
        ct::FILE => out.push(format!("{head} — {}", media_of(node.get("file")))),
        ct::SEPARATOR => {
            let divider = if node.get("divider").and_then(Value::as_bool) == Some(false) {
                "invisible"
            } else {
                "divider"
            };
            let spacing = if node.get("spacing").and_then(Value::as_u64) == Some(2) {
                "large spacing"
            } else {
                "small spacing"
            };
            out.push(format!("{head} — {divider}, {spacing}"));
        }
        _ => out.push(head),
    }
}

fn describe_button(btn: &Value) -> String {
    let style = btn.get("style").and_then(Value::as_u64).unwrap_or(0);
    let mut parts: Vec<String> = Vec::new();
    if style == button_style::PREMIUM {
        parts.push(format!("SKU {}", string(btn, "sku_id").unwrap_or("(none)")));
    } else {
        let text = format!(
            "{}{}",
            emoji_prefix(btn.get("emoji")),
            string(btn, "label").unwrap_or("")
        );
        let text = text.trim().to_string();
        parts.push(format!(
            "[{}]",
            if text.is_empty() { "(no label)" } else { &text }
        ));
        parts.push(style_name(style).into());
        if style == button_style::LINK {
            parts.push(format!("→ {}", string(btn, "url").unwrap_or("(no URL)")));
        } else {
            parts.push(format!(
                "custom_id {}",
                quote(string(btn, "custom_id").unwrap_or(""))
            ));
        }
    }
    if btn.get("disabled").and_then(Value::as_bool) == Some(true) {
        parts.push("disabled".into());
    }
    parts.join(" · ")
}

fn describe_select(sel: &Value, kind: u64) -> String {
    let picks = match kind {
        ct::STRING_SELECT => "options",
        ct::USER_SELECT => "users",
        ct::ROLE_SELECT => "roles",
        ct::MENTIONABLE_SELECT => "users or roles",
        ct::CHANNEL_SELECT => "channels",
        _ => "values",
    };
    let mut parts = vec![
        format!("picks {picks}"),
        format!(
            "custom_id {}",
            quote(string(sel, "custom_id").unwrap_or(""))
        ),
    ];
    if let Some(p) = string(sel, "placeholder") {
        parts.push(format!("placeholder {}", quote(p)));
    }
    let min = sel.get("min_values").and_then(Value::as_i64);
    let max = sel.get("max_values").and_then(Value::as_i64);
    if min.is_some() || max.is_some() {
        parts.push(format!("choose {}–{}", min.unwrap_or(1), max.unwrap_or(1)));
    }
    if sel.get("disabled").and_then(Value::as_bool) == Some(true) {
        parts.push("disabled".into());
    }
    parts.join(" · ")
}

fn text_block(content: &str, indent: &str) -> Vec<String> {
    // Elide on a character boundary — slicing a &str mid-codepoint panics, and
    // message text is full of emoji.
    let clipped = if content.chars().count() > MAX_TEXT {
        let head: String = content.chars().take(MAX_TEXT).collect();
        format!(
            "{head}… (+{} more characters)",
            content.chars().count() - MAX_TEXT
        )
    } else {
        content.to_string()
    };
    if clipped.is_empty() {
        return vec![format!("{indent}(empty)")];
    }
    clipped
        .split('\n')
        .map(|line| format!("{indent}{line}"))
        .collect()
}

fn glyph(kind: u64) -> &'static str {
    match kind {
        ct::CONTAINER => "▤",
        ct::SECTION => "◧",
        ct::TEXT_DISPLAY => "¶",
        ct::MEDIA_GALLERY => "▦",
        ct::FILE => "⎘",
        ct::SEPARATOR => "―",
        ct::ACTION_ROW => "⬚",
        ct::BUTTON => "▭",
        ct::THUMBNAIL => "▣",
        ct::STRING_SELECT
        | ct::USER_SELECT
        | ct::ROLE_SELECT
        | ct::MENTIONABLE_SELECT
        | ct::CHANNEL_SELECT => "▾",
        _ => "•",
    }
}

fn label(kind: u64) -> String {
    match kind {
        ct::CONTAINER => "Container".into(),
        ct::SECTION => "Section".into(),
        ct::TEXT_DISPLAY => "Text".into(),
        ct::MEDIA_GALLERY => "Media Gallery".into(),
        ct::FILE => "File".into(),
        ct::SEPARATOR => "Separator".into(),
        ct::ACTION_ROW => "Buttons Row".into(),
        ct::BUTTON => "Button".into(),
        ct::THUMBNAIL => "Thumbnail".into(),
        ct::STRING_SELECT => "String Select".into(),
        ct::USER_SELECT => "User Select".into(),
        ct::ROLE_SELECT => "Role Select".into(),
        ct::MENTIONABLE_SELECT => "Mentionable Select".into(),
        ct::CHANNEL_SELECT => "Channel Select".into(),
        other => format!("Type {other}"),
    }
}

fn style_name(style: u64) -> &'static str {
    match style {
        1 => "blurple",
        2 => "grey",
        3 => "green",
        4 => "red",
        5 => "link",
        6 => "premium",
        _ => "unknown style",
    }
}

fn accent(node: &Value) -> String {
    match node.get("accent_color").and_then(Value::as_u64) {
        Some(color) => format!("accent #{color:06X}"),
        None => "no accent".into(),
    }
}

fn media_of(media: Option<&Value>) -> String {
    let Some(media) = media else {
        return "(no media)".into();
    };
    if let Some(url) = string(media, "url") {
        return url.to_string();
    }
    if let Some(id) = string(media, "attachment_id") {
        return format!("attachment id {id}");
    }
    "(no URL)".into()
}

fn emoji_prefix(emoji: Option<&Value>) -> String {
    let Some(emoji) = emoji else {
        return String::new();
    };
    let name = string(emoji, "name").unwrap_or("");
    if name.is_empty() {
        return String::new();
    }
    if string(emoji, "id").is_some() {
        format!(":{name}: ")
    } else {
        format!("{name} ")
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn states_the_size_and_settings_before_the_tree() {
        let out = outline(&json!({
            "username": "Announcer",
            "thread_name": "Patch notes",
            "flags": (1u64 << 15) | (1u64 << 12),
            "components": [{ "type": 10, "content": "hello" }]
        }));
        assert!(out.contains("1 top-level · 1 components total"));
        assert!(out.contains("Posts as: \"Announcer\""));
        assert!(out.contains("Forum post title: \"Patch notes\""));
        assert!(out.contains("Silent send"));
    }

    #[test]
    fn indents_by_nesting_and_names_the_accent_in_hex() {
        let out = outline(&json!({
            "components": [{
                "type": 17,
                "accent_color": 0x5865F2,
                "components": [
                    { "type": 10, "content": "# Title\nBody" },
                    { "type": 14, "divider": true, "spacing": 2 }
                ]
            }]
        }));
        assert!(out.contains("Container — accent #5865F2"));
        assert!(out.contains("  ¶ Text"));
        assert!(out.contains("    # Title\n    Body"));
        assert!(out.contains("Separator — divider, large spacing"));
    }

    // Confusing a link button with an interactive one is the single most common
    // Components V2 mistake, so the outline names the kind and the target.
    #[test]
    fn distinguishes_a_link_button_from_an_interactive_one() {
        let out = outline(&json!({
            "components": [{
                "type": 1,
                "components": [
                    { "type": 2, "style": 5, "label": "Docs", "url": "https://e.test/d" },
                    { "type": 2, "style": 4, "label": "Stop", "custom_id": "stop", "disabled": true }
                ]
            }]
        }));
        assert!(out.contains("[Docs] · link · → https://e.test/d"));
        assert!(out.contains("[Stop] · red · custom_id \"stop\" · disabled"));
    }

    #[test]
    fn shows_a_sections_accessory_and_flags_a_missing_one() {
        let with = outline(&json!({
            "components": [{
                "type": 9,
                "components": [{ "type": 10, "content": "hi" }],
                "accessory": { "type": 11, "media": { "url": "https://e.test/i.png" }, "description": "art" }
            }]
        }));
        assert!(with.contains("accessory:"));
        assert!(with.contains("Thumbnail — https://e.test/i.png · alt \"art\""));

        let without = outline(&json!({
            "components": [{ "type": 9, "components": [{ "type": 10, "content": "hi" }] }]
        }));
        assert!(without.contains("(missing — Discord requires one)"));
    }

    #[test]
    fn lists_a_string_selects_options() {
        let out = outline(&json!({
            "components": [{
                "type": 1,
                "components": [{
                    "type": 3,
                    "custom_id": "pick",
                    "placeholder": "Choose",
                    "min_values": 1,
                    "max_values": 2,
                    "options": [
                        { "label": "Red", "value": "r", "description": "warm" },
                        { "label": "Blue", "value": "b", "default": true }
                    ]
                }]
            }]
        }));
        assert!(out.contains("picks options"));
        assert!(out.contains("choose 1–2"));
        assert!(out.contains("1. Red · value \"r\" · \"warm\""));
        assert!(out.contains("selected by default"));
    }

    // Slicing a &str mid-codepoint panics, and message text is full of emoji —
    // eliding has to count characters, not bytes.
    #[test]
    fn elides_long_text_without_splitting_a_character() {
        let content = "😀".repeat(700);
        let out = outline(&json!({ "components": [{ "type": 10, "content": content }] }));
        assert!(out.contains("(+100 more characters)"));
    }

    #[test]
    fn says_plainly_when_a_message_is_empty() {
        assert!(outline(&json!({ "components": [] })).contains("no components"));
    }

    #[test]
    fn renders_every_built_in_template() {
        for template in super::super::catalog::templates() {
            let rendered = outline(&template.message);
            assert!(!rendered.is_empty(), "{} rendered nothing", template.id);
        }
    }
}
