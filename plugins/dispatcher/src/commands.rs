//! Inline handlers for the app's application commands — the slash command
//! (`/dashboard`) and the context-menu (right-click → Apps) commands.
//!
//! Application-command interactions carry no `custom_id`, so the prefix
//! routing in main.rs never sees them; they are all answered HERE, in the
//! dispatcher's own HTTP response, the same way `/dashboard` always was.
//! That is also what makes them fast: every handler below is a pure function
//! of the interaction payload Discord already sent — no Discord API call, no
//! forward hop, and (except the permanent-slot toggle, which owns that data
//! anyway) no database. The expensive-looking part, compressing a message
//! into a share link, is LZ-String over a few KB of JSON — microseconds.
//!
//! The share-link contract: a MESSAGE command's payload includes the full
//! target message under `data.resolved.messages`, and the web editor already
//! opens `#s=<version>.<lz-string>` share tokens (src/core/serialization).
//! So "Edit in DWEEB" re-encodes the resolved message into exactly that
//! token format — the deployed frontend needs zero changes, and the message
//! travels inside the URL fragment, which never reaches any server.
//!
//! Register the commands with `node scripts/register-commands.mjs` (the
//! canonical list lives there; the names below must match it).

use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

use crate::{ephemeral, App, FLAG_EPHEMERAL, RESPONSE_CHANNEL_MESSAGE};

/// `IS_COMPONENTS_V2` — lets a reply carry a Text Display component, whose
/// budget (4000 chars across the message) doubles plain `content`'s 2000.
const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15;
/// `SUPPRESS_NOTIFICATIONS` — the one wire flag the editor reads back (its
/// silent-send toggle), so it's the only original bit worth carrying over.
const FLAG_SUPPRESS_NOTIFICATIONS: u64 = 1 << 12;
/// Discord's `MANAGE_GUILD` permission bit, for the permanent-slot toggle.
/// (Registration also sets `default_member_permissions`, but that's a
/// default server owners can override — this check is the real gate.)
const MANAGE_GUILD: u128 = 1 << 5;
// Components V2 types used when rebuilding a legacy message as a V2 tree.
const TYPE_SECTION: u64 = 9;
const TYPE_TEXT_DISPLAY: u64 = 10;
const TYPE_THUMBNAIL: u64 = 11;
const TYPE_MEDIA_GALLERY: u64 = 12;
const TYPE_CONTAINER: u64 = 17;
/// A media gallery holds at most this many items.
const MAX_GALLERY_ITEMS: usize = 10;

/// Version prefix of the share tokens we emit. Must track `CURRENT_VERSION`
/// in src/core/serialization/version.ts — bump them together.
const SHARE_VERSION: &str = "1";

/// Hard ceilings Discord enforces on an interaction reply.
const MAX_CONTENT: usize = 2000;
const MAX_V2_TEXT: usize = 4000;

// Command names, as registered. The match in `respond` is the only consumer;
// scripts/register-commands.mjs must use the same strings.
const CMD_DASHBOARD: &str = "dashboard";
const CMD_EDIT: &str = "Edit in DWEEB";
const CMD_EXPORT_JSON: &str = "Export JSON";
const CMD_PERMANENT: &str = "Make Permanent";
const CMD_IDENTITY: &str = "Use as Webhook Identity";

/// Answer any application-command interaction. Unknown names get a polite
/// ephemeral shrug (a stale registration, or a custom app that registered
/// extra commands we don't serve).
pub fn respond(app: &App, interaction: &Value) -> Response {
    let name = interaction
        .pointer("/data/name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match name {
        CMD_DASHBOARD => {
            // Bare URL (no <>) so Discord renders the OG preview card.
            ephemeral(&format!(
                "\u{1F6E0}\u{FE0F} Build and manage your messages at {}",
                app.dashboard_url
            ))
        }
        CMD_EDIT => edit_in_dweeb(app, interaction),
        CMD_EXPORT_JSON => export_json(app, interaction),
        CMD_PERMANENT => toggle_permanent(app, interaction),
        CMD_IDENTITY => webhook_identity(app, interaction),
        _ => {
            tracing::warn!(name, "unknown application command");
            ephemeral("Unknown command.")
        }
    }
}

