//! The tools the remote MCP server exposes.
//!
//! Every tool that touches Discord acts **as the person who authorized the
//! connector**, never with ambient bot authority. The OAuth grant carries their
//! Discord access token; each call rebuilds a `Session` from it and goes
//! through the same gates the web app and the Activity already use —
//! `authorize_member_session` for reads, `authorize_activity_webhooks` (Manage
//! Webhooks) for anything that posts. So a caller reaches exactly the servers
//! and channels the user could reach by hand, and no more. That is the whole
//! security model, and it is why the tool list is expressed in *servers and
//! channels* rather than in webhook URLs: there is no credential for a caller
//! to hold, mislay, or point somewhere unintended.
//!
//! Three conventions, shared with the local stdio server:
//!  1. Arguments are validated against the published `inputSchema`.
//!  2. Every result carries `ok`, so a failure still satisfies `outputSchema`.
//!  3. Failure is data (`isError: true`), not a protocol error — the model
//!     reading it is the one who can fix it. Only a bug returns an error.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use serde_json::{json, Map, Value};

use crate::error::AppError;
use crate::routes::{
    authorize_activity_webhooks, bot_guild_set, ensure_channel_in_guild, fetch_channels,
    is_snowflake, member_guilds, AppState,
};
use crate::session::Session;

use super::catalog;
use super::components::{self, Severity};
use super::render;
use super::store::TokenIdentity;

/// What a tool hands back. Mirrors MCP's `CallToolResult`.
#[derive(Debug)]
pub struct ToolOutcome {
    pub text: String,
    pub structured: Value,
    pub is_error: bool,
}

fn ok(text: impl Into<String>, mut structured: Value) -> ToolOutcome {
    if let Some(map) = structured.as_object_mut() {
        map.insert("ok".into(), Value::Bool(true));
    }
    ToolOutcome {
        text: text.into(),
        structured,
        is_error: false,
    }
}

fn fail(text: impl Into<String>) -> ToolOutcome {
    let text = text.into();
    ToolOutcome {
        structured: json!({ "ok": false, "error": text }),
        text,
        is_error: true,
    }
}

/// The catalogue of tools, as `tools/list` reports them.
pub fn descriptors() -> Vec<Value> {
    vec![
        tool(
            "describe_schema",
            "Components V2 authoring guide",
            "The rules for building a Discord Components V2 message: every component type and its \
             fields, the hard limits, and the mistakes Discord rejects the whole message for. Read \
             this before writing a message by hand.",
            json!({ "type": "object", "properties": {
                "section": { "type": "string", "enum": ["all", "guide", "limits"],
                             "description": "`guide` for the prose, `limits` for the numeric caps, `all` for both." }
            }, "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" },
                "guide": { "type": "string" }, "limits": { "type": "object" }
            }, "required": ["ok"] }),
            true,
            false,
        ),
        tool(
            "list_templates",
            "List built-in templates",
            "DWEEB's built-in message templates — complete, valid Components V2 messages for common \
             jobs (welcome, announcement, rules, tickets, giveaway, role pickers…). Starting from one \
             is faster and safer than writing a message from scratch.",
            json!({ "type": "object", "properties": {
                "category": { "type": "string", "description": "Restrict to one gallery section." },
                "search": { "type": "string", "description": "Match name, description, tags, and the template's own message text." }
            }, "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" },
                "templates": { "type": "array" }, "count": { "type": "integer" }
            }, "required": ["ok"] }),
            true,
            false,
        ),
        tool(
            "get_template",
            "Get a template's message",
            "The full Components V2 payload behind one template, ready to edit and send, with an \
             outline of how it renders and its validation report.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "Template id from `list_templates`." }
            }, "required": ["id"], "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" },
                "template": { "type": "object" }, "message": { "type": "object" },
                "outline": { "type": "string" }, "report": { "type": "object" }
            }, "required": ["ok"] }),
            true,
            false,
        ),
        tool(
            "validate_message",
            "Validate a message",
            "Run Discord's rules over a message before Discord does. Reports every problem that would \
             make Discord reject the whole message, every setting it would silently ignore, and what \
             the destination has to be — each named by its path in the payload.",
            json!({ "type": "object", "properties": {
                "message": { "type": "object", "description": "The Components V2 message payload." },
                "thread_id": { "type": "string", "description": "Snowflake of an existing thread you intend to post into." }
            }, "required": ["message"], "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" }, "report": { "type": "object" }
            }, "required": ["ok"] }),
            true,
            false,
        ),
        tool(
            "preview_message",
            "Preview a message",
            "Re-state a message as the layout a reader sees: one line per component, indented by \
             nesting, with text, media, and each button's target inline. The fastest way to catch a \
             component nested in the wrong place.",
            json!({ "type": "object", "properties": {
                "message": { "type": "object" }
            }, "required": ["message"], "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" },
                "outline": { "type": "string" }, "stats": { "type": "object" }
            }, "required": ["ok"] }),
            true,
            false,
        ),
        tool(
            "create_share_link",
            "Create a DWEEB share link",
            "Turn a message into a link that opens it in DWEEB's visual editor. This is how a person \
             reviews what you built — prefer handing over the link to describing the message in prose. \
             The link is stored for 7 days and then deleted.",
            json!({ "type": "object", "properties": {
                "message": { "type": "object" }
            }, "required": ["message"], "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" }, "url": { "type": "string" }
            }, "required": ["ok"] }),
            false,
            true,
        ),
        tool(
            "list_servers",
            "List your Discord servers",
            "The Discord servers you can post to through DWEEB, with whether the DWEEB bot is present \
             and whether you hold Manage Webhooks there. Posting needs both.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" },
                "servers": { "type": "array" }, "count": { "type": "integer" }
            }, "required": ["ok"] }),
            true,
            true,
        ),
        tool(
            "list_channels",
            "List a server's channels",
            "The channels in one server that a message can be posted to, with the type of each — \
             which matters, because a forum or media channel needs the message to carry a post title \
             (`thread_name`) and every other kind rejects one.",
            json!({ "type": "object", "properties": {
                "server_id": { "type": "string", "description": "Server id from `list_servers`." }
            }, "required": ["server_id"], "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" },
                "channels": { "type": "array" }, "count": { "type": "integer" }
            }, "required": ["ok"] }),
            true,
            true,
        ),
        tool(
            "send_message",
            "Post a message to Discord",
            "Post a message to a channel. It is validated first and refused outright if Discord would \
             reject it, so a failure here costs nothing. Returns the new message's id and a link — keep \
             the id to edit or delete it later. This is visible to everyone in the channel the moment \
             it succeeds.",
            json!({ "type": "object", "properties": {
                "server_id": { "type": "string" },
                "channel_id": { "type": "string" },
                "message": { "type": "object" },
                "thread_id": { "type": "string", "description": "Post into an existing thread in that channel." }
            }, "required": ["server_id", "channel_id", "message"], "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" },
                "message_id": { "type": "string" }, "link": { "type": "string" },
                "thread_id": { "type": "string", "description": "Set when the message landed in a thread or a new forum post — pass it to `fetch_message` / `update_message`." },
                "report": { "type": "object" }
            }, "required": ["ok"] }),
            false,
            true,
        ),
        tool(
            "fetch_message",
            "Read a posted message",
            "Read back a message DWEEB posted in a channel, as an editable Components V2 payload. Use \
             it to change a live message: fetch, edit the payload, then `update_message`.",
            json!({ "type": "object", "properties": {
                "server_id": { "type": "string" },
                "channel_id": { "type": "string" },
                "message_id": { "type": "string" },
                "thread_id": { "type": "string" }
            }, "required": ["server_id", "channel_id", "message_id"], "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" },
                "message": { "type": "object" }, "outline": { "type": "string" }
            }, "required": ["ok"] }),
            true,
            true,
        ),
        tool(
            "update_message",
            "Replace a posted message",
            "Replace a message DWEEB posted with a new payload. The replacement is complete, not \
             merged: whatever you pass becomes the entire message, so fetch it first if you mean to \
             keep part of it.",
            json!({ "type": "object", "properties": {
                "server_id": { "type": "string" },
                "channel_id": { "type": "string" },
                "message_id": { "type": "string" },
                "message": { "type": "object" },
                "thread_id": { "type": "string" }
            }, "required": ["server_id", "channel_id", "message_id", "message"], "additionalProperties": false }),
            json!({ "type": "object", "properties": {
                "ok": { "type": "boolean" }, "error": { "type": "string" },
                "message_id": { "type": "string" }, "link": { "type": "string" }, "report": { "type": "object" }
            }, "required": ["ok"] }),
            false,
            true,
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn tool(
    name: &str,
    title: &str,
    description: &str,
    input_schema: Value,
    output_schema: Value,
    read_only: bool,
    open_world: bool,
) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input_schema,
        "outputSchema": output_schema,
        "annotations": {
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": name == "update_message",
            "idempotentHint": name == "update_message",
            "openWorldHint": open_world,
        }
    })
}

