//! The Model Context Protocol over HTTP, and the JSON-RPC dispatch behind it.
//!
//! **The transport is deliberately stateless.** MCP's Streamable HTTP allows a
//! server to answer a POST with either a single JSON response or an SSE stream,
//! and to keep sessions via `Mcp-Session-Id`. This server needs neither: it
//! sends nothing the client did not ask for — no sampling, no roots, no
//! notifications — so every request is one POST with one JSON answer, and there
//! is no session to lose across a redeploy or a second replica. `GET /mcp` and
//! `DELETE /mcp` therefore answer 405, which is exactly what the specification
//! prescribes for a server that offers no stream and no session.
//!
//! That choice is worth defending because it is the difference between an
//! endpoint that survives a container restart mid-conversation and one that
//! does not. Anything stateful here would have to be shared across replicas or
//! pinned to one, and neither is worth it for a protocol whose entire traffic
//! is request/response.
//!
//! Authentication is OAuth (see `oauth.rs`), applied before any dispatch: an
//! unauthenticated call gets a 401 naming the metadata document, which is how a
//! client that knows only the MCP URL bootstraps the whole flow.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::routes::AppState;

use super::catalog;
use super::oauth;
use super::store::TokenIdentity;
use super::tools;

/// Newest revision this server implements.
pub const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
/// Every revision it can speak, newest first.
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const RESOURCE_NOT_FOUND: i64 = -32002;

const INSTRUCTIONS: &str = "Build, check, and post Discord messages that use the Components V2 \
layout system, through DWEEB.

Use this whenever the task involves a Discord message that is more than plain text: containers with \
accent stripes, sections with thumbnails, image galleries, buttons, or select menus.

The workflow that works: start from `list_templates` / `get_template` rather than from scratch, read \
`describe_schema` when unsure of a component's shape, then `validate_message` and `preview_message` \
before anything is posted. `create_share_link` opens the message in DWEEB's visual editor, which is \
how a person reviews it — offer the link instead of describing the message. `list_servers` and \
`list_channels` find a destination; `send_message` posts, and is visible to everyone in the channel \
the moment it succeeds.

You act as the Discord account that authorized this connection, so you can only reach servers and \
channels that account can already reach.";

/* ── HTTP ────────────────────────────────────────────────────────────── */

/// `POST /mcp` — one JSON-RPC message in, one answer out.
pub async fn endpoint(State(st): State<AppState>, headers: HeaderMap, body: String) -> Response {
    let identity = match oauth::authenticate(&st, &headers) {
        Ok(identity) => identity,
        Err(response) => return *response,
    };

    let parsed: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            return Json(error_response(
                Value::Null,
                PARSE_ERROR,
                format!("Invalid JSON: {e}"),
            ))
            .into_response()
        }
    };

    match handle(&st, &identity, parsed).await {
        // A notification gets no reply. 202 with an empty body is what the
        // specification asks for, and returning a JSON-RPC response instead
        // would desynchronize a client matching answers to ids.
        None => StatusCode::ACCEPTED.into_response(),
        Some(answer) => Json(answer).into_response(),
    }
}

/// `GET`/`DELETE /mcp` — this server offers no server-initiated stream and
/// keeps no session, so both are honestly unsupported rather than quietly
/// accepted.
pub async fn endpoint_unsupported() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(axum::http::header::ALLOW, "POST")],
        Json(json!({
            "error": "This MCP endpoint is stateless: POST a JSON-RPC message. There is no event stream and no session to delete."
        })),
    )
        .into_response()
}

/* ── Dispatch ────────────────────────────────────────────────────────── */