// ── Message commands ─────────────────────────────────────────────────────────

/// "Edit in DWEEB": the resolved message, re-encoded as a share token the
/// editor already opens. Two clicks from any message to editing it — no
/// Developer Mode, no copying ids, no pasting webhook URLs.
fn edit_in_dweeb(app: &App, interaction: &Value) -> Response {
    let Some(msg) = target_message(interaction) else {
        return ephemeral("Couldn't read the message from this interaction.");
    };
    let (payload, converted) = message_to_share_payload(msg);
    let url = editor_url(app, &payload);
    let mut text = format!(
        "\u{1F4DD} **[Open this message in the DWEEB editor](<{url}>)**\n\
         -# The message travels inside the link's #fragment — it never touches a server. \
         Opening it replaces your current editor draft (undoable)."
    );
    if converted {
        text.push_str(
            "\n-# Embeds/attachments were converted to Components V2 — \
             the layout is approximate, check the preview.",
        );
    } else if payload["components"].as_array().is_some_and(Vec::is_empty) {
        text.push_str("\n-# Nothing in this message maps to the editor yet, so it opens empty.");
    }
    reply_sized(text).unwrap_or_else(|| too_large(interaction))
}

/// "Export JSON": the postable wire payload, pretty-printed in a code block.
/// Falls back to an editor link (Share → JSON export) when it outgrows the
/// reply budget — the link compresses, the code block doesn't.
fn export_json(app: &App, interaction: &Value) -> Response {
    let Some(msg) = target_message(interaction) else {
        return ephemeral("Couldn't read the message from this interaction.");
    };
    let (payload, converted) = message_to_share_payload(msg);
    let pretty = serde_json::to_string_pretty(&payload).unwrap_or_default();
    // A ``` inside a JSON string would close our fence early; a zero-width
    // space breaks the run while staying invisible in the snippet.
    let mut fenced = format!("```json\n{}\n```", pretty.replace("```", "`\u{200B}``"));
    if converted {
        fenced.push_str("-# Embeds/attachments were converted to Components V2.");
    }
    if let Some(response) = reply_sized(fenced) {
        return response;
    }
    let url = editor_url(app, &payload);
    let text = format!(
        "The JSON is too large for an inline reply — \
         **[open the message in the editor](<{url}>)** and use *Share → JSON export*."
    );
    reply_sized(text).unwrap_or_else(|| too_large(interaction))
}

