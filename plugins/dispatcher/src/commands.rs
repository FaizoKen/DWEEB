//! Inline handlers for the app's application commands — the slash command
//! (`/dashboard`) and the context-menu (right-click → Apps) commands.
//!
//! Application-command interactions carry no `custom_id`, so the prefix
//! routing in main.rs never sees them; they are all answered HERE, in the
//! dispatcher's own HTTP response, the same way `/dashboard` always was.
//! That is also what makes them fast: every handler below is a pure function
//! of the interaction payload Discord already sent — no Discord API call, no
//! forward hop, and (except the permanent-slot and component-activity data
//! behind "Message Info", which this service owns anyway) no database. The expensive-looking part,
//! compressing a message into a share link, is LZ-String over a few KB of
//! JSON — microseconds.
//!
//! One command grew a component: "Message Info" puts a permanent-slot toggle
//! button on its reply. Its custom_id lives under [`CUSTOM_ID_PREFIX`], which
//! main.rs intercepts ahead of the plugin routing and answers via
//! [`component`] — the only custom_id namespace the dispatcher keeps for
//! itself.
//!
//! "Message Info" is also where plugins on a message become manageable
//! without hunting for hidden affordances: the reply names every routed
//! plugin it finds on the message, and for the plugins that serve a `manage:`
//! verb ([`MANAGEABLE_PLUGINS`]) it gives Manage Server holders a button per
//! instance. Those buttons carry the PLUGIN's own custom_id namespace
//! (`<prefix>manage:<instance>`), so a click travels the ordinary prefix
//! forwarding in main.rs and the plugin answers with its ephemeral host
//! panel — re-checking authority itself, since any custom_id is
//! client-forgeable. The dispatcher never learns plugin grammars beyond one
//! shared convention: a *bound* component's custom_id is `<prefix><id>`
//! (bare, no verb), which is the only shape the editor ever posts.
//!
//! The share-link contract: a MESSAGE command's payload includes the full
//! target message under `data.resolved.messages`, and the web editor already
//! opens `#s=<version>.<lz-string>` share tokens (src/core/serialization).
//! So "Edit in DWEEB" re-encodes the resolved message into exactly that
//! token format, and the message travels inside the URL fragment, which never
//! reaches any server. For a webhook message the link also carries the public
//! origin ids ([`origin_params`]) so the editor can offer to UPDATE the
//! original in place — the webhook *token* stays out of it, resolved from the
//! browser's own saved webhooks.
//!
//! Register the commands with `node scripts/register-commands.mjs` (the
//! canonical list lives there; the names below must match it).

use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

use crate::store::PermanentDetails;
use crate::{ephemeral, App, FLAG_EPHEMERAL, RESPONSE_CHANNEL_MESSAGE, RESPONSE_UPDATE_MESSAGE};

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
// Classic component types, for the buttons on the Message Info reply.
const TYPE_ACTION_ROW: u64 = 1;
const TYPE_BUTTON: u64 = 2;
const BUTTON_PRIMARY: u64 = 1;
const BUTTON_SECONDARY: u64 = 2;
const BUTTON_DANGER: u64 = 4;
/// A media gallery holds at most this many items.
const MAX_GALLERY_ITEMS: usize = 10;

/// Version prefix of the share tokens we emit. Must track `CURRENT_VERSION`
/// in src/core/serialization/version.ts — bump them together.
const SHARE_VERSION: &str = "1";

/// Hard ceiling Discord enforces on a Components V2 Text Display reply.
const MAX_V2_TEXT: usize = 4000;

// Command names, as registered. The match in `respond` is the only consumer;
// scripts/register-commands.mjs must use the same strings.
const CMD_DASHBOARD: &str = "dashboard";
const CMD_EDIT: &str = "Edit in DWEEB";
const CMD_EXPORT_JSON: &str = "Export JSON";
const CMD_INFO: &str = "Message Info";
/// Pre-rename name of [`CMD_INFO`]. Still answered: global re-registration
/// takes up to an hour to propagate, and custom apps keep the command set
/// they were installed with until their guild re-registers them.
const CMD_INFO_LEGACY: &str = "Make Permanent";
const CMD_IDENTITY: &str = "Use as Webhook Identity";

/// custom_id namespace of components the dispatcher itself puts on its
/// replies. main.rs answers these inline ([`component`]), ahead of the
/// plugin prefix routing — no plugin manifest may claim this prefix.
pub const CUSTOM_ID_PREFIX: &str = "dweeb:";
/// The permanent-slot toggle button on a "Message Info" reply:
/// `dweeb:perm:<channel_id>:<message_id>`.
const PERM_TOGGLE_PREFIX: &str = "dweeb:perm:";

/// Plugins whose services answer a `<prefix>manage:<instance>` component with
/// an ephemeral management panel (authority re-checked at click time): the
/// routing prefix and the label the Manage button carries. Only these
/// prefixes get a button on a "Message Info" reply — a plugin without the
/// verb would answer the click with "Unknown action.", so a prefix belongs
/// here only once its deployed service parses `manage:` (ship the service
/// first, this list second).
const MANAGEABLE_PLUGINS: [(&str, &str); 2] = [("giveaway:", "giveaway"), ("poll:", "poll")];