/* ── Write budget ────────────────────────────────────────────────────── */

/// Writes — share links, posts, edits — one Discord account may make through
/// the connector: a burst, then one every [`WRITE_REFILL_SECS`]. The per-IP
/// limit counts HTTP requests, and a model drives this endpoint from one
/// connection, so without a per-account budget nothing stopped one account
/// filling the site-wide short-link store or flooding a channel.
const WRITE_BURST: f64 = 10.0;
const WRITE_REFILL_SECS: f64 = 15.0;
/// Bound on the buckets held at once; a full bucket carries no state worth
/// keeping, so those are what get dropped.
const MAX_WRITE_BUCKETS: usize = 10_000;

static WRITE_BUCKETS: LazyLock<Mutex<HashMap<String, (f64, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn is_write(tool: &str) -> bool {
    matches!(
        tool,
        "create_share_link" | "send_message" | "update_message"
    )
}

/// Spend one write from `user`'s budget, or say how many seconds until one is
/// back.
fn take_write(user: &str) -> Result<(), u64> {
    let now = Instant::now();
    let mut buckets = match WRITE_BUCKETS.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if buckets.len() >= MAX_WRITE_BUCKETS {
        let refill_all = WRITE_BURST * WRITE_REFILL_SECS;
        buckets.retain(|_, (_, last)| now.duration_since(*last).as_secs_f64() < refill_all);
    }
    let bucket = buckets
        .entry(user.to_string())
        .or_insert((WRITE_BURST, now));
    spend(bucket, now)
}

/// Token-bucket arithmetic, separated so it is testable without a clock.
fn spend(bucket: &mut (f64, Instant), now: Instant) -> Result<(), u64> {
    let elapsed = now.saturating_duration_since(bucket.1).as_secs_f64();
    bucket.0 = (bucket.0 + elapsed / WRITE_REFILL_SECS).min(WRITE_BURST);
    bucket.1 = now;
    if bucket.0 >= 1.0 {
        bucket.0 -= 1.0;
        Ok(())
    } else {
        Err(((1.0 - bucket.0) * WRITE_REFILL_SECS).ceil() as u64)
    }
}

/// Dispatch a `tools/call`. `None` means no such tool, which the protocol layer
/// reports as a JSON-RPC error rather than a tool failure.
pub async fn call(
    st: &AppState,
    identity: &TokenIdentity,
    name: &str,
    args: &Value,
) -> Option<ToolOutcome> {
    if is_write(name) {
        if let Err(wait) = take_write(&identity.discord_user) {
            return Some(fail(format!(
                "Slow down — this connection has used its writes for now. Try again in {wait}s."
            )));
        }
    }
    let outcome = match name {
        "describe_schema" => describe_schema(args),
        "list_templates" => list_templates(args),
        "get_template" => get_template(args),
        "validate_message" => validate_message(args),
        "preview_message" => preview_message(args),
        "create_share_link" => create_share_link(st, args),
        "list_servers" => list_servers(st, identity).await,
        "list_channels" => list_channels(st, identity, args).await,
        "send_message" => send_message(st, identity, args).await,
        "fetch_message" => fetch_message(st, identity, args).await,
        "update_message" => update_message(st, identity, args).await,
        _ => return None,
    };
    Some(outcome)
}

/* ── Argument helpers ────────────────────────────────────────────────── */

fn string_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn object_arg<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.get(key).filter(|v| v.is_object())
}