/// "Make Permanent": spend one of the guild's TTL-exemption slots on the
/// message — or give it back when the message already holds one. The toggle
/// runs against the same SQLite store the TTL gate consults, in-process.
fn toggle_permanent(app: &App, interaction: &Value) -> Response {
    let Some(guild_id) = interaction.get("guild_id").and_then(Value::as_str) else {
        return ephemeral("This command only works inside a server.");
    };
    // member.permissions is Discord's already-computed set for the invoker in
    // this channel (Administrator arrives with every bit set).
    let permissions: u128 = interaction
        .pointer("/member/permissions")
        .and_then(Value::as_str)
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    if permissions & MANAGE_GUILD == 0 {
        return ephemeral(
            "You need the **Manage Server** permission to manage permanent messages.",
        );
    }
    if app.component_ttl_ms.is_none() {
        return ephemeral(
            "Components never expire on this deployment — every message is already permanent.",
        );
    }
    let Some(msg) = target_message(interaction) else {
        return ephemeral("Couldn't read the message from this interaction.");
    };
    let message_id = msg.get("id").and_then(Value::as_str).unwrap_or_default();
    let channel_id = msg
        .get("channel_id")
        .and_then(Value::as_str)
        .or_else(|| interaction.get("channel_id").and_then(Value::as_str))
        .unwrap_or_default();
    if message_id.is_empty() || channel_id.is_empty() {
        return ephemeral("Couldn't read the message from this interaction.");
    }
    let ttl_days = app.component_ttl_ms.map(|ms| ms / 86_400_000).unwrap_or(0);

    if app.store.is_permanent(message_id) {
        // Guild-scoped remove: a permanent message of another guild is
        // unreachable from here, exactly like the dashboard path.
        return match app.store.remove(guild_id, message_id) {
            Ok(true) => ephemeral(&format!(
                "\u{1F513} Released — this message's components now expire {ttl_days} days \
                 after it was sent, like any other.{}",
                usage_suffix(app, guild_id)
            )),
            Ok(false) => ephemeral("That message's permanent slot belongs to another server."),
            Err(err) => storage_error(err),
        };
    }

    // Permanence only matters for something that can expire.
    if msg
        .get("components")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty)
    {
        return ephemeral(
            "This message has no interactive components — permanent slots only keep \
             components clickable past their expiry.",
        );
    }
    let added_by = interaction
        .pointer("/member/user/id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match app.store.add(
        guild_id,
        channel_id,
        message_id,
        added_by,
        app.permanent_slots,
    ) {
        // `Already` only happens on a toggle race; report it as the success it is.
        Ok(crate::store::Add::Added) | Ok(crate::store::Add::Already) => ephemeral(&format!(
            "\u{1F512} Permanent — this message's components never expire \
             (others expire after {ttl_days} days). Run the command again to release the slot.{}",
            usage_suffix(app, guild_id)
        )),
        Ok(crate::store::Add::Full) => ephemeral(&format!(
            "Every permanent slot is taken.{} Release one by running this command on a \
             permanent message, or from the dashboard's *Managed messages*.",
            usage_suffix(app, guild_id)
        )),
        Err(err) => storage_error(err),
    }
}

// ── User command ─────────────────────────────────────────────────────────────