/// Answer any application-command interaction. Unknown names get a polite
/// ephemeral shrug (a stale registration, or a custom app that registered
/// extra commands we don't serve).
pub async fn respond(app: &App, interaction: &Value) -> Response {
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
        // These two embed the message in the link, so they may overflow the
        // reply budget and fall back to a short link — an async (proxy) hop.
        CMD_EDIT => edit_in_dweeb(app, interaction).await,
        CMD_EXPORT_JSON => export_json(app, interaction).await,
        CMD_INFO | CMD_INFO_LEGACY => message_info(app, interaction),
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
///
/// A webhook message's link also carries its origin ([`origin_params`]) so the
/// editor can offer to UPDATE the original in place instead of posting a copy.
async fn edit_in_dweeb(app: &App, interaction: &Value) -> Response {
    let Some(msg) = target_message(interaction) else {
        return ephemeral("Couldn't read the message from this interaction.");
    };
    let (payload, converted) = message_to_share_payload(msg);
    let raw = share_token_raw(&payload);
    let origin = origin_params(interaction, msg);
    let url = format!("{}/#s={}{origin}", app.dashboard_url, token_for_hash(&raw));
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
    if msg.get("webhook_id").and_then(Value::as_str).is_some() {
        text.push_str(
            "\n-# If this message's webhook is saved in your browser, your edits can \
             update the original in place — otherwise add it under **Restore**.",
        );
    }
    match reply_sized(text) {
        Some(response) => response,
        None => too_large(app, &raw, &origin).await,
    }
}

/// "Export JSON": the postable wire payload, pretty-printed in a code block.
/// Falls back to an editor link (Share → JSON export) when it outgrows the
/// reply budget — the link compresses, the code block doesn't.
async fn export_json(app: &App, interaction: &Value) -> Response {
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
    let raw = share_token_raw(&payload);
    let origin = origin_params(interaction, msg);
    let url = format!("{}/#s={}{origin}", app.dashboard_url, token_for_hash(&raw));
    let text = format!(
        "The JSON is too large for an inline reply — \
         **[open the message in the editor](<{url}>)** and use *Share → JSON export*."
    );
    match reply_sized(text) {
        Some(response) => response,
        None => too_large(app, &raw, &origin).await,
    }
}

/// "Message Info": everything the interaction payload tells us about the
/// message — author, timestamps, ids, payload shape — and where it stands
/// with the component TTL: expires when, already expired, or permanent
/// (including who spent the slot, from the same store the TTL gate reads).
/// Manage Server holders also get the permanent-slot toggle as a button on
/// the reply; [`component`] answers the click.
fn message_info(app: &App, interaction: &Value) -> Response {
    let Some(msg) = target_message(interaction) else {
        return ephemeral("Couldn't read the message from this interaction.");
    };
    let message_id = msg.get("id").and_then(Value::as_str).unwrap_or_default();
    let channel_id = msg
        .get("channel_id")
        .and_then(Value::as_str)
        .or_else(|| interaction.get("channel_id").and_then(Value::as_str))
        .unwrap_or_default();
    let guild_id = interaction.get("guild_id").and_then(Value::as_str);

    let mut lines = vec!["### Message Info".to_string()];

    // Author. A webhook message's author IS the webhook — its id and its
    // configured name; a <@mention> of it would render as an invalid user.
    let author_name = msg
        .pointer("/author/username")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let author_id = msg.pointer("/author/id").and_then(Value::as_str);
    let is_bot = msg
        .pointer("/author/bot")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let is_webhook = msg.get("webhook_id").and_then(Value::as_str).is_some();
    lines.push(match (is_webhook, author_id) {
        (true, Some(id)) => format!("**Author:** {author_name} (webhook `{id}`)"),
        (false, Some(id)) if is_bot => format!("**Author:** <@{id}> ({author_name}, bot)"),
        (false, Some(id)) => format!("**Author:** <@{id}> ({author_name})"),
        _ => format!("**Author:** {author_name}"),
    });

    // The send time rides in the id snowflake; the edit time only exists as
    // an ISO timestamp field.
    match snowflake_ms(message_id) {
        Some(sent_ms) => {
            let sent = sent_ms / 1000;
            lines.push(format!("**Sent:** <t:{sent}:f> (<t:{sent}:R>)"));
        }
        None => lines.push("**Sent:** unknown".into()),
    }
    if let Some(edited) = msg
        .get("edited_timestamp")
        .and_then(Value::as_str)
        .and_then(iso8601_unix_secs)
    {
        lines.push(format!("**Edited:** <t:{edited}:f> (<t:{edited}:R>)"));
    }
    lines.push(format!(
        "**Channel:** <#{channel_id}> · **Message ID:** `{message_id}`"
    ));

    let count = |key: &str| msg.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    let interactive = count_interactive(msg.get("components").unwrap_or(&Value::Null));
    let content_chars = msg
        .get("content")
        .and_then(Value::as_str)
        .map_or(0, |c| c.chars().count());
    let mut parts = Vec::new();
    if content_chars > 0 {
        parts.push(format!("{content_chars} chars of content"));
    }
    if count("components") > 0 {
        parts.push(format!(
            "{} ({interactive} interactive)",
            n_of(count("components"), "top-level component")
        ));
    }
    if count("embeds") > 0 {
        parts.push(n_of(count("embeds"), "embed"));
    }
    if count("attachments") > 0 {
        parts.push(n_of(count("attachments"), "attachment"));
    }
    lines.push(format!(
        "**Payload:** {}",
        if parts.is_empty() {
            "empty".into()
        } else {
            parts.join(" · ")
        }
    ));

    let flags = msg.get("flags").and_then(Value::as_u64).unwrap_or(0);
    let mut marks = Vec::new();
    if flags & FLAG_IS_COMPONENTS_V2 != 0 {
        marks.push("Components V2");
    }
    if flags & FLAG_SUPPRESS_NOTIFICATIONS != 0 {
        marks.push("silent");
    }
    if msg.get("pinned").and_then(Value::as_bool).unwrap_or(false) {
        marks.push("pinned");
    }
    if !marks.is_empty() {
        lines.push(format!("**Flags:** {}", marks.join(" · ")));
    }

    // Which plugins run this message — its custom_ids matched against the
    // same routing table clicks are forwarded by, so "listed here" and
    // "served by a plugin" are the same statement.
    let plugins = plugins_on_message(&app.routes, msg.get("components").unwrap_or(&Value::Null));
    if !plugins.is_empty() {
        lines.push(plugins_line(&plugins));
    }

    let permanent = app.store.permanent_details(message_id);
    lines.push(expiry_line(
        app,
        message_id,
        interactive,
        permanent.as_ref(),
    ));

    let permissions: u128 = interaction
        .pointer("/member/permissions")
        .and_then(Value::as_str)
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    let mut action_rows: Vec<Value> = Vec::new();

    // Slot usage + the toggle button, for guilds on a TTL'd deployment. The
    // button renders only for Manage Server holders ([`toggle_permanent`]
    // re-checks — a custom_id is client-forgeable), and only when there is
    // something to toggle: interactive components to keep alive, or this
    // guild's own slot to release.
    if let (Some(guild_id), Some(_)) = (guild_id, app.component_ttl_ms) {
        if let Ok(rows) = app.store.list(guild_id) {
            lines.push(slots_line(
                active_slots(&rows),
                app.permanent_cap_for(guild_id),
            ));
        }
        if permissions & MANAGE_GUILD != 0 && !message_id.is_empty() && !channel_id.is_empty() {
            let custom_id = format!("{PERM_TOGGLE_PREFIX}{channel_id}:{message_id}");
            if let Some(b) = toggle_button(guild_id, permanent.as_ref(), interactive, &custom_id) {
                action_rows.push(json!({ "type": TYPE_ACTION_ROW, "components": [b] }));
            }
        }
    }

    // Manage buttons for the plugins that serve a panel: guild messages only
    // (every plugin refuses DMs) and Manage Server holders only — a plugin
    // may also honor its own configured host roles, but the dispatcher can't
    // know them, and those hosts keep their existing way in (clicking the
    // plugin's own button). The plugin re-checks authority on click either
    // way; this gate is presentation, not security.
    if guild_id.is_some() && permissions & MANAGE_GUILD != 0 {
        let buttons = manage_buttons(&plugins);
        if !buttons.is_empty() {
            action_rows.push(json!({ "type": TYPE_ACTION_ROW, "components": buttons }));
        }
    }

    let text = lines.join("\n");
    if action_rows.is_empty() {
        return reply_sized(text)
            .unwrap_or_else(|| ephemeral("This message's details are too long to display."));
    }
    // Components V2: the info text is a Text Display, the buttons in action
    // rows beside it. The text is a handful of bounded lines, always inside
    // the budget — the buttoned shape never needs the oversize fallbacks.
    let mut components = vec![json!({ "type": TYPE_TEXT_DISPLAY, "content": text })];
    components.extend(action_rows);
    Json(json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": {
            "flags": FLAG_EPHEMERAL | FLAG_IS_COMPONENTS_V2,
            "components": components,
        }
    }))
    .into_response()
}