/// Handle one parsed JSON-RPC message. `None` means "say nothing" — the message
/// was a notification, or a response to a request we never made.
pub async fn handle(st: &AppState, identity: &TokenIdentity, message: Value) -> Option<Value> {
    // Batching was permitted through 2025-03-26 and removed in 2025-06-18.
    if let Some(batch) = message.as_array() {
        if batch.is_empty() {
            return Some(error_response(
                Value::Null,
                INVALID_REQUEST,
                "An empty batch is not a request.",
            ));
        }
        let mut answers = Vec::new();
        for entry in batch {
            if let Some(answer) = Box::pin(handle(st, identity, entry.clone())).await {
                answers.push(answer);
            }
        }
        return (!answers.is_empty()).then_some(Value::Array(answers));
    }

    let Some(object) = message.as_object() else {
        return Some(error_response(
            Value::Null,
            INVALID_REQUEST,
            "A JSON-RPC message must be an object.",
        ));
    };
    // A result/error coming the other way answers a request we did not make.
    let method = object.get("method")?;
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    let has_id = matches!(id, Value::String(_) | Value::Number(_));

    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return has_id.then(|| {
            error_response(
                id,
                INVALID_REQUEST,
                "Every message must carry \"jsonrpc\": \"2.0\".",
            )
        });
    }
    let Some(method) = method.as_str() else {
        return has_id.then(|| error_response(id, INVALID_REQUEST, "`method` must be a string."));
    };
    // Notifications are answered with silence, including unknown ones: there is
    // nowhere for an error to go.
    if !has_id {
        return None;
    }
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));

    // Everything except a tool call is answered from compiled-in data, so it is
    // split out: that half of the protocol is then testable without standing up
    // an `AppState` (a Discord client, a cache, a token store), which is most of
    // the surface where a protocol mistake would live.
    if let Some(answer) = dispatch_static(method, &id, &params) {
        return Some(answer);
    }
    Some(match method {
        "tools/call" => call_tool(st, identity, id, &params).await,
        other => error_response(
            id,
            METHOD_NOT_FOUND,
            format!("This server does not implement {other}."),
        ),
    })
}

/// The methods answered without touching Discord or the database. `None` means
/// "not one of mine" — the caller falls through to the tool dispatch.
fn dispatch_static(method: &str, id: &Value, params: &Value) -> Option<Value> {
    Some(match method {
        "initialize" => success(id.clone(), initialize(params)),
        "ping" => success(id.clone(), json!({})),
        "tools/list" => success(id.clone(), json!({ "tools": tools::descriptors() })),
        "resources/list" => success(id.clone(), json!({ "resources": resources() })),
        "resources/templates/list" => success(
            id.clone(),
            json!({ "resourceTemplates": resource_templates() }),
        ),
        "resources/read" => read_resource(id.clone(), params),
        "prompts/list" => success(id.clone(), json!({ "prompts": prompts() })),
        "prompts/get" => get_prompt(id.clone(), params),
        _ => return None,
    })
}

/// The envelope handling of [`handle`] without the tool dispatch — same code
/// path for everything a test can reach. Returns `Err(())` when the message is
/// a tool call, which needs state.
#[cfg(test)]
fn handle_static(message: &Value) -> Result<Option<Value>, ()> {
    match envelope(message) {
        Envelope::Silent => Ok(None),
        Envelope::Answer(answer) => Ok(Some(answer)),
        Envelope::Request { id, method, params } => match dispatch_static(&method, &id, &params) {
            Some(answer) => Ok(Some(answer)),
            None if method == "tools/call" => Err(()),
            None => Ok(Some(error_response(
                id,
                METHOD_NOT_FOUND,
                format!("This server does not implement {method}."),
            ))),
        },
    }
}

#[cfg(test)]
enum Envelope {
    /// Nothing to say: a notification, or a response to us.
    Silent,
    /// The envelope itself was wrong.
    Answer(Value),
    Request {
        id: Value,
        method: String,
        params: Value,
    },
}