/// The optional `thread_id`, which must be a snowflake when given: it is put in
/// Discord's query string, where anything else (`1&wait=false`) would change
/// the request itself.
fn thread_arg(args: &Value) -> Result<Option<&str>, ToolOutcome> {
    match string_arg(args, "thread_id") {
        None => Ok(None),
        Some(thread) if is_snowflake(thread) => Ok(Some(thread)),
        Some(_) => Err(fail("`thread_id` must be a Discord thread id.")),
    }
}

/// Resolve the `message` argument through the import boundary.
fn message_arg(args: &Value) -> Result<Value, ToolOutcome> {
    let Some(raw) = object_arg(args, "message") else {
        return Err(fail("`message` must be the Components V2 message object."));
    };
    components::normalize(raw.clone())
        .map_err(|e| fail(format!("That payload is not a Components V2 message: {e}")))
}

/* ── Reporting ───────────────────────────────────────────────────────── */

struct Report {
    ok: bool,
    value: Value,
    text: String,
}

fn report(message: &Value, thread_id_provided: bool) -> Report {
    let data = catalog::schema_data();
    let issues = components::validate(message, data);
    let errors: Vec<_> = issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .collect();
    let warnings: Vec<_> = issues
        .iter()
        .filter(|i| i.severity == Severity::Warning)
        .collect();
    let requirements = components::requirements(message, thread_id_provided);
    let limits = &data.limits;
    let top = message
        .get("components")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let total = components::count_components(message);
    let chars = components::count_characters(message);

    let mut lines = vec![format!(
        "{} · {top}/{} top-level · {total}/{} components · {chars}/{} characters",
        if errors.is_empty() {
            "Valid"
        } else {
            "Invalid"
        },
        limits.top_level_components,
        limits.total_components,
        limits.total_characters,
    )];
    let render_issues = |list: &[&components::Issue]| -> Vec<String> {
        list.iter()
            .map(|i| {
                let at = i
                    .path
                    .as_ref()
                    .map(|p| format!(" at {p}"))
                    .unwrap_or_default();
                format!("  • [{}]{at}: {}", i.code, i.message)
            })
            .collect()
    };
    if !errors.is_empty() {
        lines.push(String::new());
        lines.push(format!(
            "Discord would reject this message ({}):",
            errors.len()
        ));
        lines.extend(render_issues(&errors));
    }
    if !warnings.is_empty() {
        lines.push(String::new());
        lines.push(format!(
            "Accepted, but Discord ignores or degrades these ({}):",
            warnings.len()
        ));
        lines.extend(render_issues(&warnings));
    }
    if !requirements.is_empty() {
        lines.push(String::new());
        lines.push("The destination has to provide:".into());
        for r in &requirements {
            lines.push(format!("  • {} — {}", r.title, r.detail));
        }
    }

    Report {
        ok: errors.is_empty(),
        value: json!({
            "ok": errors.is_empty(),
            "errors": errors,
            "warnings": warnings,
            "requirements": requirements,
            "stats": {
                "top_level_components": top,
                "total_components": total,
                "characters": chars,
            }
        }),
        text: lines.join("\n"),
    }
}

/* ── Pure tools ──────────────────────────────────────────────────────── */

