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
/// Discord's `MANAGE_GUILD` permission bit, for the permanent-slot toggle.
/// (Registration also sets `default_member_permissions`, but that's a
/// default server owners can override — this check is the real gate.)
const MANAGE_GUILD: u128 = 1 << 5;
/// Components V2 Text Display, used to lift a legacy message's `content`
/// into the component tree the editor works on.
const TYPE_TEXT_DISPLAY: u64 = 10;

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
    let payload = message_to_share_payload(msg);
    if payload["components"].as_array().is_some_and(Vec::is_empty) {
        return ephemeral(
            "This message has no content or components the editor can work on \
             (embeds aren't supported yet).",
        );
    }
    let url = editor_url(app, &payload);
    let text = format!(
        "\u{1F4DD} **[Open this message in the DWEEB editor](<{url}>)**\n\
         -# The message travels inside the link's #fragment — it never touches a server. \
         Opening it replaces your current editor draft (undoable)."
    );
    reply_sized(text).unwrap_or_else(|| too_large(interaction))
}

/// "Export JSON": the postable wire payload, pretty-printed in a code block.
/// Falls back to an editor link (Share → JSON export) when it outgrows the
/// reply budget — the link compresses, the code block doesn't.
fn export_json(app: &App, interaction: &Value) -> Response {
    let Some(msg) = target_message(interaction) else {
        return ephemeral("Couldn't read the message from this interaction.");
    };
    let payload = message_to_share_payload(msg);
    let pretty = serde_json::to_string_pretty(&payload).unwrap_or_default();
    // A ``` inside a JSON string would close our fence early; a zero-width
    // space breaks the run while staying invisible in the snippet.
    let fenced = format!("```json\n{}\n```", pretty.replace("```", "`\u{200B}``"));
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
/// (the same shape its own Restore flow feeds `attachEditorFields`):
/// components pass through untouched; a legacy `content` becomes a leading
/// Text Display so plain-text messages open editable too; the author maps to
/// the webhook username/avatar fields; `flags` rides along so the silent-send
/// toggle round-trips. Everything else (embeds, reactions, …) is dropped.
fn message_to_share_payload(msg: &Value) -> Value {
    let mut components = msg
        .get("components")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(content) = msg.get("content").and_then(Value::as_str) {
        if !content.is_empty() {
            components.insert(0, json!({ "type": TYPE_TEXT_DISPLAY, "content": content }));
        }
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
    if let Some(flags) = msg.get("flags").and_then(Value::as_u64) {
        payload.insert("flags".into(), json!(flags));
    }
    payload.insert("components".into(), Value::Array(components));
    Value::Object(payload)
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
        let payload = message_to_share_payload(&msg);
        assert_eq!(payload["username"], "My Hook");
        assert_eq!(
            payload["avatar_url"],
            "https://cdn.discordapp.com/avatars/42/abc123.png"
        );
        assert_eq!(payload["flags"], 4096);
        let components = payload["components"].as_array().unwrap();
        // content lifted into a leading Text Display, original row preserved.
        assert_eq!(components.len(), 2);
        assert_eq!(components[0]["type"], 10);
        assert_eq!(components[0]["content"], "legacy text");
        assert_eq!(components[1]["type"], 1);
    }
}