// ── Dispatcher-owned components ──────────────────────────────────────────────

/// Answer a click on one of the dispatcher's OWN components — custom_ids
/// under [`CUSTOM_ID_PREFIX`], intercepted by main.rs ahead of the plugin
/// routing. Today that is exactly one button: the permanent-slot toggle on a
/// "Message Info" reply. A successful toggle answers with UPDATE_MESSAGE,
/// rewriting the info reply in place ([`refresh_info_reply`]) instead of
/// stacking a confirmation under it; the new expiry line, slot count, and
/// button label all come from a fresh store read, so the reply stays
/// truthful even when the click raced another toggle.
pub fn component(app: &App, interaction: &Value) -> Response {
    let custom_id = interaction
        .pointer("/data/custom_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let target = custom_id
        .strip_prefix(PERM_TOGGLE_PREFIX)
        .and_then(|rest| rest.split_once(':'));
    let Some((channel_id, message_id)) = target else {
        tracing::warn!(custom_id, "unknown dispatcher-owned component");
        return ephemeral("This button isn't wired to anything.");
    };
    toggle_permanent(app, interaction, channel_id, message_id)
}

/// Spend one of the guild's TTL-exemption slots on the message — or give it
/// back when the message already holds one. The toggle runs against the same
/// SQLite store the TTL gate consults, in-process. Success refreshes the
/// info reply itself; only the can't-toggle cases (no permission, full,
/// another guild's slot, storage trouble) get a separate ephemeral note.
fn toggle_permanent(
    app: &App,
    interaction: &Value,
    channel_id: &str,
    message_id: &str,
) -> Response {
    let Some(guild_id) = interaction.get("guild_id").and_then(Value::as_str) else {
        return ephemeral("This only works inside a server.");
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
            "You need the **Manage Server** permission to manage which messages never expire.",
        );
    }
    if app.component_ttl_ms.is_none() {
        return ephemeral(
            "Components never expire on this deployment — there's nothing to toggle.",
        );
    }
    // The ids come from the custom_id, not the (signed) payload — shape-check
    // them like the /permanent API does before they touch the store.
    if !crate::is_snowflake(message_id) || !crate::is_snowflake(channel_id) {
        return ephemeral("This button isn't wired to anything.");
    }

    if app.store.is_permanent(message_id) {
        // Guild-scoped remove: a permanent message of another guild is
        // unreachable from here, exactly like the dashboard path.
        return match app.store.remove(guild_id, message_id) {
            Ok(true) => refresh_info_reply(app, interaction, guild_id, message_id),
            Ok(false) => ephemeral("That message's never-expire slot belongs to another server."),
            Err(err) => storage_error(err),
        };
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
        app.permanent_cap_for(guild_id),
    ) {
        // Newly permanent: revive anything the TTL gate disabled while the
        // message was expiring. The dispatcher can't edit the posted message
        // itself, so this hands the job to the proxy (best-effort, off this
        // response path) — see `App::trigger_reenable`.
        Ok(crate::store::Add::Added) => {
            app.trigger_reenable(guild_id, channel_id, message_id);
            refresh_info_reply(app, interaction, guild_id, message_id)
        }
        // `Already` only happens on a toggle race: the message was already
        // permanent, so it was never disabled — nothing to revive.
        Ok(crate::store::Add::Already) => {
            refresh_info_reply(app, interaction, guild_id, message_id)
        }
        Ok(crate::store::Add::Full) => ephemeral(&format!(
            "Every never-expire slot is taken.{} Release one from a never-expire message's \
             **Message Info** button, or from the dashboard's *Message directory → Posted* tab.",
            usage_suffix(app, guild_id)
        )),
        Err(err) => storage_error(err),
    }
}