fn describe_schema(args: &Value) -> ToolOutcome {
    let section = string_arg(args, "section").unwrap_or("all");
    let guide = catalog::authoring_guide();
    let limits = serde_json::to_value(&catalog::schema_data().limits).unwrap_or(Value::Null);
    let limit_lines = limits
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| format!("  {} = {v}", k.to_uppercase()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    match section {
        "guide" => ok(guide, json!({ "guide": guide })),
        "limits" => ok(
            format!("Discord limits DWEEB enforces:\n{limit_lines}"),
            json!({ "limits": limits }),
        ),
        _ => ok(
            format!("{guide}\n\n## Limits, as data\n{limit_lines}"),
            json!({ "guide": guide, "limits": limits }),
        ),
    }
}

fn template_summary(t: &catalog::Template) -> Value {
    json!({
        "id": t.id, "name": t.name, "description": t.description, "emoji": t.emoji,
        "category": t.category, "tags": t.tags, "interactive": t.interactive,
        "pairs_with": t.pairs_with,
    })
}

fn list_templates(args: &Value) -> ToolOutcome {
    let category = string_arg(args, "category").map(str::to_ascii_lowercase);
    let search = string_arg(args, "search").map(str::to_ascii_lowercase);

    let matches: Vec<&catalog::Template> = catalog::templates()
        .iter()
        .filter(|t| {
            if let Some(category) = &category {
                if t.category.to_ascii_lowercase() != *category {
                    return false;
                }
            }
            let Some(search) = &search else { return true };
            let haystack = format!(
                "{} {} {} {} {} {}",
                t.id,
                t.name,
                t.description,
                t.category,
                t.tags.join(" "),
                components::collect_search_text(&t.message)
            )
            .to_ascii_lowercase();
            haystack.contains(search)
        })
        .collect();

    let lines: Vec<String> = matches
        .iter()
        .map(|t| {
            format!(
                "{} {} — {} ({}){}\n    {}",
                t.emoji,
                t.id,
                t.name,
                t.category,
                if t.interactive { " · interactive" } else { "" },
                t.description
            )
        })
        .collect();
    let head = if matches.is_empty() {
        "No template matches.".to_string()
    } else {
        format!(
            "{} template{}:",
            matches.len(),
            if matches.len() == 1 { "" } else { "s" }
        )
    };
    let summaries: Vec<Value> = matches.iter().map(|t| template_summary(t)).collect();
    ok(
        format!("{head}\n{}", lines.join("\n")),
        json!({ "templates": summaries, "count": summaries.len() }),
    )
}

fn get_template(args: &Value) -> ToolOutcome {
    let Some(id) = string_arg(args, "id") else {
        return fail("`id` is required — see `list_templates`.");
    };
    let Some(template) = catalog::template(id) else {
        let ids: Vec<&str> = catalog::templates().iter().map(|t| t.id.as_str()).collect();
        return fail(format!(
            "No template with id \"{id}\". Available: {}.",
            ids.join(", ")
        ));
    };
    let message = match components::normalize(template.message.clone()) {
        Ok(m) => m,
        Err(e) => return fail(format!("That template did not normalize: {e}")),
    };
    let report = report(&message, false);
    let outline = render::outline(&message);
    ok(
        format!(
            "{} {} — {}\n\n{outline}\n\n{}\n\nPayload:\n{}",
            template.emoji,
            template.name,
            template.description,
            report.text,
            pretty(&message)
        ),
        json!({
            "template": template_summary(template),
            "message": message,
            "outline": outline,
            "report": report.value,
        }),
    )
}

fn validate_message(args: &Value) -> ToolOutcome {
    let message = match message_arg(args) {
        Ok(m) => m,
        Err(e) => return e,
    };
    let thread_id = match thread_arg(args) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let report = report(&message, thread_id.is_some());
    ok(report.text.clone(), json!({ "report": report.value }))
}

fn preview_message(args: &Value) -> ToolOutcome {
    let message = match message_arg(args) {
        Ok(m) => m,
        Err(e) => return e,
    };
    let outline = render::outline(&message);
    ok(
        outline.clone(),
        json!({
            "outline": outline,
            "stats": {
                "top_level_components": message.get("components").and_then(Value::as_array).map_or(0, Vec::len),
                "total_components": components::count_components(&message),
                "characters": components::count_characters(&message),
            }
        }),
    )
}

/* ── Share links ─────────────────────────────────────────────────────── */

fn create_share_link(st: &AppState, args: &Value) -> ToolOutcome {
    let message = match message_arg(args) {
        Ok(m) => m,
        Err(e) => return e,
    };
    let Some(store) = st.shortlinks.as_ref() else {
        return fail(
            "Short links are switched off on this deployment, so there is nowhere to put the message.",
        );
    };
    // The link has to be one the web app can open, and the web app knows exactly
    // one format: `<version>.<lz-string body>`, the same token the browser's own
    // share dialog produces. See `mcp/lz.rs` — the encoding is pinned to
    // `lz-string` by generated vectors precisely so a link minted here is not
    // subtly undecodable.
    let payload = match serde_json::to_string(&components::to_wire(&message)) {
        Ok(p) => p,
        Err(e) => return fail(format!("Could not encode the message: {e}")),
    };
    let token = format!(
        "{}.{}",
        catalog::schema_data().share_token_version,
        super::lz::compress_to_encoded_uri_component(&payload)
    );
    match store.create(&token) {
        Ok((id, _)) => {
            let url = format!("{}/s/{id}", st.config.frontend_url.trim_end_matches('/'));
            ok(
                format!(
                    "Open in DWEEB:
{url}

Stored for 7 days, then deleted."
                ),
                json!({ "url": url }),
            )
        }
        Err(crate::shortlink::CreateError::Full) => {
            fail("The short-link store is full, so there is nowhere to put the message right now.")
        }
        Err(_) => fail("Could not store the share link."),
    }
}

/* ── Discord-backed tools ────────────────────────────────────────────── */

/// Rebuild the user's session from the grant's Discord token. Every
/// Discord-backed tool starts here, so authorization is the app's, not ours.
async fn session_of(st: &AppState, identity: &TokenIdentity) -> Result<Session, AppError> {
    crate::activity::resolve_bearer(st, &identity.discord_token).await
}

/// Turn an `AppError` into a tool failure. A Discord or authorization problem
/// is the caller's to act on, not a protocol fault.
fn from_error(e: AppError) -> ToolOutcome {
    fail(e.to_string())
}

async fn list_servers(st: &AppState, identity: &TokenIdentity) -> ToolOutcome {
    let session = match session_of(st, identity).await {
        Ok(s) => s,
        Err(e) => return from_error(e),
    };
    let guilds = match member_guilds(st, &session, false).await {
        Ok(g) => g,
        Err(e) => return from_error(e),
    };
    let bot = bot_guild_set(st, false).await;

    let servers: Vec<Value> = guilds
        .iter()
        .map(|g| {
            json!({
                "id": g.id,
                "name": g.name,
                "bot_present": bot.contains(&g.id),
                "can_post": bot.contains(&g.id) && g.can_manage_webhooks,
                "can_manage_webhooks": g.can_manage_webhooks,
            })
        })
        .collect();
    let lines: Vec<String> = guilds
        .iter()
        .map(|g| {
            let postable = bot.contains(&g.id) && g.can_manage_webhooks;
            let why = if postable {
                "can post"
            } else if !bot.contains(&g.id) {
                "the DWEEB bot isn't in this server"
            } else {
                "you don't hold Manage Webhooks here"
            };
            format!("  {} — {} ({why})", g.id, g.name)
        })
        .collect();
    ok(
        format!(
            "{} server{}:\n{}",
            servers.len(),
            if servers.len() == 1 { "" } else { "s" },
            lines.join("\n")
        ),
        json!({ "servers": servers, "count": servers.len() }),
    )
}

async fn list_channels(st: &AppState, identity: &TokenIdentity, args: &Value) -> ToolOutcome {
    let Some(guild) = string_arg(args, "server_id") else {
        return fail("`server_id` is required — see `list_servers`.");
    };
    if !is_snowflake(guild) {
        return fail("`server_id` must be a Discord server id.");
    }
    let session = match session_of(st, identity).await {
        Ok(s) => s,
        Err(e) => return from_error(e),
    };
    // The same gate as posting (and as `list_servers`' `can_post`): listing a
    // server's channels exists to pick a destination, so a server the tools
    // would refuse to post to must not look postable here — nor be refused
    // here while the posting tools accept it.
    if let Err(e) = authorize_activity_webhooks(st, session, guild).await {
        return from_error(e);
    }
    let channels = match fetch_channels(st, guild, false).await {
        Ok(c) => c,
        Err(e) => return from_error(e),
    };

    // Only the kinds a webhook can post to. A forum/media channel is included
    // because it can be posted to — it just needs a `thread_name`.
    const POSTABLE: [u64; 5] = [0, 5, 15, 16, 2];
    let list: Vec<Value> = channels
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|c| {
            c.get("type")
                .and_then(Value::as_u64)
                .is_some_and(|t| POSTABLE.contains(&t))
        })
        .map(|c| {
            let kind = c.get("type").and_then(Value::as_u64).unwrap_or(0);
            json!({
                "id": c.get("id").and_then(Value::as_str).unwrap_or(""),
                "name": c.get("name").and_then(Value::as_str).unwrap_or(""),
                "type": kind,
                "kind": channel_kind(kind),
                "needs_post_title": components::THREAD_ONLY_CHANNEL_TYPES.contains(&kind),
            })
        })
        .collect();
    let lines: Vec<String> = list
        .iter()
        .map(|c| {
            let needs = if c["needs_post_title"] == Value::Bool(true) {
                " — needs a post title (`thread_name`)"
            } else {
                ""
            };
            format!(
                "  {} #{} ({}){needs}",
                c["id"].as_str().unwrap_or(""),
                c["name"].as_str().unwrap_or(""),
                c["kind"].as_str().unwrap_or("")
            )
        })
        .collect();
    ok(
        format!("{} channel(s):\n{}", list.len(), lines.join("\n")),
        json!({ "channels": list, "count": list.len() }),
    )
}