/// "Use as Webhook Identity": an editor link with the webhook's username and
/// avatar prefilled from the targeted member — server nickname and guild
/// avatar first, since that's what the impersonation should look like here.
fn webhook_identity(app: &App, interaction: &Value) -> Response {
    let Some(target_id) = interaction
        .pointer("/data/target_id")
        .and_then(Value::as_str)
    else {
        return ephemeral("Couldn't read the user from this interaction.");
    };
    let Some(user) = interaction
        .pointer(&format!("/data/resolved/users/{target_id}"))
        .filter(|u| u.is_object())
    else {
        return ephemeral("Couldn't read the user from this interaction.");
    };
    let member = interaction.pointer(&format!("/data/resolved/members/{target_id}"));
    let str_at = |v: Option<&Value>, key: &str| -> Option<String> {
        v.and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    let name = str_at(member, "nick")
        .or_else(|| str_at(Some(user), "global_name"))
        .or_else(|| str_at(Some(user), "username"))
        .unwrap_or_else(|| "Webhook".into());
    let guild_id = interaction.get("guild_id").and_then(Value::as_str);
    let avatar_url = match (
        str_at(member, "avatar"),
        str_at(Some(user), "avatar"),
        guild_id,
    ) {
        (Some(hash), _, Some(gid)) => Some(format!(
            "https://cdn.discordapp.com/guilds/{gid}/users/{target_id}/avatars/{hash}.png"
        )),
        (_, Some(hash), _) => Some(format!(
            "https://cdn.discordapp.com/avatars/{target_id}/{hash}.png"
        )),
        // Discord's default avatar, picked the way the client does for users
        // on the new username system: (id >> 22) % 6.
        _ => target_id.parse::<u64>().ok().map(|id| {
            format!(
                "https://cdn.discordapp.com/embed/avatars/{}.png",
                (id >> 22) % 6
            )
        }),
    };

    let mut payload = Map::new();
    payload.insert("username".into(), json!(name));
    if let Some(url) = avatar_url {
        payload.insert("avatar_url".into(), json!(url));
    }
    payload.insert("components".into(), json!([]));
    let url = editor_url(app, &Value::Object(payload));
    // Brackets in a nickname would close the masked link early; the payload
    // keeps the real name, only the link text drops them.
    let link_name: String = name
        .chars()
        .filter(|c| !matches!(c, '[' | ']' | '(' | ')'))
        .collect();
    let text = format!(
        "\u{1FAAA} **[Start a message as {link_name}](<{url}>)**\n\
         -# Opens the editor with the webhook's name and avatar prefilled. \
         It replaces your current editor draft (undoable)."
    );
    reply_sized(text).unwrap_or_else(|| ephemeral("That name is too long to fit in a link."))
}

// ── Share-token plumbing ─────────────────────────────────────────────────────

/// The resolved target of a MESSAGE command — the full message object,
/// straight from the interaction payload.
fn target_message(interaction: &Value) -> Option<&Value> {
    let target_id = interaction
        .pointer("/data/target_id")
        .and_then(Value::as_str)?;
    interaction
        .pointer(&format!("/data/resolved/messages/{target_id}"))
        .filter(|m| m.is_object())
}

/// Rebuild a resolved Discord message as the wire payload the editor imports
/// (the same shape its own Restore flow feeds `attachEditorFields`). V2
/// components pass through untouched; everything legacy is *converted* so
/// any message opens editable: `content` becomes a leading Text Display,
/// rich embeds become Containers ([`embed_to_container`]), and image/video
/// attachments become a Media Gallery. The author maps to the webhook
/// username/avatar fields, and the emitted `flags` are recomputed the way
/// the editor's own exporter does — `IS_COMPONENTS_V2` plus the original
/// `SUPPRESS_NOTIFICATIONS` bit — so the Export JSON output is postable
/// as-is. The bool is true when an embed or attachment was converted
/// (lossy), so callers can say so.
fn message_to_share_payload(msg: &Value) -> (Value, bool) {
    let mut components = Vec::new();
    let mut converted = false;

    // Discord renders content above embeds/attachments, with the (legacy
    // action-row) components last — keep that order in the rebuilt tree.
    if let Some(content) = msg.get("content").and_then(Value::as_str) {
        if !content.is_empty() {
            components.push(json!({ "type": TYPE_TEXT_DISPLAY, "content": content }));
        }
    }
    for embed in msg
        .get("embeds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        // Only author-built "rich" embeds convert. The other types (link,
        // video, image, …) are URL previews Discord generated from the
        // content — converting them would duplicate what the content
        // already produces, and they re-render from the text anyway.
        let kind = embed.get("type").and_then(Value::as_str).unwrap_or("rich");
        if kind != "rich" {
            continue;
        }
        if let Some(container) = embed_to_container(embed) {
            components.push(container);
            converted = true;
        }
    }
    let media_items: Vec<Value> = msg
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|a| {
            a.get("content_type")
                .and_then(Value::as_str)
                .is_some_and(|ct| ct.starts_with("image/") || ct.starts_with("video/"))
        })
        .filter_map(|a| a.get("url").and_then(Value::as_str))
        .take(MAX_GALLERY_ITEMS)
        .map(|url| json!({ "media": { "url": url } }))
        .collect();
    if !media_items.is_empty() {
        components.push(json!({ "type": TYPE_MEDIA_GALLERY, "items": media_items }));
        converted = true;
    }
    if let Some(existing) = msg.get("components").and_then(Value::as_array) {
        components.extend(existing.iter().cloned());
    }

    let mut payload = Map::new();
    if let Some(name) = msg.pointer("/author/username").and_then(Value::as_str) {
        if !name.is_empty() {
            payload.insert("username".into(), json!(name));
        }
    }
    if let (Some(id), Some(hash)) = (
        msg.pointer("/author/id").and_then(Value::as_str),
        msg.pointer("/author/avatar").and_then(Value::as_str),
    ) {
        payload.insert(
            "avatar_url".into(),
            json!(format!(
                "https://cdn.discordapp.com/avatars/{id}/{hash}.png"
            )),
        );
    }
    let original_flags = msg.get("flags").and_then(Value::as_u64).unwrap_or(0);
    payload.insert(
        "flags".into(),
        json!(FLAG_IS_COMPONENTS_V2 | (original_flags & FLAG_SUPPRESS_NOTIFICATIONS)),
    );
    payload.insert("components".into(), Value::Array(components));
    (Value::Object(payload), converted)
}