/// Rewrite the "Message Info" reply the clicked toggle sits on, as the
/// UPDATE_MESSAGE answer to the click. Only what the toggle changed is
/// patched — the **Expiry:** line, the slots-used line, and the button —
/// each rebuilt from a fresh store read; the rest of the text (author,
/// timestamps, payload shape) survives verbatim, since a component
/// interaction doesn't carry the resolved target message it was built from.
fn refresh_info_reply(
    app: &App,
    interaction: &Value,
    guild_id: &str,
    message_id: &str,
) -> Response {
    let permanent = app.store.permanent_details(message_id);
    // The reply is Components V2, so its text lives in the leading Text
    // Display, not the message's (now empty) `content`. If it's somehow
    // missing, confirm plainly rather than failing the click.
    let Some(text) = info_reply_text(interaction) else {
        return ephemeral(&format!(
            "{}{}",
            if permanent.is_some() {
                "\u{1F512} This message now never expires."
            } else {
                "\u{1F513} This message will expire again."
            },
            usage_suffix(app, guild_id)
        ));
    };
    let interactive = interactive_from_content(text);
    let expiry = expiry_line(app, message_id, interactive, permanent.as_ref());
    let slots = app
        .store
        .list(guild_id)
        .map(|rows| slots_line(active_slots(&rows), app.permanent_cap_for(guild_id)))
        .ok();
    let patched: Vec<&str> = text
        .lines()
        .map(|line| {
            if line.starts_with("**Expiry:**") {
                expiry.as_str()
            } else if line.ends_with("never-expire slots used in this server.") {
                slots.as_deref().unwrap_or(line)
            } else {
                line
            }
        })
        .collect();
    let custom_id = interaction
        .pointer("/data/custom_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // Rebuild the V2 tree: the patched Text Display, plus the toggle's action
    // row when there's still something to toggle. Every OTHER action row on
    // the reply (the plugin manage buttons) survives verbatim — only the
    // toggle's own row is rebuilt. The message keeps its V2 flag across an
    // UPDATE_MESSAGE, so the components alone carry the edit.
    let mut components = vec![json!({ "type": TYPE_TEXT_DISPLAY, "content": patched.join("\n") })];
    if let Some(b) = toggle_button(guild_id, permanent.as_ref(), interactive, custom_id) {
        components.push(json!({ "type": TYPE_ACTION_ROW, "components": [b] }));
    }
    components.extend(other_action_rows(interaction, custom_id));
    Json(json!({
        "type": RESPONSE_UPDATE_MESSAGE,
        "data": { "components": components }
    }))
    .into_response()
}

/// Every action row on the reply the click sits on EXCEPT the one holding
/// `clicked_id` — what [`refresh_info_reply`] must carry over verbatim while
/// it rebuilds the clicked toggle's row from a fresh store read.
fn other_action_rows(interaction: &Value, clicked_id: &str) -> Vec<Value> {
    interaction
        .pointer("/message/components")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| c.get("type").and_then(Value::as_u64) == Some(TYPE_ACTION_ROW))
        .filter(|row| {
            !row.get("components")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|b| b.get("custom_id").and_then(Value::as_str) == Some(clicked_id))
        })
        .cloned()
        .collect()
}

/// The "Message Info" text, read back from the V2 reply the toggle sits on:
/// the content of its leading Text Display ([`message_info`] always puts the
/// text there). `None` if no Text Display is present.
fn info_reply_text(interaction: &Value) -> Option<&str> {
    interaction
        .pointer("/message/components")?
        .as_array()?
        .iter()
        .find(|c| c.get("type").and_then(Value::as_u64) == Some(TYPE_TEXT_DISPLAY))
        .and_then(|c| c.get("content").and_then(Value::as_str))
}