fn channel_kind(kind: u64) -> &'static str {
    match kind {
        0 => "text",
        2 => "voice",
        5 => "announcement",
        15 => "forum",
        16 => "media",
        _ => "other",
    }
}

/// What a channel-acting tool may do to find DWEEB's webhook there.
#[derive(Clone, Copy, PartialEq, Eq)]
enum WebhookUse {
    /// Posting: reuse DWEEB's webhook in the channel, or create one.
    Post,
    /// Reading or editing a posted message: only a webhook that already exists
    /// can have posted it, so nothing is ever created for this.
    Existing,
}

/// Shared preamble for the three tools that act on a channel: authorize the
/// user for the guild's webhooks, confirm the channel really is in that guild,
/// then resolve the DWEEB webhook there.
///
/// The channel check is the whole authorization for *where*: the gate above
/// only proves the user may post in `guild`, and the bot token can reach any
/// channel of any server it is in — so without it, a channel id from someone
/// else's server was accepted and a webhook minted and posted through there.
async fn webhook_for(
    st: &AppState,
    identity: &TokenIdentity,
    guild: &str,
    channel: &str,
    usage: WebhookUse,
) -> Result<(String, String), ToolOutcome> {
    if !is_snowflake(guild) || !is_snowflake(channel) {
        return Err(fail(
            "`server_id` and `channel_id` must be Discord ids — see `list_servers` and `list_channels`.",
        ));
    }
    let session = session_of(st, identity).await.map_err(from_error)?;
    let session = authorize_activity_webhooks(st, session, guild)
        .await
        .map_err(from_error)?;
    ensure_channel_in_guild(st, guild, channel)
        .await
        .map_err(from_error)?;
    match usage {
        WebhookUse::Post => {
            crate::activity::require_dweeb_webhook(st, &session.uid, guild, channel)
                .await
                .map_err(from_error)
        }
        WebhookUse::Existing => {
            match crate::activity::dweeb_webhook_in_channel(st, guild, channel, None)
                .await
                .map_err(from_error)?
            {
                Some(found) => Ok(found),
                None => Err(fail(
                    "DWEEB has no webhook in that channel, so nothing it posted there can be read or edited. Only messages sent through DWEEB can be.",
                )),
            }
        }
    }
}

fn channel_not_in_server() -> ToolOutcome {
    fail("That channel isn't in that server — see `list_channels` for the ones you can use.")
}

async fn send_message(st: &AppState, identity: &TokenIdentity, args: &Value) -> ToolOutcome {
    let message = match message_arg(args) {
        Ok(m) => m,
        Err(e) => return e,
    };
    let (Some(guild), Some(channel)) = (
        string_arg(args, "server_id"),
        string_arg(args, "channel_id"),
    ) else {
        return fail("`server_id` and `channel_id` are required.");
    };
    if !is_snowflake(guild) || !is_snowflake(channel) {
        return fail(
            "`server_id` and `channel_id` must be Discord ids — see `list_servers` and `list_channels`.",
        );
    }
    let thread_id = match thread_arg(args) {
        Ok(t) => t,
        Err(e) => return e,
    };

    // The check the message-only validator cannot make: a forum or media
    // channel needs the message to carry a post title, and every other kind
    // rejects one. Discord answers both with a 400 naming neither the channel
    // nor the field, so catching it here is the difference between a fixable
    // answer and a puzzle.
    let destination =
        match destination_issues(st, identity, guild, channel, &message, thread_id.is_some()).await
        {
            Ok(issues) => issues,
            Err(outcome) => return outcome,
        };
    if !destination.is_empty() {
        let detail = destination
            .iter()
            .map(|i| format!("  • [{}]: {}", i.code, i.message))
            .collect::<Vec<_>>()
            .join("\n");
        return ToolOutcome {
            text: format!("Not posted — this message can't go in that channel.\n{detail}"),
            structured: json!({
                "ok": false,
                "error": "The message does not fit that channel.",
                "issues": destination
            }),
            is_error: true,
        };
    }

    let report = report(&message, thread_id.is_some());
    if !report.ok {
        return ToolOutcome {
            text: format!(
                "Not posted — Discord would reject this message.\n\n{}",
                report.text
            ),
            structured: json!({ "ok": false, "error": "The message is invalid.", "report": report.value }),
            is_error: true,
        };
    }

    let (webhook_id, token) =
        match webhook_for(st, identity, guild, channel, WebhookUse::Post).await {
            Ok(w) => w,
            Err(e) => return e,
        };
    let payload = components::to_wire(&message);
    let posted = match st
        .discord
        .execute_webhook_in_thread(&webhook_id, &token, &payload, thread_id)
        .await
    {
        Ok(v) => v,
        Err(e) => return from_error(e),
    };

    let message_id = posted
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // A post into a thread — an existing one, or the new post a forum or media
    // channel starts — lives in that thread, not in the channel: the link must
    // name it, and every later fetch/update must carry its id.
    let thread = posted_thread(channel, &posted);
    let link = message_link(guild, thread.as_deref().unwrap_or(channel), &message_id);
    let mut lines = vec![format!("Posted to <#{channel}>.")];
    if !message_id.is_empty() {
        lines.push(format!("  message id: {message_id}"));
        if let Some(thread) = &thread {
            lines.push(format!(
                "  thread id:  {thread} (pass it as `thread_id` to read or edit this message)"
            ));
        }
        lines.push(format!("  link:       {link}"));
    }
    let has_notes = |key: &str| {
        report.value[key]
            .as_array()
            .is_some_and(|list| !list.is_empty())
    };
    if has_notes("warnings") || has_notes("requirements") {
        lines.push(String::new());
        lines.push(report.text.clone());
    }
    let mut structured = json!({ "message_id": message_id, "link": link, "report": report.value });
    if let Some(thread) = thread {
        structured["thread_id"] = json!(thread);
    }
    ok(lines.join("\n"), structured)
}