#[cfg(test)]
fn envelope(message: &Value) -> Envelope {
    let Some(object) = message.as_object() else {
        return Envelope::Answer(error_response(
            Value::Null,
            INVALID_REQUEST,
            "A JSON-RPC message must be an object.",
        ));
    };
    let Some(method) = object.get("method") else {
        return Envelope::Silent;
    };
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    let has_id = matches!(id, Value::String(_) | Value::Number(_));
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return if has_id {
            Envelope::Answer(error_response(
                id,
                INVALID_REQUEST,
                "Every message must carry \"jsonrpc\": \"2.0\".",
            ))
        } else {
            Envelope::Silent
        };
    }
    let Some(method) = method.as_str() else {
        return if has_id {
            Envelope::Answer(error_response(
                id,
                INVALID_REQUEST,
                "`method` must be a string.",
            ))
        } else {
            Envelope::Silent
        };
    };
    if !has_id {
        return Envelope::Silent;
    }
    Envelope::Request {
        id,
        method: method.to_string(),
        params: object.get("params").cloned().unwrap_or_else(|| json!({})),
    }
}

fn initialize(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    // A version we do not know is answered with ours rather than refused —
    // otherwise this server locks itself out of every future revision.
    let negotiated = requested
        .filter(|v| SUPPORTED_PROTOCOL_VERSIONS.contains(v))
        .unwrap_or(LATEST_PROTOCOL_VERSION);
    json!({
        "protocolVersion": negotiated,
        "capabilities": {
            // Nothing here changes while the server runs: the tool set is fixed
            // and the templates are compiled in.
            "tools": { "listChanged": false },
            "resources": { "subscribe": false, "listChanged": false },
            "prompts": { "listChanged": false },
        },
        "serverInfo": {
            "name": "dweeb",
            "title": "DWEEB — Discord message builder",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": INSTRUCTIONS,
    })
}

async fn call_tool(st: &AppState, identity: &TokenIdentity, id: Value, params: &Value) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return error_response(id, INVALID_PARAMS, "`name` must be the tool's name.");
    };
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !args.is_object() {
        return error_response(id, INVALID_PARAMS, "`arguments` must be an object.");
    }

    match tools::call(st, identity, name, &args).await {
        Some(outcome) => {
            let mut result = json!({
                "content": [{ "type": "text", "text": outcome.text }],
                "structuredContent": outcome.structured,
            });
            if outcome.is_error {
                result["isError"] = Value::Bool(true);
            }
            success(id, result)
        }
        // The tool does not exist, so there is no tool run whose failure could
        // be reported — that is a protocol error, not an `isError` result.
        None => {
            let known = tools::descriptors()
                .iter()
                .filter_map(|t| t["name"].as_str().map(str::to_string))
                .collect::<Vec<_>>()
                .join(", ");
            error_response(
                id,
                INVALID_PARAMS,
                format!("No tool named \"{name}\". Available: {known}."),
            )
        }
    }
}

/* ── Resources ───────────────────────────────────────────────────────── */

const TEMPLATE_PREFIX: &str = "dweeb://templates/";

fn resources() -> Vec<Value> {
    vec![
        json!({
            "uri": "dweeb://guide",
            "name": "components-v2-guide",
            "title": "Components V2 authoring guide",
            "description": "How to build a Discord Components V2 message: every component type, the hard limits, and the mistakes Discord rejects the whole message for.",
            "mimeType": "text/markdown",
        }),
        json!({
            "uri": "dweeb://limits",
            "name": "components-v2-limits",
            "title": "Components V2 limits",
            "description": "The numeric caps DWEEB enforces before Discord does.",
            "mimeType": "application/json",
        }),
        json!({
            "uri": "dweeb://templates",
            "name": "template-index",
            "title": "Built-in template index",
            "description": "Every built-in DWEEB template: id, name, category, and whether it needs an application-owned webhook.",
            "mimeType": "application/json",
        }),
    ]
}

fn resource_templates() -> Vec<Value> {
    vec![json!({
        "uriTemplate": "dweeb://templates/{id}",
        "name": "template",
        "title": "Template payload",
        "description": "The complete Components V2 payload behind one built-in template.",
        "mimeType": "application/json",
    })]
}