/// A rich embed, rebuilt as the closest Components V2 Container. Lossy by
/// nature: inline field columns flatten to stacked text, the author's icon
/// and the timestamp have no V2 counterpart. The mapping —
///
///   color        → container accent_color
///   author.name  → `-# name` subtext (linked when author.url is set)
///   title        → `### title` heading (linked when embed.url is set)
///   description  → text as-is
///   fields       → one text block of `**name**` / value pairs
///   thumbnail    → Section accessory on the leading text
///   image        → Media Gallery
///   footer.text  → `-# text` subtext
///
/// `None` when nothing in the embed maps (then it isn't "converted" either).
fn embed_to_container(embed: &Value) -> Option<Value> {
    let text_at = |ptr: &str| {
        embed
            .pointer(ptr)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };

    let mut texts = Vec::new();
    if let Some(author) = text_at("/author/name") {
        texts.push(match text_at("/author/url") {
            Some(url) => format!("-# [{author}]({url})"),
            None => format!("-# {author}"),
        });
    }
    if let Some(title) = text_at("/title") {
        texts.push(match text_at("/url") {
            Some(url) => format!("### [{title}]({url})"),
            None => format!("### {title}"),
        });
    }
    if let Some(description) = text_at("/description") {
        texts.push(description.to_string());
    }
    let fields: Vec<String> = embed
        .get("fields")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let name = f.get("name").and_then(Value::as_str).unwrap_or_default();
            let value = f.get("value").and_then(Value::as_str).unwrap_or_default();
            (!name.is_empty() || !value.is_empty()).then(|| format!("**{name}**\n{value}"))
        })
        .collect();
    if !fields.is_empty() {
        texts.push(fields.join("\n\n"));
    }
    if let Some(footer) = text_at("/footer/text") {
        texts.push(format!("-# {footer}"));
    }

    let mut children = Vec::new();
    let mut texts = texts.into_iter();
    // The thumbnail sits beside the embed's leading text, which is exactly
    // what a Section with a Thumbnail accessory is. (A thumbnail on an
    // embed with no text at all has nothing to anchor to and is dropped.)
    if let Some(thumb) = text_at("/thumbnail/url") {
        if let Some(first) = texts.next() {
            children.push(json!({
                "type": TYPE_SECTION,
                "components": [{ "type": TYPE_TEXT_DISPLAY, "content": first }],
                "accessory": { "type": TYPE_THUMBNAIL, "media": { "url": thumb } },
            }));
        }
    }
    children.extend(texts.map(|t| json!({ "type": TYPE_TEXT_DISPLAY, "content": t })));
    if let Some(image) = text_at("/image/url") {
        children.push(json!({
            "type": TYPE_MEDIA_GALLERY,
            "items": [{ "media": { "url": image } }],
        }));
    }
    if children.is_empty() {
        return None;
    }

    let mut container = Map::new();
    container.insert("type".into(), json!(TYPE_CONTAINER));
    if let Some(color) = embed.get("color").and_then(Value::as_u64) {
        container.insert("accent_color".into(), json!(color));
    }
    container.insert("components".into(), Value::Array(children));
    Some(Value::Object(container))
}

/// `<dashboard>/#s=<token>` — the editor's share-URL entrypoint.
fn editor_url(app: &App, payload: &Value) -> String {
    format!("{}/#s={}", app.dashboard_url, share_token(payload))
}

/// Encode a wire payload as a share token: JSON → LZ-String (URI-safe) →
/// `v{N}.<body>`, byte-identical to what the frontend's `encodeShare` emits.
/// The frontend reads the hash through `URLSearchParams`, which decodes `+`
/// as a space — so `+` (and `$`, matching what URLSearchParams itself emits)
/// is percent-escaped; the rest of LZ-String's URI-safe alphabet survives
/// as-is.
pub(crate) fn share_token(payload: &Value) -> String {
    let json = serde_json::to_string(payload).unwrap_or_default();
    let compressed = lz_str::compress_to_encoded_uri_component(json.as_str());
    let mut token = String::with_capacity(SHARE_VERSION.len() + 1 + compressed.len() + 16);
    token.push_str(SHARE_VERSION);
    token.push('.');
    for ch in compressed.chars() {
        match ch {
            '+' => token.push_str("%2B"),
            '$' => token.push_str("%24"),
            c => token.push(c),
        }
    }
    token
}