/// The interactive-component count, recovered from the info reply's own
/// `**Payload:** … (N interactive) …` line — it only decides which button
/// (if any) the refreshed reply gets. No match means [`message_info`]
/// counted zero when it built the reply.
fn interactive_from_content(content: &str) -> usize {
    content
        .lines()
        .find_map(|line| line.strip_prefix("**Payload:**"))
        .and_then(|line| {
            let head = &line[..line.find(" interactive)")?];
            head[head.rfind('(')? + 1..].parse().ok()
        })
        .unwrap_or(0)
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

// ── Message Info plumbing ────────────────────────────────────────────────────

/// The `**Expiry:**` line, in the order the TTL gate would decide it: a
/// permanent grant trumps everything (it occupies a slot even on a
/// deployment that later disabled the TTL), then the deployment setting,
/// then the clock. Shared by the initial reply and the post-toggle refresh.
fn expiry_line(
    app: &App,
    message_id: &str,
    interactive: usize,
    permanent: Option<&PermanentDetails>,
) -> String {
    match (permanent, app.component_ttl_ms) {
        (Some(details), _) => format!(
            "**Expiry:** \u{1F512} never expires — components stay clickable. \
             Slot granted by <@{}> <t:{}:R>.",
            details.added_by,
            details.added_at / 1000
        ),
        (None, None) => "**Expiry:** components never expire on this deployment.".into(),
        (None, Some(_)) if interactive == 0 => {
            "**Expiry:** no interactive components — nothing here expires.".into()
        }
        (None, Some(ttl_ms)) => match snowflake_ms(message_id) {
            Some(sent_ms) => {
                // The window is sliding, so expiry anchors to the LATER of the
                // send time and the last recorded use — the same arithmetic
                // the TTL gate applies (`expired_by_ttl` in main.rs).
                let anchor = app
                    .store
                    .last_activity_ms(message_id)
                    .map_or(sent_ms, |seen| seen.max(sent_ms));
                let expires = (anchor + ttl_ms) / 1000;
                if now_ms() > anchor + ttl_ms {
                    format!(
                        "**Expiry:** \u{231B} interactive components **expired** <t:{expires}:R> \
                         — each click now just disables its component. \
                         Make it never-expire to switch them back on."
                    )
                } else {
                    format!(
                        "**Expiry:** \u{23F3} interactive components expire \
                         <t:{expires}:f> (<t:{expires}:R>) — every use restarts \
                         the {}-day timer.",
                        ttl_ms / 86_400_000
                    )
                }
            }
            None => "**Expiry:** unknown.".into(),
        },
    }
}

/// The slots-used subtext. [`refresh_info_reply`] finds this line again by
/// its tail — keep the wording in sync with the match there.
fn slots_line(used: usize, total: u32) -> String {
    format!("-# {used}/{total} never-expire slots used in this server.")
}

/// Active grants only — suspended (over-plan-cap) rows don't consume quota in
/// the store, so counting them here would show "5/2 used" after a downgrade
/// and disagree with what [`store::Store::add`] actually enforces. Matches the
/// `used` field the /permanent management API reports.
fn active_slots(rows: &[crate::store::PermanentRow]) -> usize {
    rows.iter().filter(|r| !r.suspended).count()
}

/// The permanent-slot toggle button matching the store's current state, or
/// `None` when there is nothing for this guild to toggle: another guild owns
/// the slot, or no slot is held and nothing interactive would outlive the
/// TTL. The caller has already checked Manage Server and the deployment TTL.
fn toggle_button(
    guild_id: &str,
    permanent: Option<&PermanentDetails>,
    interactive: usize,
    custom_id: &str,
) -> Option<Value> {
    match permanent {
        Some(details) if details.guild_id == guild_id => Some(json!({
            "type": TYPE_BUTTON,
            "style": BUTTON_DANGER,
            "label": "Let it expire",
            "custom_id": custom_id,
        })),
        // Another guild's slot — not ours to release.
        Some(_) => None,
        None if interactive > 0 => Some(json!({
            "type": TYPE_BUTTON,
            "style": BUTTON_PRIMARY,
            "label": "Never expire",
            "custom_id": custom_id,
        })),
        None => None,
    }
}

/// When a message was sent, in unix milliseconds, from its snowflake id.
fn snowflake_ms(id: &str) -> Option<u64> {
    id.parse::<u64>()
        .ok()
        .map(|n| (n >> 22) + crate::DISCORD_EPOCH_MS)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `1 embed` / `2 embeds`.
fn n_of(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

/// How many components on the message can still fire an interaction — every
/// node carrying a `custom_id`, found with the same walk main.rs disables
/// them with (children under `components`, a section's button under
/// `accessory`). Link buttons carry `url` instead, so they don't count —
/// correctly, since they never expire either.
fn count_interactive(node: &Value) -> usize {
    match node {
        Value::Array(items) => items.iter().map(count_interactive).sum(),
        Value::Object(map) => {
            usize::from(map.contains_key("custom_id"))
                + map.get("components").map_or(0, count_interactive)
                + map.get("accessory").map_or(0, count_interactive)
        }
        _ => 0,
    }
}

// ── Plugins on the message ───────────────────────────────────────────────────

/// The routed plugins present on a message, in component order: the matched
/// routing prefix, plus the instance id when the custom_id is a *bound*
/// binding — `<prefix><id>`, bare, no verb, the only shape the editor ever
/// attaches to a posted message (panel controls carry a `<verb>:` and live on
/// ephemeral replies). A verb-carrying or empty tail still names the plugin
/// in the info line, it just can't be managed (`None`). Deduplicated; expects
/// `routes` longest-prefix-first, as main.rs sorts it.
fn plugins_on_message<'a>(
    routes: &'a [(String, String)],
    components: &'a Value,
) -> Vec<(&'a str, Option<&'a str>)> {
    // The same walk `count_interactive` does: children under `components`, a
    // section's button under `accessory`.
    fn collect<'a>(node: &'a Value, out: &mut Vec<&'a str>) {
        match node {
            Value::Array(items) => items.iter().for_each(|item| collect(item, out)),
            Value::Object(map) => {
                if let Some(id) = map.get("custom_id").and_then(Value::as_str) {
                    out.push(id);
                }
                if let Some(children) = map.get("components") {
                    collect(children, out);
                }
                if let Some(accessory) = map.get("accessory") {
                    collect(accessory, out);
                }
            }
            _ => {}
        }
    }
    let mut ids = Vec::new();
    collect(components, &mut ids);
    let mut found: Vec<(&str, Option<&str>)> = Vec::new();
    for id in ids {
        let Some((prefix, _)) = routes.iter().find(|(p, _)| id.starts_with(p.as_str())) else {
            continue;
        };
        let tail = &id[prefix.len()..];
        let instance = (!tail.is_empty() && !tail.contains(':')).then_some(tail);
        let entry = (prefix.as_str(), instance);
        if !found.contains(&entry) {
            found.push(entry);
        }
    }
    found
}

/// The `**Plugins:**` line: every routed plugin on the message, named once by
/// its routing prefix. Purely informative — visible to everyone, since the
/// custom_ids it reads are already in every viewer's client.
fn plugins_line(plugins: &[(&str, Option<&str>)]) -> String {
    let mut names: Vec<&str> = Vec::new();
    for (prefix, _) in plugins {
        let name = prefix.trim_end_matches(':');
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let list: Vec<String> = names.iter().map(|n| format!("`{n}`")).collect();
    format!("**Plugins:** {}", list.join(" · "))
}

/// One "Manage <plugin>" button per detected instance of a manage-capable
/// plugin ([`MANAGEABLE_PLUGINS`]), capped at one action row. The custom_id
/// hands the click to the plugin's own `manage:` verb through the ordinary
/// prefix forwarding — the plugin re-checks authority, so these buttons are
/// discovery, not the gate. Labels number up only when one plugin appears
/// more than once on the message.
fn manage_buttons(plugins: &[(&str, Option<&str>)]) -> Vec<Value> {
    /// Discord caps an action row at five buttons and a custom_id at 100
    /// chars; an instance past either simply doesn't get a button (it stays
    /// manageable the in-situ way).
    const MAX_BUTTONS: usize = 5;
    const MAX_CUSTOM_ID: usize = 100;
    let mut buttons = Vec::new();
    for (prefix, label) in MANAGEABLE_PLUGINS {
        let instances: Vec<&str> = plugins
            .iter()
            .filter(|(p, _)| *p == prefix)
            .filter_map(|(_, instance)| *instance)
            .collect();
        for (n, instance) in instances.iter().enumerate() {
            let custom_id = format!("{prefix}manage:{instance}");
            if custom_id.len() > MAX_CUSTOM_ID {
                continue;
            }
            let text = if instances.len() == 1 {
                format!("Manage {label}")
            } else {
                format!("Manage {label} #{}", n + 1)
            };
            buttons.push(json!({
                "type": TYPE_BUTTON,
                "style": BUTTON_SECONDARY,
                "label": text,
                "custom_id": custom_id,
            }));
        }
    }
    buttons.truncate(MAX_BUTTONS);
    buttons
}

/// Unix seconds of an ISO 8601 timestamp the way Discord writes them
/// (`2026-06-12T03:14:15.926000+00:00`). Seconds precision, trailing offset
/// honored; `None` on anything malformed — the caller then omits the line.
/// (Hand-rolled days-from-civil-date so one display field doesn't pull a
/// date crate into the image.)
fn iso8601_unix_secs(ts: &str) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| -> Option<i64> { ts.get(range)?.parse().ok() };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let shifted_year = year - i64::from(month <= 2);
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146_097 + day_of_era - 719_468;
    let mut secs = days_since_epoch * 86_400 + hour * 3600 + minute * 60 + second;
    // Past the seconds sit optional fractions, then 'Z' or ±HH:MM.
    if let Some(tail) = ts.get(19..) {
        if let Some(idx) = tail.find(['+', '-']) {
            let offset = &tail[idx..];
            let sign = if offset.starts_with('+') { 1 } else { -1 };
            let hours: i64 = offset.get(1..3)?.parse().ok()?;
            let minutes: i64 = offset.get(4..6)?.parse().ok()?;
            secs -= sign * (hours * 3600 + minutes * 60);
        }
    }
    Some(secs)
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

/// Thread channel types (announcement, public, private). A message in one of
/// these lives in the thread itself, so reading or updating it through a
/// webhook must pass the thread id as `thread_id` — the webhook is bound to
/// the parent channel.
const CHANNEL_THREAD_TYPES: [u64; 3] = [10, 11, 12];

/// The non-secret origin of an "Edit in DWEEB" link, as `&g=[&w=&m=[&t=]]`
/// params. Every id here is already visible to anyone who can read the message:
///   - `g` (guild) — present for any guild message; lets the editor switch to
///     that server and load its roles/channels/emojis so mentions resolve.
///   - `w`/`m` (webhook + message) — only for webhook messages, which are the
///     only ones editable in place; with `t` (thread) when it's threaded.
///
/// The webhook *token*, the one secret needed to PATCH, never travels: the
/// editor resolves it from the browser's own saved webhooks, keyed by `w`.
/// Returns "" for a DM message no webhook posted (nothing to target or update).
fn origin_params(interaction: &Value, msg: &Value) -> String {
    let mut params = String::new();
    if let Some(guild_id) = interaction.get("guild_id").and_then(Value::as_str) {
        params.push_str(&format!("&g={guild_id}"));
    }
    if let (Some(webhook_id), Some(message_id)) = (
        msg.get("webhook_id").and_then(Value::as_str),
        msg.get("id").and_then(Value::as_str),
    ) {
        params.push_str(&format!("&w={webhook_id}&m={message_id}"));
        // A threaded message's channel *is* the thread; its id doubles as the
        // thread_id GET/PATCH need.
        let in_thread = interaction
            .pointer("/channel/type")
            .and_then(Value::as_u64)
            .is_some_and(|t| CHANNEL_THREAD_TYPES.contains(&t));
        if in_thread {
            if let Some(thread_id) = msg
                .get("channel_id")
                .and_then(Value::as_str)
                .or_else(|| interaction.get("channel_id").and_then(Value::as_str))
            {
                params.push_str(&format!("&t={thread_id}"));
            }
        }
    }
    params
}

/// Encode a wire payload as a share token: JSON → LZ-String (URI-safe) →
/// `v{N}.<body>`, byte-identical to what the frontend's `encodeShare` emits.
/// The frontend reads the hash through `URLSearchParams`, which decodes `+`
/// as a space — so `+` (and `$`, matching what URLSearchParams itself emits)
/// is percent-escaped; the rest of LZ-String's URI-safe alphabet survives
/// as-is.
pub(crate) fn share_token(payload: &Value) -> String {
    token_for_hash(&share_token_raw(payload))
}

/// The raw share token: `<version>.<lz-string URI-safe body>`, byte-identical
/// to what the frontend's `encodeShare` emits. This is the form the short-link
/// service stores and validates — its `is_share_token` accepts lz-string's
/// `+ - $` alphabet but NOT the `%`-escapes [`token_for_hash`] introduces, so
/// short links MUST be created from this raw token, not the hash form.
pub(crate) fn share_token_raw(payload: &Value) -> String {
    let json = serde_json::to_string(payload).unwrap_or_default();
    let compressed = lz_str::compress_to_encoded_uri_component(json.as_str());
    format!("{SHARE_VERSION}.{compressed}")
}

/// A raw token, percent-escaped for embedding in a `#s=` hash: the frontend
/// reads the hash through `URLSearchParams`, which would turn `+` into a space
/// and re-encode `$`. The rest of lz-string's URI-safe alphabet survives as-is.
fn token_for_hash(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 16);
    for ch in raw.chars() {
        match ch {
            '+' => out.push_str("%2B"),
            '$' => out.push_str("%24"),
            c => out.push(c),
        }
    }
    out
}

// ── Reply plumbing ───────────────────────────────────────────────────────────

/// Ephemeral reply sized to Discord's limit: a Components V2 Text Display
/// holds up to 4000 chars (`ephemeral` builds it), `None` beyond that.
fn reply_sized(text: String) -> Option<Response> {
    (text.chars().count() <= MAX_V2_TEXT).then(|| ephemeral(&text))
}

/// Fallback when the message is too big to embed inline: mint a DWEEB short
/// link (the proxy stores the full token, auto-expiring), and reply with the
/// tiny `/s/<id>` URL. The origin params still ride in its `#fragment`, so
/// update-in-place and server targeting survive the round trip. If the proxy is
/// unreachable or the token exceeds its size cap, degrade to a plain note.
async fn too_large(app: &App, raw_token: &str, origin: &str) -> Response {
    if let Some(id) = create_short_link(app, raw_token).await {
        let url = format!("{}/s/{id}{}", app.dashboard_url, origin_fragment(origin));
        let text = format!(
            "\u{1F4DD} **[Open this message in the DWEEB editor](<{url}>)**\n\
             -# Too large to fit inline, so it's a one-tap short link — it expires in 7 days."
        );
        if let Some(response) = reply_sized(text) {
            return response;
        }
    }
    ephemeral(
        "This message is too large to open from here, and the short-link service \
         isn't reachable right now — try again shortly.",
    )
}

/// Turn an [`origin_params`] string (`&k=v…`, built to append after a
/// `#s=<token>`) into a standalone URL fragment (`#k=v…`) for a short link,
/// which carries no `#` of its own. Empty in, empty out.
fn origin_fragment(origin: &str) -> String {
    origin
        .strip_prefix('&')
        .map_or(String::new(), |rest| format!("#{rest}"))
}

/// POST a **raw** share token (see [`share_token_raw`] — the escaped hash form
/// fails the service's `is_share_token` check on its `%`) to the proxy's
/// short-link service; returns the minted id. `None` on any failure
/// (unreachable, non-2xx, malformed body) so the caller can fall back — short
/// links are a convenience, never load-bearing.
async fn create_short_link(app: &App, raw_token: &str) -> Option<String> {
    let resp = app
        .client
        .post(&app.shortlink_api)
        .json(&json!({ "token": raw_token }))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        tracing::warn!(status = %resp.status(), "shortlink create failed");
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    body.get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn usage_suffix(app: &App, guild_id: &str) -> String {
    match app.store.list(guild_id) {
        Ok(rows) => format!(
            " ({}/{} slots used.)",
            active_slots(&rows),
            app.permanent_cap_for(guild_id)
        ),
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
    fn raw_token_is_what_the_shortlink_service_accepts() {
        // The proxy's `is_share_token`, mirrored: `<digits>.<alnum + - $>`. The
        // escaped hash form carries `%` (from %2B/%24) and fails it — so short
        // links must POST the RAW token. Regression guard for the 400 we hit.
        fn is_share_token(s: &str) -> bool {
            let Some((version, body)) = s.split_once('.') else {
                return false;
            };
            !version.is_empty()
                && version.bytes().all(|b| b.is_ascii_digit())
                && !body.is_empty()
                && body
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'$'))
        }
        // Content with `$` and `+` so the compressed body is likely to use them.
        let payload = json!({
            "username": "Hook $ +",
            "components": [{ "type": 10, "content": "hello **world** $1 + $2 ".repeat(8) }],
            "flags": 32768,
        });
        let raw = share_token_raw(&payload);
        assert!(
            !raw.contains('%'),
            "raw token must not be percent-escaped: {raw}"
        );
        assert!(
            is_share_token(&raw),
            "raw token must pass the short-link service's validation: {raw}"
        );
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
    fn origin_params_carry_guild_webhook_and_message_ids() {
        // A non-threaded guild channel: guild + webhook + message, no thread_id.
        let interaction =
            json!({ "guild_id": "5", "channel_id": "100", "channel": { "id": "100", "type": 0 } });
        let msg = json!({ "id": "55", "channel_id": "100", "webhook_id": "900" });
        assert_eq!(origin_params(&interaction, &msg), "&g=5&w=900&m=55");
    }

    #[test]
    fn origin_params_add_thread_id_in_threads() {
        // A public thread (type 11): the message's channel id rides as thread_id.
        let interaction =
            json!({ "guild_id": "5", "channel_id": "200", "channel": { "id": "200", "type": 11 } });
        let msg = json!({ "id": "55", "channel_id": "200", "webhook_id": "900" });
        assert_eq!(origin_params(&interaction, &msg), "&g=5&w=900&m=55&t=200");
    }

    #[test]
    fn origin_params_guild_only_for_non_webhook_message() {
        // A user/bot message carries the guild (so the editor can target the
        // server) but no webhook origin — it can't be updated in place.
        let interaction =
            json!({ "guild_id": "5", "channel_id": "100", "channel": { "id": "100", "type": 0 } });
        let msg = json!({ "id": "55", "channel_id": "100", "author": { "id": "7" } });
        assert_eq!(origin_params(&interaction, &msg), "&g=5");
    }

    #[test]
    fn origin_params_empty_in_dm_for_non_webhook_message() {
        // No guild_id (a DM) and no webhook — nothing to target or update.
        let interaction = json!({ "channel_id": "100" });
        let msg = json!({ "id": "55", "channel_id": "100", "author": { "id": "7" } });
        assert_eq!(origin_params(&interaction, &msg), "");
    }

    #[test]
    fn origin_fragment_starts_a_fragment() {
        // The short-link URL has no `#`, so the leading `&` becomes one.
        assert_eq!(origin_fragment("&g=5&w=9&m=55"), "#g=5&w=9&m=55");
        // Nothing to carry → no fragment at all.
        assert_eq!(origin_fragment(""), "");
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
    fn interactive_components_are_counted_through_nesting() {
        let components = json!([
            { "type": 17, "components": [
                { "type": 9,
                  "components": [{ "type": 10, "content": "hi" }],
                  "accessory": { "type": 2, "style": 1, "custom_id": "a:b" } },
                { "type": 1, "components": [
                    { "type": 2, "style": 5, "url": "https://example.com", "label": "Link" },
                    { "type": 2, "style": 1, "custom_id": "x:y" },
                ]},
            ]},
        ]);
        // The two custom_id holders count; the link button and text don't.
        assert_eq!(count_interactive(&components), 2);
        assert_eq!(count_interactive(&Value::Null), 0);
    }

    // ── plugins on the message ───────────────────────────────────────────────

    /// A routing table like main.rs builds: longest prefix first.
    fn routes() -> Vec<(String, String)> {
        [
            ("quickreplies:", "http://quick-replies:8096"),
            ("giveaway:", "http://giveaway:8094"),
            ("poll:", "http://poll:8098"),
        ]
        .map(|(p, b)| (p.to_string(), b.to_string()))
        .to_vec()
    }

    #[test]
    fn plugins_are_detected_through_nesting_and_deduplicated() {
        let components = json!([
            { "type": 17, "components": [
                { "type": 9,
                  "components": [{ "type": 10, "content": "hi" }],
                  "accessory": { "type": 2, "style": 1, "custom_id": "giveaway:g1" } },
                { "type": 1, "components": [
                    { "type": 2, "style": 5, "url": "https://example.com", "label": "Link" },
                    { "type": 3, "custom_id": "poll:p1", "options": [] },
                    // A repeat of the same binding collapses to one entry.
                    { "type": 2, "style": 1, "custom_id": "poll:p1" },
                ]},
            ]},
            // Unrouted namespaces — the dispatcher's own and a stranger's —
            // never make the list.
            { "type": 1, "components": [
                { "type": 2, "style": 1, "custom_id": "dweeb:perm:1:2" },
                { "type": 2, "style": 1, "custom_id": "mystery:x" },
            ]},
        ]);
        assert_eq!(
            plugins_on_message(&routes(), &components),
            vec![("giveaway:", Some("g1")), ("poll:", Some("p1"))]
        );
    }

    #[test]
    fn verb_carrying_ids_name_the_plugin_but_yield_no_instance() {
        // A panel-control shape on a message (never posted by the editor, but
        // custom apps can build anything): the plugin is named, not managed.
        let components = json!([
            { "type": 1, "components": [
                { "type": 2, "style": 1, "custom_id": "giveaway:draw:g1" },
                { "type": 2, "style": 1, "custom_id": "quickreplies:" },
            ]},
        ]);
        assert_eq!(
            plugins_on_message(&routes(), &components),
            vec![("giveaway:", None), ("quickreplies:", None)]
        );
        assert!(manage_buttons(&plugins_on_message(&routes(), &components)).is_empty());
    }

    #[test]
    fn plugins_line_names_each_plugin_once() {
        assert_eq!(
            plugins_line(&[
                ("giveaway:", Some("g1")),
                ("giveaway:", Some("g2")),
                ("poll:", None),
            ]),
            "**Plugins:** `giveaway` · `poll`"
        );
    }

    #[test]
    fn manage_buttons_route_into_the_plugins_own_namespace() {
        let buttons = manage_buttons(&[
            ("giveaway:", Some("g1")),
            ("poll:", Some("p1")),
            // Routed but not manage-capable — no button, no dead click.
            ("quickreplies:", Some("q1")),
        ]);
        assert_eq!(buttons.len(), 2);
        assert_eq!(buttons[0]["custom_id"], "giveaway:manage:g1");
        assert_eq!(buttons[0]["label"], "Manage giveaway");
        assert_eq!(buttons[1]["custom_id"], "poll:manage:p1");
        assert_eq!(buttons[1]["label"], "Manage poll");
    }

    #[test]
    fn duplicate_instances_get_numbered_labels_and_the_row_stays_capped() {
        let plugins: Vec<(&str, Option<&str>)> = vec![
            ("giveaway:", Some("g1")),
            ("giveaway:", Some("g2")),
            ("poll:", Some("p1")),
            ("poll:", Some("p2")),
            ("poll:", Some("p3")),
            ("poll:", Some("p4")),
        ];
        let buttons = manage_buttons(&plugins);
        // Discord's per-row cap: five buttons, in detection order.
        assert_eq!(buttons.len(), 5);
        assert_eq!(buttons[0]["label"], "Manage giveaway #1");
        assert_eq!(buttons[1]["label"], "Manage giveaway #2");
        assert_eq!(buttons[2]["label"], "Manage poll #1");
    }

    #[test]
    fn an_instance_too_long_for_a_custom_id_is_skipped() {
        let long = "x".repeat(95);
        let buttons = manage_buttons(&[("giveaway:", Some(long.as_str()))]);
        // "giveaway:manage:" + 95 chars would exceed Discord's 100-char cap.
        assert!(buttons.is_empty());
    }

    #[test]
    fn other_action_rows_keeps_everything_but_the_clicked_row() {
        let interaction = json!({
            "data": { "custom_id": "dweeb:perm:1:2" },
            "message": { "components": [
                { "type": 10, "content": "### Message Info" },
                { "type": 1, "components": [
                    { "type": 2, "style": 1, "custom_id": "dweeb:perm:1:2", "label": "Never expire" },
                ]},
                { "type": 1, "components": [
                    { "type": 2, "style": 2, "custom_id": "giveaway:manage:g1", "label": "Manage giveaway" },
                ]},
            ]}
        });
        let kept = other_action_rows(&interaction, "dweeb:perm:1:2");
        // The manage row survives; the toggle's own row (rebuilt fresh by the
        // caller) and the Text Display do not.
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["components"][0]["custom_id"], "giveaway:manage:g1");
    }

    #[test]
    fn interactive_count_recovers_from_payload_line() {
        let content = "### Message Info\n\
                       **Author:** someone\n\
                       **Payload:** 12 chars of content · \
                       2 top-level components (3 interactive) · 1 embed\n\
                       **Expiry:** \u{23F3} interactive components expire soon.";
        assert_eq!(interactive_from_content(content), 3);
        // No components on the message → no "(N interactive)" in the line.
        assert_eq!(interactive_from_content("**Payload:** empty"), 0);
        assert_eq!(interactive_from_content("no payload line at all"), 0);
    }

    #[test]
    fn iso8601_parses_discord_timestamps() {
        assert_eq!(iso8601_unix_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            iso8601_unix_secs("2024-01-01T00:00:00.123000+00:00"),
            Some(1_704_067_200)
        );
        // A positive offset shifts the instant back toward UTC.
        assert_eq!(
            iso8601_unix_secs("2024-01-01T02:30:00+02:30"),
            Some(1_704_067_200)
        );
        assert_eq!(iso8601_unix_secs("not a timestamp"), None);
        assert_eq!(iso8601_unix_secs(""), None);
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