fn read_resource(id: Value, params: &Value) -> Value {
    let Some(uri) = params.get("uri").and_then(Value::as_str) else {
        return error_response(id, INVALID_PARAMS, "`uri` must be the resource's URI.");
    };
    let contents = match uri {
        "dweeb://guide" => Some(("text/markdown", catalog::authoring_guide().to_string())),
        "dweeb://limits" => serde_json::to_string_pretty(&catalog::schema_data().limits)
            .ok()
            .map(|text| ("application/json", text)),
        "dweeb://templates" => {
            let index: Vec<Value> = catalog::templates()
                .iter()
                .map(|t| {
                    json!({
                        "id": t.id, "name": t.name, "description": t.description,
                        "category": t.category, "tags": t.tags, "interactive": t.interactive,
                        "uri": format!("{TEMPLATE_PREFIX}{}", t.id),
                    })
                })
                .collect();
            serde_json::to_string_pretty(&index)
                .ok()
                .map(|text| ("application/json", text))
        }
        other => other
            .strip_prefix(TEMPLATE_PREFIX)
            .and_then(catalog::template)
            .and_then(|t| serde_json::to_string_pretty(&t.message).ok())
            .map(|text| ("application/json", text)),
    };

    match contents {
        Some((mime, text)) => success(
            id,
            json!({ "contents": [{ "uri": uri, "mimeType": mime, "text": text }] }),
        ),
        None => error_response(id, RESOURCE_NOT_FOUND, format!("No resource at {uri}.")),
    }
}

/* ── Prompts ─────────────────────────────────────────────────────────── */

fn prompts() -> Vec<Value> {
    vec![
        json!({
            "name": "build_message",
            "title": "Build a Discord message",
            "description": "Design a Components V2 message from a description, check it, and hand back a DWEEB link to review before anything is posted.",
            "arguments": [
                { "name": "brief", "description": "What the message is for, in your own words.", "required": true },
                { "name": "template", "description": "Optional starting template id or category.", "required": false },
            ],
        }),
        json!({
            "name": "revise_message",
            "title": "Revise a posted message",
            "description": "Rework a message DWEEB already posted, showing the change before replacing anything.",
            "arguments": [
                { "name": "message_id", "description": "The posted message's id.", "required": true },
                { "name": "direction", "description": "What should change — tone, structure, content, length.", "required": true },
            ],
        }),
        json!({
            "name": "audit_message",
            "title": "Audit a message before posting",
            "description": "Review a message for anything Discord would reject, anything it would silently ignore, and whether the destination can deliver it.",
            "arguments": [
                { "name": "source", "description": "The message payload, or the id of a posted message.", "required": true },
            ],
        }),
    ]
}

fn get_prompt(id: Value, params: &Value) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return error_response(id, INVALID_PARAMS, "`name` must be the prompt's name.");
    };
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let arg = |key: &str| -> String {
        args.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    let (description, text) = match name {
        "build_message" => {
            let brief = arg("brief");
            if brief.trim().is_empty() {
                return error_response(id, INVALID_PARAMS, "Prompt build_message needs: brief.");
            }
            let template = arg("template");
            let start = if template.trim().is_empty() {
                "Check list_templates first; starting from a built-in template is usually faster than writing one from scratch.".to_string()
            } else {
                format!("Start from the built-in template or category \"{template}\" — use list_templates / get_template to pull it in.")
            };
            (
                "Build a Discord Components V2 message and hand back a review link.",
                format!(
                    "Build a Discord message for this: {brief}\n\n{start}\n\nThen, in order:\n\
                     1. Read describe_schema if you are unsure about any component's shape.\n\
                     2. Call validate_message and fix everything it reports as an error.\n\
                     3. Call preview_message and check the layout reads the way it should.\n\
                     4. Call create_share_link and give me the link so I can see it in DWEEB.\n\n\
                     Do not post anything until I have seen the link and said to go ahead."
                ),
            )
        }
        "revise_message" => {
            let message_id = arg("message_id");
            let direction = arg("direction");
            if message_id.trim().is_empty() || direction.trim().is_empty() {
                return error_response(
                    id,
                    INVALID_PARAMS,
                    "Prompt revise_message needs: message_id, direction.",
                );
            }
            (
                "Revise a posted Discord message and show the result before replacing it.",
                format!(
                    "Revise the posted message {message_id}.\nWhat to change: {direction}\n\n\
                     1. Use list_servers / list_channels to find where it lives, then fetch_message.\n\
                     2. Make the change, keeping everything I did not ask you to touch.\n\
                     3. Call validate_message, then preview_message.\n\
                     4. Call create_share_link and show me the result.\n\n\
                     Only call update_message once I have confirmed. It replaces the whole message."
                ),
            )
        }
        "audit_message" => {
            let source = arg("source");
            if source.trim().is_empty() {
                return error_response(id, INVALID_PARAMS, "Prompt audit_message needs: source.");
            }
            (
                "Audit a Discord message for rejections, silent failures, and destination fit.",
                format!(
                    "Audit this Discord message before it goes out: {source}\n\n\
                     1. Load it and call validate_message.\n\
                     2. Call preview_message and read the layout as a member of the server would.\n\
                     3. Check the destination with list_channels — a forum or media channel needs a \
                     post title, and every other kind rejects one.\n\n\
                     Report what would break, what would be silently ignored, and what you would \
                     change. Do not post or modify anything."
                ),
            )
        }
        other => {
            return error_response(id, INVALID_PARAMS, format!("No prompt named \"{other}\"."))
        }
    };

    success(
        id,
        json!({
            "description": description,
            "messages": [{ "role": "user", "content": { "type": "text", "text": text } }],
        }),
    )
}