// ── Reply plumbing ───────────────────────────────────────────────────────────

/// Ephemeral reply sized to Discord's limits: plain `content` up to 2000
/// chars, a Components V2 Text Display up to 4000, `None` beyond that.
fn reply_sized(text: String) -> Option<Response> {
    let len = text.chars().count();
    if len <= MAX_CONTENT {
        return Some(ephemeral(&text));
    }
    if len <= MAX_V2_TEXT {
        return Some(
            Json(json!({
                "type": RESPONSE_CHANNEL_MESSAGE,
                "data": {
                    "flags": FLAG_EPHEMERAL | FLAG_IS_COMPONENTS_V2,
                    "components": [{ "type": TYPE_TEXT_DISPLAY, "content": text }],
                }
            }))
            .into_response(),
        );
    }
    None
}

/// Last-resort reply when even the compressed link outgrows a message: point
/// at the editor's Restore flow, which fetches by id instead of embedding.
fn too_large(interaction: &Value) -> Response {
    let message_id = interaction
        .pointer("/data/target_id")
        .and_then(Value::as_str)
        .unwrap_or("?");
    ephemeral(&format!(
        "This message is too large to fit in a link. Use **Restore** in the editor \
         with the webhook URL and message ID `{message_id}`."
    ))
}

fn usage_suffix(app: &App, guild_id: &str) -> String {
    match app.store.list(guild_id) {
        Ok(rows) => format!(" ({}/{} slots used.)", rows.len(), app.permanent_slots),
        Err(_) => String::new(),
    }
}