/// The thread a posted message landed in, from the message Discord echoed
/// back: its `channel_id` is the channel itself for an ordinary post, and the
/// thread's id when the message lives in one.
fn posted_thread(requested_channel: &str, posted: &Value) -> Option<String> {
    posted
        .get("channel_id")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty() && *c != requested_channel)
        .map(str::to_string)
}

fn message_link(guild: &str, channel_or_thread: &str, message_id: &str) -> String {
    format!("https://discord.com/channels/{guild}/{channel_or_thread}/{message_id}")
}

/// Look the destination channel up in the guild's channel list and check the
/// message against its kind. A channel that isn't in the guild at all — after
/// a fresh read, so a just-created channel still counts — is refused here:
/// the bot token could reach it, but the user's permission was only checked
/// for *this* server.
async fn destination_issues(
    st: &AppState,
    identity: &TokenIdentity,
    guild: &str,
    channel: &str,
    message: &Value,
    thread_id_provided: bool,
) -> Result<Vec<components::Issue>, ToolOutcome> {
    let session = session_of(st, identity).await.map_err(from_error)?;
    authorize_activity_webhooks(st, session, guild)
        .await
        .map_err(from_error)?;
    let cached = fetch_channels(st, guild, false).await.map_err(from_error)?;
    let found = match find_channel(&cached, channel) {
        Some(found) => found,
        None => {
            let fresh = fetch_channels(st, guild, true).await.map_err(from_error)?;
            match find_channel(&fresh, channel) {
                Some(found) => found,
                None => return Err(channel_not_in_server()),
            }
        }
    };
    Ok(components::validate_destination(
        message,
        found.kind,
        found.name.as_deref(),
        thread_id_provided,
    ))
}

/// One channel's entry in a guild's channel list.
struct FoundChannel {
    kind: Option<u64>,
    name: Option<String>,
}

fn find_channel(channels: &Value, channel: &str) -> Option<FoundChannel> {
    channels
        .as_array()?
        .iter()
        .find(|c| c.get("id").and_then(Value::as_str) == Some(channel))
        .map(|c| FoundChannel {
            kind: c.get("type").and_then(Value::as_u64),
            name: c.get("name").and_then(Value::as_str).map(str::to_string),
        })
}

async fn fetch_message(st: &AppState, identity: &TokenIdentity, args: &Value) -> ToolOutcome {
    let (Some(guild), Some(channel), Some(message_id)) = (
        string_arg(args, "server_id"),
        string_arg(args, "channel_id"),
        string_arg(args, "message_id"),
    ) else {
        return fail("`server_id`, `channel_id`, and `message_id` are required.");
    };
    if !is_snowflake(message_id) {
        return fail("`message_id` must be a Discord message id.");
    }
    let thread_id = match thread_arg(args) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let (webhook_id, token) =
        match webhook_for(st, identity, guild, channel, WebhookUse::Existing).await {
            Ok(w) => w,
            Err(e) => return e,
        };
    let fetched = match st
        .discord
        .webhook_message(&webhook_id, &token, message_id, thread_id)
        .await
    {
        Ok(Some(v)) => v,
        Ok(None) => {
            return fail(
                "DWEEB's webhook did not post that message, so it cannot be read back. Only messages sent through DWEEB can be edited here.",
            )
        }
        Err(e) => return from_error(e),
    };
    let message = match components::normalize(strip_wire_extras(fetched)) {
        Ok(m) => m,
        Err(e) => return fail(format!("That message is not a Components V2 payload: {e}")),
    };
    let outline = render::outline(&message);
    ok(
        format!("{outline}\n\nPayload:\n{}", pretty(&message)),
        json!({ "message": message, "outline": outline }),
    )
}