/* ── JSON-RPC envelopes ──────────────────────────────────────────────── */

fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive the real envelope handling the way a client would.
    fn ask(message: Value) -> Option<Value> {
        handle_static(&message).expect("not a tool call")
    }

    #[test]
    fn a_request_is_answered_against_its_own_id() {
        let answer = ask(json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" })).expect("answer");
        assert_eq!(answer["id"], 7);
        assert_eq!(answer["jsonrpc"], "2.0");
        assert_eq!(answer["result"], json!({}));

        // A string id round-trips as a string — coercing it to a number would
        // leave the client unable to match the answer to its request.
        let answer =
            ask(json!({ "jsonrpc": "2.0", "id": "abc", "method": "ping" })).expect("answer");
        assert_eq!(answer["id"], "abc");
    }

    // Answering a notification is a protocol violation, and over one connection
    // it desynchronizes a client matching replies to ids.
    #[test]
    fn a_notification_is_never_answered() {
        assert!(ask(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        assert!(ask(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled" })).is_none());
        // Including one we do not implement: there is nowhere for an error to go.
        assert!(ask(json!({ "jsonrpc": "2.0", "method": "notifications/unheard-of" })).is_none());
        // And one with a broken envelope, for the same reason.
        assert!(ask(json!({ "method": "notifications/initialized" })).is_none());
    }

    #[test]
    fn a_response_to_us_is_ignored_rather_than_replied_to() {
        // We send no requests, so this can only be noise — answering it would loop.
        assert!(ask(json!({ "jsonrpc": "2.0", "id": 1, "result": {} })).is_none());
    }

    #[test]
    fn a_broken_envelope_is_reported_against_the_id_when_there_is_one() {
        let answer = ask(json!({ "id": 3, "method": "ping" })).expect("answer");
        assert_eq!(answer["error"]["code"], INVALID_REQUEST);
        assert_eq!(answer["id"], 3);

        let answer = ask(json!("not an object")).expect("answer");
        assert_eq!(answer["error"]["code"], INVALID_REQUEST);

        let answer = ask(json!({ "jsonrpc": "2.0", "id": 4, "method": 5 })).expect("answer");
        assert_eq!(answer["error"]["code"], INVALID_REQUEST);
    }

    #[test]
    fn an_unknown_method_is_a_method_not_found() {
        let answer = ask(json!({ "jsonrpc": "2.0", "id": 1, "method": "resources/subscribe" }))
            .expect("answer");
        assert_eq!(answer["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn a_tool_call_is_the_only_thing_that_needs_state() {
        // Guards the split: if a method quietly stopped being answerable from
        // compiled-in data, the static half would silently shrink.
        assert!(handle_static(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "list_templates" }
        }))
        .is_err());
        for method in [
            "initialize",
            "ping",
            "tools/list",
            "resources/list",
            "resources/templates/list",
            "prompts/list",
        ] {
            assert!(
                handle_static(&json!({ "jsonrpc": "2.0", "id": 1, "method": method })).is_ok(),
                "{method} should not need state"
            );
        }
    }

    #[test]
    fn tools_are_listed_with_their_schemas() {
        let answer =
            ask(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).expect("answer");
        let tools = answer["result"]["tools"].as_array().expect("tools");
        assert!(tools.len() >= 10);
        assert!(tools.iter().any(|t| t["name"] == "send_message"));
        for t in tools {
            assert_eq!(t["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn initialize_echoes_a_version_it_speaks_and_answers_anything_else_with_its_own() {
        for version in SUPPORTED_PROTOCOL_VERSIONS {
            let result = initialize(&json!({ "protocolVersion": version }));
            assert_eq!(result["protocolVersion"], version);
        }
        // A newer client is not an error: answer with ours and let it decide.
        assert_eq!(
            initialize(&json!({ "protocolVersion": "2099-01-01" }))["protocolVersion"],
            LATEST_PROTOCOL_VERSION
        );
        assert_eq!(
            initialize(&json!({}))["protocolVersion"],
            LATEST_PROTOCOL_VERSION
        );
    }

    #[test]
    fn initialize_declares_what_this_server_actually_offers() {
        let result = initialize(&json!({}));
        assert_eq!(result["capabilities"]["tools"]["listChanged"], false);
        assert_eq!(result["capabilities"]["resources"]["subscribe"], false);
        assert_eq!(result["serverInfo"]["name"], "dweeb");
        assert!(result["instructions"].as_str().unwrap().contains("Discord"));
    }

    #[test]
    fn resources_are_listed_and_readable() {
        let uris: Vec<String> = resources()
            .iter()
            .map(|r| r["uri"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            uris,
            ["dweeb://guide", "dweeb://limits", "dweeb://templates"]
        );

        for (uri, needle) in [
            ("dweeb://guide", "Component types"),
            ("dweeb://limits", "TOTAL_COMPONENTS"),
            ("dweeb://templates", "welcome"),
            ("dweeb://templates/welcome", "\"type\""),
        ] {
            let answer = read_resource(json!(1), &json!({ "uri": uri }));
            let text = answer["result"]["contents"][0]["text"].as_str().unwrap();
            assert!(text.contains(needle), "{uri} did not contain {needle}");
        }
    }

    #[test]
    fn an_unknown_resource_uses_the_specs_own_code() {
        let answer = read_resource(json!(1), &json!({ "uri": "dweeb://templates/nope" }));
        assert_eq!(answer["error"]["code"], RESOURCE_NOT_FOUND);
        let missing = read_resource(json!(1), &json!({}));
        assert_eq!(missing["error"]["code"], INVALID_PARAMS);
    }

    #[test]
    fn prompts_build_from_their_arguments_and_refuse_without_them() {
        let answer = get_prompt(
            json!(1),
            &json!({ "name": "build_message", "arguments": { "brief": "a rules post", "template": "rules" } }),
        );
        let text = answer["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap();
        assert!(text.contains("a rules post"));
        assert!(text.contains("category \"rules\""));

        let missing = get_prompt(json!(1), &json!({ "name": "build_message" }));
        assert_eq!(missing["error"]["code"], INVALID_PARAMS);
        let unknown = get_prompt(json!(1), &json!({ "name": "nope" }));
        assert_eq!(unknown["error"]["code"], INVALID_PARAMS);
    }

    #[test]
    fn every_prompt_names_its_required_arguments() {
        for prompt in prompts() {
            assert!(prompt["name"].as_str().is_some());
            assert!(prompt["description"].as_str().unwrap().len() > 20);
            assert!(prompt["arguments"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["required"] == Value::Bool(true)));
        }
    }
}