fn storage_error(err: rusqlite::Error) -> Response {
    tracing::error!(%err, "permanent store error");
    ephemeral("Something went wrong saving that — try again shortly.")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode a token the way the frontend does: URLSearchParams unescape,
    /// split the version prefix, LZ-String decompress, JSON parse.
    fn decode_token(token: &str) -> Value {
        let unescaped = token.replace("%2B", "+").replace("%24", "$");
        let (version, body) = unescaped.split_once('.').expect("version prefix");
        assert_eq!(version, SHARE_VERSION);
        let wide = lz_str::decompress_from_encoded_uri_component(body).expect("decompress");
        let json = String::from_utf16(&wide).expect("utf16");
        serde_json::from_str(&json).expect("json")
    }

    #[test]
    fn share_token_round_trips() {
        let payload = json!({
            "username": "Hook — émoji ✓",
            "components": [{ "type": 10, "content": "hello **world** $1 + $2" }],
            "flags": 32768,
        });
        assert_eq!(decode_token(&share_token(&payload)), payload);
    }

    #[test]
    fn share_token_is_urlsearchparams_safe() {
        // No raw '+', '$', '&', '=', '#', '%' (except our escapes) — the
        // frontend parses the hash with URLSearchParams.
        let payload = json!({ "components": [{ "type": 10, "content": "x".repeat(500) }] });
        let token = share_token(&payload);
        let stripped = token.replace("%2B", "").replace("%24", "");
        assert!(
            stripped
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.'),
            "unexpected character in token: {token}"
        );
    }

    #[test]
    fn resolved_message_becomes_editor_payload() {
        let msg = json!({
            "id": "1",
            "channel_id": "2",
            "content": "legacy text",
            "flags": 4096,
            "author": { "id": "42", "username": "My Hook", "avatar": "abc123" },
            "components": [{ "type": 1, "components": [
                { "type": 2, "style": 1, "label": "Go", "custom_id": "pingpong:go" }
            ]}],
        });
        let (payload, converted) = message_to_share_payload(&msg);
        assert_eq!(payload["username"], "My Hook");
        assert_eq!(
            payload["avatar_url"],
            "https://cdn.discordapp.com/avatars/42/abc123.png"
        );
        // Flags are recomputed like the editor's exporter: IS_COMPONENTS_V2
        // plus the original suppress-notifications bit.
        assert_eq!(payload["flags"], 4096 | 32768);
        // Lifting content isn't a lossy conversion — no notice for it.
        assert!(!converted);
        let components = payload["components"].as_array().unwrap();
        // content lifted into a leading Text Display, original row preserved.
        assert_eq!(components.len(), 2);
        assert_eq!(components[0]["type"], 10);
        assert_eq!(components[0]["content"], "legacy text");
        assert_eq!(components[1]["type"], 1);
    }

    #[test]
    fn rich_embed_becomes_container() {
        let msg = json!({
            "id": "1",
            "flags": 0,
            "embeds": [{
                "type": "rich",
                "color": 5793266,
                "url": "https://example.com",
                "title": "Patch Notes",
                "description": "All the changes.",
                "author": { "name": "Release Bot" },
                "footer": { "text": "v1.2.3" },
                "thumbnail": { "url": "https://cdn.example.com/thumb.png" },
                "image": { "url": "https://cdn.example.com/banner.png" },
                "fields": [
                    { "name": "Fixed", "value": "the bug", "inline": true },
                    { "name": "Added", "value": "a thing", "inline": false },
                ],
            }],
        });
        let (payload, converted) = message_to_share_payload(&msg);
        assert!(converted);
        assert_eq!(payload["flags"], 32768);
        let components = payload["components"].as_array().unwrap();
        assert_eq!(components.len(), 1);
        let container = &components[0];
        assert_eq!(container["type"], 17);
        assert_eq!(container["accent_color"], 5793266);
        let children = container["components"].as_array().unwrap();
        // Section (author line + thumbnail), title, description, fields,
        // footer, image gallery.
        assert_eq!(children[0]["type"], 9);
        assert_eq!(
            children[0]["accessory"]["media"]["url"],
            "https://cdn.example.com/thumb.png"
        );
        assert_eq!(children[0]["components"][0]["content"], "-# Release Bot");
        assert_eq!(
            children[1]["content"],
            "### [Patch Notes](https://example.com)"
        );
        assert_eq!(children[2]["content"], "All the changes.");
        assert_eq!(
            children[3]["content"],
            "**Fixed**\nthe bug\n\n**Added**\na thing"
        );
        assert_eq!(children[4]["content"], "-# v1.2.3");
        assert_eq!(children[5]["type"], 12);
        assert_eq!(
            children[5]["items"][0]["media"]["url"],
            "https://cdn.example.com/banner.png"
        );
    }

    #[test]
    fn link_preview_embeds_are_skipped() {
        let msg = json!({
            "id": "1",
            "content": "https://youtu.be/x",
            "embeds": [{ "type": "video", "title": "Some Video", "url": "https://youtu.be/x" }],
        });
        let (payload, converted) = message_to_share_payload(&msg);
        // The preview regenerates from the content; converting it would
        // duplicate it.
        assert!(!converted);
        assert_eq!(payload["components"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn media_attachments_become_gallery_and_empty_is_allowed() {
        let msg = json!({
            "id": "1",
            "attachments": [
                { "url": "https://cdn.example.com/a.png", "content_type": "image/png" },
                { "url": "https://cdn.example.com/b.pdf", "content_type": "application/pdf" },
            ],
        });
        let (payload, converted) = message_to_share_payload(&msg);
        assert!(converted);
        let components = payload["components"].as_array().unwrap();
        assert_eq!(components.len(), 1);
        assert_eq!(components[0]["type"], 12);
        assert_eq!(components[0]["items"].as_array().unwrap().len(), 1);

        // A message with nothing mappable still produces a valid (empty)
        // payload — the editor opens empty instead of the command failing.
        let (payload, converted) = message_to_share_payload(&json!({ "id": "1" }));
        assert!(!converted);
        assert!(payload["components"].as_array().unwrap().is_empty());
    }
}