async fn update_message(st: &AppState, identity: &TokenIdentity, args: &Value) -> ToolOutcome {
    let message = match message_arg(args) {
        Ok(m) => m,
        Err(e) => return e,
    };
    let (Some(guild), Some(channel), Some(message_id)) = (
        string_arg(args, "server_id"),
        string_arg(args, "channel_id"),
        string_arg(args, "message_id"),
    ) else {
        return fail("`server_id`, `channel_id`, and `message_id` are required.");
    };
    if !is_snowflake(message_id) {
        return fail("`message_id` must be a Discord message id.");
    }
    let thread_id = match thread_arg(args) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let report = report(&message, thread_id.is_some());
    if !report.ok {
        return ToolOutcome {
            text: format!(
                "Not updated — Discord would reject this message.\n\n{}",
                report.text
            ),
            structured: json!({ "ok": false, "error": "The message is invalid.", "report": report.value }),
            is_error: true,
        };
    }
    let (webhook_id, token) =
        match webhook_for(st, identity, guild, channel, WebhookUse::Existing).await {
            Ok(w) => w,
            Err(e) => return e,
        };
    // The thread goes with the edit: a message in a thread or forum post is
    // only addressable through it — without it Discord answers 404 and the
    // edit reads as "that message no longer exists".
    if let Err(e) = st
        .discord
        .edit_webhook_message_with_files(
            &webhook_id,
            &token,
            message_id,
            &components::to_wire(&message),
            Vec::new(),
            thread_id,
        )
        .await
    {
        return from_error(e);
    }
    let link = message_link(guild, thread_id.unwrap_or(channel), message_id);
    ok(
        format!("Updated message {message_id}.\n  link: {link}"),
        json!({ "message_id": message_id, "link": link, "report": report.value }),
    )
}

/// Drop the fields Discord adds to a message it returns but rejects on the way
/// back in (ids, timestamps, the author object). What is left is the payload.
fn strip_wire_extras(mut fetched: Value) -> Value {
    let Some(map) = fetched.as_object_mut() else {
        return fetched;
    };
    let mut keep: Map<String, Value> = map
        .iter()
        .filter(|(k, _)| {
            matches!(
                k.as_str(),
                "components" | "flags" | "thread_name" | "applied_tags" | "allowed_mentions"
            )
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    // A posted message's flags include bits only Discord sets (HAS_THREAD,
    // CROSSPOSTED, …); hand back only the ones a sender may choose, so an
    // edit built from this payload doesn't try to re-send them.
    if let Some(flags) = keep.get("flags").and_then(Value::as_u64) {
        keep.insert(
            "flags".into(),
            Value::from(components::sendable_flags(flags)),
        );
    }
    Value::Object(keep)
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(value: Value) -> Value {
        value
    }

    #[test]
    fn every_descriptor_is_well_formed() {
        let tools = descriptors();
        assert!(tools.len() >= 10);
        let mut names: Vec<&str> = Vec::new();
        for t in &tools {
            let name = t["name"].as_str().expect("name");
            assert!(!names.contains(&name), "duplicate tool {name}");
            names.push(name);
            assert!(
                t["description"].as_str().unwrap().len() > 40,
                "{name} needs a real description"
            );
            assert_eq!(t["inputSchema"]["type"], "object", "{name}");
            assert_eq!(
                t["inputSchema"]["additionalProperties"],
                Value::Bool(false),
                "{name} must reject unknown arguments"
            );
            assert_eq!(t["outputSchema"]["required"], json!(["ok"]), "{name}");
            assert_eq!(t["annotations"]["title"], t["title"], "{name}");
        }
    }

    #[test]
    fn only_the_writing_tools_claim_to_write() {
        for t in descriptors() {
            let name = t["name"].as_str().unwrap().to_string();
            let read_only = t["annotations"]["readOnlyHint"] == Value::Bool(true);
            let writes = matches!(
                name.as_str(),
                "send_message" | "update_message" | "create_share_link"
            );
            assert_eq!(read_only, !writes, "{name} has the wrong readOnlyHint");
        }
    }

    #[test]
    fn describe_schema_can_return_just_the_numbers() {
        let out = describe_schema(&args(json!({ "section": "limits" })));
        assert!(!out.is_error);
        assert!(out.text.contains("TOTAL_CHARACTERS = 4000"));
        assert!(out.structured.get("guide").is_none());
    }

    #[test]
    fn templates_filter_by_category_and_search() {
        let all = list_templates(&args(json!({})));
        let count = all.structured["count"].as_u64().unwrap();
        assert!(count >= 30);

        let welcome = list_templates(&args(json!({ "category": "Welcome" })));
        for t in welcome.structured["templates"].as_array().unwrap() {
            assert_eq!(t["category"], "Welcome");
        }
        let none = list_templates(&args(json!({ "category": "Nope" })));
        assert_eq!(none.structured["count"], 0);
    }

    #[test]
    fn a_template_comes_back_valid_with_its_outline() {
        let out = get_template(&args(json!({ "id": "welcome" })));
        assert!(!out.is_error);
        assert_eq!(out.structured["report"]["ok"], Value::Bool(true));
        assert!(out.structured["outline"]
            .as_str()
            .unwrap()
            .contains("Container"));
        // The wire payload must carry the V2 flag or Discord parses it as legacy.
        assert_eq!(
            out.structured["message"]["flags"].as_u64().unwrap() & (1 << 15),
            1 << 15
        );
    }

    #[test]
    fn an_unknown_template_lists_the_real_ones() {
        let out = get_template(&args(json!({ "id": "welcom" })));
        assert!(out.is_error);
        assert!(out.text.contains("welcome"));
    }

    #[test]
    fn validation_names_the_path_of_the_component_at_fault() {
        let out = validate_message(&args(json!({
            "message": { "components": [
                { "type": 1, "components": [ { "type": 2, "style": 5, "label": "Broken" } ] }
            ] }
        })));
        assert!(
            !out.is_error,
            "reporting an invalid message is a successful call"
        );
        assert!(out.text.contains("BUTTON_URL_INVALID"));
        assert!(out.text.contains("components[0].components[0]"));
        assert_eq!(out.structured["report"]["ok"], Value::Bool(false));
    }

    #[test]
    fn a_malformed_payload_is_described_not_thrown() {
        let out = validate_message(&args(json!({ "message": { "nope": true } })));
        assert!(out.is_error);
        assert!(out.text.contains("components"));

        let missing = validate_message(&args(json!({})));
        assert!(missing.is_error);
    }

    // Components V2 forbids these outright; dropping them silently would post a
    // message missing content the caller wrote.
    #[test]
    fn a_legacy_content_field_is_refused_with_a_reason() {
        let out = validate_message(&args(json!({
            "message": { "content": "hi", "components": [] }
        })));
        assert!(out.is_error);
        assert!(out.text.contains("content"));
    }

    /// A share link is only useful if the web app can open it.
    ///
    /// The first version of this tool stored the raw JSON under a `json.`
    /// prefix, which the short-link *endpoint* would have rejected outright and
    /// which the editor's decoder could not have parsed — so every link it
    /// handed out would have loaded DWEEB and failed. The token has to be the
    /// same `<version>.<lz-string body>` the browser's own share dialog mints.
    #[test]
    fn a_minted_share_token_is_one_the_short_link_endpoint_accepts() {
        let payload = serde_json::to_string(&json!({
            "components": [{ "type": 10, "content": "# Hello 😀" }],
            "flags": 1 << 15
        }))
        .unwrap();
        let token = format!(
            "{}.{}",
            catalog::schema_data().share_token_version,
            super::super::lz::compress_to_encoded_uri_component(&payload)
        );
        assert!(
            crate::shortlink::is_share_token(&token),
            "the short-link endpoint would refuse {token}"
        );
        // And the version prefix is the one the decoder migrates from, not a
        // number invented here.
        assert!(token.starts_with(&format!("{}.", catalog::schema_data().share_token_version)));
    }

    #[test]
    fn preview_outlines_the_layout() {
        let out = preview_message(&args(json!({
            "message": { "components": [{ "type": 10, "content": "# Hi" }] }
        })));
        assert!(out.text.contains("¶ Text"));
        assert_eq!(out.structured["stats"]["total_components"], 1);
    }

    #[test]
    fn channel_kinds_name_the_ones_that_need_a_post_title() {
        assert_eq!(channel_kind(0), "text");
        assert_eq!(channel_kind(15), "forum");
        assert!(components::THREAD_ONLY_CHANNEL_TYPES.contains(&15));
        assert!(components::THREAD_ONLY_CHANNEL_TYPES.contains(&16));
        assert!(!components::THREAD_ONLY_CHANNEL_TYPES.contains(&0));
    }

    #[test]
    fn the_write_budget_allows_a_burst_then_one_per_refill() {
        let start = Instant::now();
        let mut bucket = (WRITE_BURST, start);
        for i in 0..WRITE_BURST as usize {
            assert!(spend(&mut bucket, start).is_ok(), "write {i} of the burst");
        }
        // The burst is spent: the answer says how long until the next one.
        let wait = spend(&mut bucket, start).expect_err("over budget");
        assert_eq!(wait, WRITE_REFILL_SECS as u64);
        // One refill period later, exactly one more write is allowed.
        let later = start + std::time::Duration::from_secs_f64(WRITE_REFILL_SECS);
        assert!(spend(&mut bucket, later).is_ok());
        assert!(spend(&mut bucket, later).is_err());
    }

    #[test]
    fn only_share_links_posts_and_edits_spend_the_write_budget() {
        for tool in ["create_share_link", "send_message", "update_message"] {
            assert!(is_write(tool), "{tool}");
        }
        for tool in [
            "validate_message",
            "list_servers",
            "fetch_message",
            "get_template",
        ] {
            assert!(!is_write(tool), "{tool}");
        }
    }

    #[test]
    fn a_thread_id_must_be_a_snowflake_before_it_reaches_a_query_string() {
        assert!(thread_arg(&json!({})).unwrap().is_none());
        assert_eq!(
            thread_arg(&json!({ "thread_id": "1234567890123456789" })).unwrap(),
            Some("1234567890123456789")
        );
        // `1&wait=false` would turn a successful post into a 204 the tool then
        // reports as a failure — and a retry posts it twice.
        assert!(thread_arg(&json!({ "thread_id": "1&wait=false" })).is_err());
        assert!(
            validate_message(&json!({
                "message": { "components": [{ "type": 10, "content": "hi" }] },
                "thread_id": "nope"
            }))
            .is_error
        );
    }

    #[test]
    fn a_post_that_landed_in_a_thread_is_linked_and_reported_through_it() {
        // An ordinary post echoes the channel itself…
        assert_eq!(posted_thread("100", &json!({ "channel_id": "100" })), None);
        // …a forum post or a thread reply echoes the thread.
        assert_eq!(
            posted_thread("100", &json!({ "channel_id": "200" })),
            Some("200".into())
        );
        assert_eq!(posted_thread("100", &json!({})), None);
        assert_eq!(
            message_link("1", "200", "300"),
            "https://discord.com/channels/1/200/300"
        );
    }

    #[test]
    fn a_channel_is_found_only_in_its_own_servers_list() {
        let channels = json!([
            { "id": "10", "type": 0, "name": "general" },
            { "id": "11", "type": 15, "name": "help" }
        ]);
        let forum = find_channel(&channels, "11").expect("listed");
        assert_eq!(forum.kind, Some(15));
        assert_eq!(forum.name.as_deref(), Some("help"));
        // A channel id from another server is simply not in this list — the
        // case the posting tools used to accept and mint a webhook for.
        assert!(find_channel(&channels, "99").is_none());
        assert!(find_channel(&json!({}), "10").is_none());
    }

    #[test]
    fn a_fetched_messages_discord_only_flags_are_dropped() {
        let stripped = strip_wire_extras(json!({
            "components": [], "flags": 32768 | 4096 | (1 << 5)
        }));
        assert_eq!(stripped["flags"], json!(32768 | 4096));
    }

    #[test]
    fn a_fetched_message_keeps_only_what_can_be_sent_back() {
        let stripped = strip_wire_extras(json!({
            "id": "1", "channel_id": "2", "author": { "id": "3" }, "timestamp": "now",
            "components": [{ "type": 10, "content": "hi" }], "flags": 32768,
            "thread_name": "Post"
        }));
        let map = stripped.as_object().unwrap();
        assert!(map.contains_key("components"));
        assert!(map.contains_key("flags"));
        assert!(map.contains_key("thread_name"));
        // Everything Discord rejects on the way back in is gone.
        assert!(!map.contains_key("id"));
        assert!(!map.contains_key("author"));
        assert!(!map.contains_key("timestamp"));
        assert!(!map.contains_key("channel_id"));
    }
}
