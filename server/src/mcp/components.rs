//! Discord Components V2, on the wire.
//!
//! This is the one piece of the MCP server that could not be shared with the
//! web app and could not be generated from it: the ~70 validation rules in
//! `src/core/schema/validation.ts`, rewritten in Rust. Everything else the
//! server needs — the limits, the templates, the link-plugin prefixes — is
//! emitted into `catalog.json` by `scripts/gen-mcp-catalog.ts`, because
//! hand-porting data is how data drifts.
//!
//! Rules cannot be generated, so they are **pinned** instead. The same script
//! writes `validation-corpus.json`: a hundred-odd messages with the exact
//! `(code, path)` pairs the TypeScript validator produces for each, and both
//! implementations are tested against it — the TypeScript suite in
//! `src/core/schema/corpus.test.ts`, this one at the bottom of this file. The
//! generator refuses to emit a corpus that does not exercise every rule, so a
//! rule added on either side without a matching port fails a test rather than
//! surfacing as a message Discord rejects. **If you change a rule here, change
//! it there, regenerate, and expect both suites to move together.**
//!
//! Two deliberate differences from the browser's schema layer, both at the
//! *boundary* rather than in the rules:
//!
//!  - There are no editor ids. The browser stamps `_id` on every node so the UI
//!    can track selection; here a message arrives as wire JSON and leaves as
//!    wire JSON, so issues are reported against a **path** into the payload
//!    (`components[0].components[1]`) — which is also what a model can act on.
//!  - A Section with no `accessory` is *reported*, not refused.
//!    `attachEditorFields` throws on it because the editor cannot render one;
//!    a model handed "Section needs an accessory" can fix its payload, where
//!    "that isn't a Components V2 message" tells it nothing.
//!
//! Values stay as `serde_json::Value` throughout rather than being parsed into
//! typed structs. The payload we validate is the payload we post to Discord, so
//! round-tripping it through a typed model would silently drop any field this
//! server does not know about — exactly the wrong behaviour for a proxy sitting
//! between a caller and an API that keeps growing.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Tells Discord the message uses the Components V2 layout system. Always set;
/// Discord rejects V2 components without it.
pub const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15;
/// Silent send — delivered, but no notification.
pub const FLAG_SUPPRESS_NOTIFICATIONS: u64 = 1 << 12;

/// Component `type` discriminators.
pub mod component_type {
    pub const ACTION_ROW: u64 = 1;
    pub const BUTTON: u64 = 2;
    pub const STRING_SELECT: u64 = 3;
    pub const USER_SELECT: u64 = 5;
    pub const ROLE_SELECT: u64 = 6;
    pub const MENTIONABLE_SELECT: u64 = 7;
    pub const CHANNEL_SELECT: u64 = 8;
    pub const SECTION: u64 = 9;
    pub const TEXT_DISPLAY: u64 = 10;
    pub const THUMBNAIL: u64 = 11;
    pub const MEDIA_GALLERY: u64 = 12;
    pub const FILE: u64 = 13;
    pub const SEPARATOR: u64 = 14;
    pub const CONTAINER: u64 = 17;
}

/// Button `style` discriminators.
pub mod button_style {
    /// Only the two styles the rules discriminate on. Everything else (blurple,
    /// grey, green, red) is "an interactive button" as far as validation is
    /// concerned, and naming them here would imply a distinction the code does
    /// not make.
    pub const LINK: u64 = 5;
    pub const PREMIUM: u64 = 6;
}

use button_style::{LINK, PREMIUM};
use component_type as ct;

/// Discord's caps, deserialized from the generated catalog so there is exactly
/// one place a number lives (`src/core/schema/limits.ts`).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub struct Limits {
    pub total_components: usize,
    pub top_level_components: usize,
    pub total_characters: usize,
    pub container_children: usize,
    pub section_texts_min: usize,
    pub section_texts_max: usize,
    pub gallery_items: usize,
    pub action_row_buttons: usize,
    pub text_display_content: usize,
    pub button_label: usize,
    pub button_custom_id: usize,
    pub button_url: usize,
    pub media_description: usize,
    pub select_custom_id: usize,
    pub select_placeholder: usize,
    pub select_options: usize,
    pub select_min_values: i64,
    pub select_max_values: i64,
    pub select_option_label: usize,
    pub select_option_value: usize,
    pub select_option_description: usize,
    pub select_default_values: usize,
    pub webhook_username: usize,
    pub webhook_avatar_url: usize,
    pub thread_name: usize,
    pub applied_tags: usize,
    #[allow(dead_code)]
    pub snowflake_max: usize,
    pub color_max: i64,
}

/// A link plugin's URL template prefix, for the unfinished-URL rule.
#[derive(Debug, Clone, Deserialize)]
pub struct LinkPlugin {
    #[allow(dead_code)]
    pub id: String,
    pub name: String,
    pub prefix: String,
}

/// Everything the validator needs that came from the TypeScript side.
#[derive(Debug, Clone, Deserialize)]
pub struct SchemaData {
    /// Share-token format version, generated from `serialization/version.ts` so
    /// a bump there reaches the links this server mints.
    #[serde(rename = "shareTokenVersion")]
    pub share_token_version: u32,
    pub limits: Limits,
    #[serde(rename = "corePlaceholderTokens")]
    pub core_placeholder_tokens: Vec<String>,
    #[serde(rename = "linkPlugins")]
    pub link_plugins: Vec<LinkPlugin>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Discord would reject the message. Blocks sending.
    Error,
    /// Discord accepts it but ignores or degrades something.
    Warning,
}

/// One validation finding: the rule, what it means, and the component it blames.
#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
    /// Path into the wire payload. `None` for a message-level rule.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl Issue {
    fn error(code: &'static str, path: Option<String>, message: impl Into<String>) -> Self {
        Issue {
            severity: Severity::Error,
            code,
            message: message.into(),
            path,
        }
    }

    fn warning(code: &'static str, path: Option<String>, message: impl Into<String>) -> Self {
        Issue {
            severity: Severity::Warning,
            code,
            message: message.into(),
            path,
        }
    }
}

/* ─── Small helpers ──────────────────────────────────────────────────── */

fn arr<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

fn node_type(node: &Value) -> u64 {
    u64_field(node, "type").unwrap_or(0)
}

/// Length in **UTF-16 code units** — what JavaScript's `String.length` counts,
/// and therefore what every limit in `limits.ts` was measured against. Using
/// `chars().count()` here would let a message of emoji through at twice the cap
/// (each astral character is two units), and `len()` would reject one at half.
/// Pinned by the `astral-characters-*` corpus cases.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Discord snowflakes as the validator recognises them: 15–25 digits.
fn is_snowflake(s: &str) -> bool {
    let len = s.len();
    (15..=25).contains(&len) && s.bytes().all(|b| b.is_ascii_digit())
}

/// Discord rejects a webhook username containing "clyde" or "discord" anywhere,
/// case-insensitively — so "Discord Alerts" bounces, not just an exact match.
fn is_reserved_username(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("clyde") || lower.contains("discord")
}

/// True when `text` carries a well-formed `{token}` placeholder — a lowercase
/// id of 1–32 chars in braces. A format-checked field whose literal value only
/// exists after substitution must not be flagged for its raw token shape, and
/// the pattern is strict so ordinary prose like `{ this }` still validates.
fn contains_placeholder(text: &str) -> bool {
    placeholder_tokens(text).next().is_some()
}

/// Every `{token}` in `text`, in order of appearance.
fn placeholder_tokens(text: &str) -> impl Iterator<Item = &str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(close) = bytes[i + 1..].iter().position(|&b| b == b'}') {
                let token = &text[i + 1..i + 1 + close];
                let ok = (1..=32).contains(&token.len())
                    && token
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
                if ok {
                    out.push(token);
                    i += close + 2;
                    continue;
                }
            }
        }
        i += 1;
    }
    out.into_iter()
}

fn parse_url(raw: &str) -> Option<url::Url> {
    url::Url::parse(raw).ok()
}

fn is_valid_https_url(raw: &str) -> bool {
    parse_url(raw).is_some_and(|u| u.scheme() == "https")
}

fn is_valid_url(raw: &str) -> bool {
    parse_url(raw).is_some_and(|u| u.scheme() == "https" || u.scheme() == "http")
}

fn is_valid_media_url(raw: &str) -> bool {
    if let Some(rest) = raw.strip_prefix("attachment://") {
        return !rest.is_empty();
    }
    if raw.starts_with("session://") {
        return parse_session_url(raw);
    }
    is_valid_url(raw)
}

/// Whether `raw` is a well-formed in-session upload reference,
/// `session://<blobId>/<filename>`.
///
/// These name bytes held in one browser's in-memory upload registry, which no
/// server can ever resolve — so on this side a well-formed one is always a
/// *missing* attachment rather than a malformed URL. That distinction is not
/// pedantry: it is the difference between telling a caller "this URL is
/// nonsense" and "this file lives in someone's browser and has to be re-attached
/// or posted from there", and it keeps the code identical to the one the
/// TypeScript validator reports for the same payload.
fn parse_session_url(raw: &str) -> bool {
    let Some(rest) = raw.strip_prefix("session://") else {
        return false;
    };
    let Some(slash) = rest.find('/') else {
        return false;
    };
    // A leading slash means an empty blob id.
    slash > 0 && !rest[slash + 1..].is_empty()
}

fn is_external_web_url(raw: &str) -> bool {
    if raw.starts_with("attachment://") || raw.starts_with("session://") {
        return false;
    }
    is_valid_url(raw)
}

fn is_discord_cdn_url(raw: &str) -> bool {
    parse_url(raw).is_some_and(|u| {
        matches!(
            u.host_str().map(str::to_ascii_lowercase).as_deref(),
            Some("cdn.discordapp.com") | Some("media.discordapp.net")
        )
    })
}

/* ─── Walking ────────────────────────────────────────────────────────── */

/// Every component in document order with its path, mirroring the TypeScript
/// `walk`: containers recurse, section texts and accessories are visited, row
/// children are visited, and gallery *items* are not (they are not components).
fn walk<'a>(message: &'a Value, out: &mut Vec<(String, &'a Value)>) {
    for (i, node) in arr(message, "components").iter().enumerate() {
        walk_node(node, format!("components[{i}]"), out);
    }
}

fn walk_node<'a>(node: &'a Value, path: String, out: &mut Vec<(String, &'a Value)>) {
    let kind = node_type(node);
    out.push((path.clone(), node));
    match kind {
        ct::CONTAINER => {
            for (i, child) in arr(node, "components").iter().enumerate() {
                walk_node(child, format!("{path}.components[{i}]"), out);
            }
        }
        ct::SECTION => {
            for (i, child) in arr(node, "components").iter().enumerate() {
                out.push((format!("{path}.components[{i}]"), child));
            }
            if let Some(accessory) = node.get("accessory").filter(|v| v.is_object()) {
                out.push((format!("{path}.accessory"), accessory));
            }
        }
        ct::ACTION_ROW => {
            for (i, child) in arr(node, "components").iter().enumerate() {
                out.push((format!("{path}.components[{i}]"), child));
            }
        }
        _ => {}
    }
}

/// Total component count, including nested ones.
pub fn count_components(message: &Value) -> usize {
    let mut nodes = Vec::new();
    walk(message, &mut nodes);
    nodes.len()
}

/// Sum of every text-bearing field, in UTF-16 code units.
///
/// Counts exactly what the TypeScript `countCharacters` counts: text content,
/// button and option labels, descriptions, select placeholders, string-select
/// option labels and descriptions, plus the webhook username. Gallery *item*
/// descriptions are deliberately not counted — items are not walked.
pub fn count_characters(message: &Value) -> usize {
    let mut nodes = Vec::new();
    walk(message, &mut nodes);
    let mut n = 0usize;
    for (_, node) in &nodes {
        for key in ["content", "label", "description", "placeholder"] {
            if let Some(s) = str_field(node, key) {
                n += utf16_len(s);
            }
        }
        if node_type(node) == ct::STRING_SELECT {
            for option in arr(node, "options") {
                if let Some(s) = str_field(option, "label") {
                    n += utf16_len(s);
                }
                if let Some(s) = str_field(option, "description") {
                    n += utf16_len(s);
                }
            }
        }
    }
    if let Some(username) = str_field(message, "username") {
        n += utf16_len(username);
    }
    n
}

/// Every human-readable string in the message, lowercased — the haystack the
/// template search matches against.
pub fn collect_search_text(message: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut push = |v: Option<&str>| {
        if let Some(s) = v.filter(|s| !s.is_empty()) {
            parts.push(s.to_string());
        }
    };
    push(str_field(message, "username"));
    push(str_field(message, "thread_name"));

    let mut nodes = Vec::new();
    walk(message, &mut nodes);
    for (_, node) in &nodes {
        for key in ["content", "label", "description", "placeholder"] {
            push(str_field(node, key));
        }
        if node_type(node) == ct::STRING_SELECT {
            for option in arr(node, "options") {
                push(str_field(option, "label"));
                push(str_field(option, "description"));
            }
        }
        if node_type(node) == ct::MEDIA_GALLERY {
            for item in arr(node, "items") {
                push(str_field(item, "description"));
            }
        }
    }
    parts.join(" ").to_lowercase()
}

/* ─── The import boundary ────────────────────────────────────────────── */

/// Bring an arbitrary caller payload into the shape the validator can walk.
///
/// The same job `attachEditorFields` does in the browser, and load-bearing for
/// the same reason: everything downstream reads fields without guarding, so a
/// payload that omits a structural field has to be repaired *here* or blow up
/// somewhere far away. A missing array becomes `[]`, missing media becomes an
/// empty URL, a missing required string becomes `""` — each of which the
/// validator already has a precise complaint for, so nothing is invented and
/// nothing is hidden.
///
/// Refusals are limited to what genuinely cannot be validated: a payload that
/// is not an object, has no `components` array, or carries a component that is
/// not an object or has no numeric `type`. A Section with no accessory is
/// **not** refused here — see the module comment.
pub fn normalize(payload: Value) -> Result<Value, String> {
    let Value::Object(mut map) = payload else {
        return Err("A message must be a JSON object.".into());
    };
    if !map.get("components").is_some_and(Value::is_array) {
        return Err("A message must have a `components` array.".into());
    }
    // Components V2 forbids these outright — Discord rejects the whole message.
    // Refusing is kinder than silently dropping content the caller wrote.
    for forbidden in ["content", "embeds"] {
        if map.get(forbidden).is_some_and(|v| !v.is_null()) {
            return Err(format!(
                "Components V2 messages cannot carry `{forbidden}` — the whole message is expressed through `components`."
            ));
        }
    }
    let components = map.remove("components").unwrap_or(Value::Array(vec![]));
    let Value::Array(list) = components else {
        return Err("A message must have a `components` array.".into());
    };
    let repaired: Result<Vec<Value>, String> = list.into_iter().map(repair_node).collect();
    map.insert("components".into(), Value::Array(repaired?));
    Ok(Value::Object(map))
}

fn repair_node(node: Value) -> Result<Value, String> {
    let Value::Object(mut map) = node else {
        return Err("Every component must be a JSON object.".into());
    };
    let Some(kind) = map.get("type").and_then(Value::as_u64) else {
        return Err("Every component needs a numeric `type` field.".into());
    };

    let child_bearing = matches!(kind, ct::SECTION | ct::CONTAINER | ct::ACTION_ROW);
    if child_bearing && !map.get("components").is_some_and(Value::is_array) {
        map.insert("components".into(), Value::Array(vec![]));
    }
    if kind == ct::MEDIA_GALLERY && !map.get("items").is_some_and(Value::is_array) {
        map.insert("items".into(), Value::Array(vec![]));
    }
    if kind == ct::STRING_SELECT && !map.get("options").is_some_and(Value::is_array) {
        map.insert("options".into(), Value::Array(vec![]));
    }
    if kind == ct::THUMBNAIL && !map.get("media").is_some_and(Value::is_object) {
        map.insert("media".into(), empty_media());
    }
    if kind == ct::FILE && !map.get("file").is_some_and(Value::is_object) {
        map.insert("file".into(), empty_media());
    }
    if kind == ct::TEXT_DISPLAY && !map.get("content").is_some_and(Value::is_string) {
        map.insert("content".into(), Value::String(String::new()));
    }
    if kind == ct::BUTTON
        && map.get("style").and_then(Value::as_u64) == Some(LINK)
        && !map.get("url").is_some_and(Value::is_string)
    {
        map.insert("url".into(), Value::String(String::new()));
    }

    // Recurse into structural children.
    if let Some(Value::Array(children)) = map.remove("components") {
        let repaired: Result<Vec<Value>, String> = children.into_iter().map(repair_node).collect();
        map.insert("components".into(), Value::Array(repaired?));
    }
    if let Some(accessory) = map.remove("accessory") {
        if accessory.is_object() {
            map.insert("accessory".into(), repair_node(accessory)?);
        }
        // A non-object accessory is dropped, which the validator then reports as
        // a missing one — the same answer, without a confusing type error.
    }
    if let Some(Value::Array(items)) = map.remove("items") {
        let repaired: Vec<Value> = items
            .into_iter()
            .map(|item| {
                let mut item_map = match item {
                    Value::Object(m) => m,
                    _ => Map::new(),
                };
                if !item_map.get("media").is_some_and(Value::is_object) {
                    item_map.insert("media".into(), empty_media());
                }
                Value::Object(item_map)
            })
            .collect();
        map.insert("items".into(), Value::Array(repaired));
    }

    Ok(Value::Object(map))
}

fn empty_media() -> Value {
    let mut media = Map::new();
    media.insert("url".into(), Value::String(String::new()));
    Value::Object(media)
}

/// The body Discord receives: the caller's payload with `IS_COMPONENTS_V2`
/// forced on, preserving any other flag bits (silent send) they set.
pub fn to_wire(message: &Value) -> Value {
    let mut out = message.clone();
    let existing = out.get("flags").and_then(Value::as_u64).unwrap_or(0);
    if let Some(map) = out.as_object_mut() {
        map.insert(
            "flags".into(),
            Value::from(existing | FLAG_IS_COMPONENTS_V2),
        );
    }
    out
}

/* ─── Validation ─────────────────────────────────────────────────────── */

/// Run every rule over a normalized message.
pub fn validate(message: &Value, data: &SchemaData) -> Vec<Issue> {
    let limits = &data.limits;
    let mut issues = Vec::new();
    let components = arr(message, "components");

    if components.is_empty() {
        issues.push(Issue::error(
            "EMPTY_MESSAGE",
            None,
            "A message must contain at least one component.",
        ));
    }
    if components.len() > limits.top_level_components {
        issues.push(Issue::error(
            "TOP_LEVEL_LIMIT",
            None,
            format!(
                "A message can have at most {} top-level components.",
                limits.top_level_components
            ),
        ));
    }
    let total = count_components(message);
    if total > limits.total_components {
        issues.push(Issue::error(
            "TOTAL_COMPONENT_LIMIT",
            None,
            format!(
                "A message can have at most {} components in total (currently {total}).",
                limits.total_components
            ),
        ));
    }
    let chars = count_characters(message);
    if chars > limits.total_characters {
        issues.push(Issue::error(
            "TOTAL_CHARACTER_LIMIT",
            None,
            format!(
                "Total text length is {chars}, exceeding the {}-character cap.",
                limits.total_characters
            ),
        ));
    }

    if let Some(username) = str_field(message, "username").filter(|s| !s.is_empty()) {
        if utf16_len(username) > limits.webhook_username {
            issues.push(Issue::error(
                "USERNAME_TOO_LONG",
                None,
                format!(
                    "Webhook username must be ≤{} characters.",
                    limits.webhook_username
                ),
            ));
        }
        if is_reserved_username(username) {
            issues.push(Issue::error(
                "USERNAME_RESERVED",
                None,
                "Webhook username can't contain \"clyde\" or \"discord\" — Discord rejects those names.",
            ));
        }
    }

    validate_message_level(message, limits, &mut issues);

    for (i, node) in components.iter().enumerate() {
        validate_node(node, &format!("components[{i}]"), data, &mut issues);
    }

    validate_unique_ids(message, &mut issues);
    issues
}

fn validate_message_level(message: &Value, limits: &Limits, issues: &mut Vec<Issue>) {
    if let Some(am) = message.get("allowed_mentions").filter(|v| v.is_object()) {
        let parse: Vec<&str> = arr(am, "parse").iter().filter_map(Value::as_str).collect();
        let roles = arr(am, "roles");
        let users = arr(am, "users");
        if parse.contains(&"roles") && !roles.is_empty() {
            issues.push(Issue::error(
                "ALLOWED_MENTIONS_CONFLICT_ROLES",
                None,
                "allowed_mentions: don't combine parse: ['roles'] with an explicit roles list — pick one.",
            ));
        }
        if parse.contains(&"users") && !users.is_empty() {
            issues.push(Issue::error(
                "ALLOWED_MENTIONS_CONFLICT_USERS",
                None,
                "allowed_mentions: don't combine parse: ['users'] with an explicit users list — pick one.",
            ));
        }
        for id in roles.iter().filter_map(Value::as_str) {
            if !is_snowflake(id) {
                issues.push(Issue::error(
                    "ALLOWED_MENTIONS_BAD_ROLE",
                    None,
                    format!("allowed_mentions.roles: \"{id}\" is not a valid snowflake."),
                ));
            }
        }
        for id in users.iter().filter_map(Value::as_str) {
            if !is_snowflake(id) {
                issues.push(Issue::error(
                    "ALLOWED_MENTIONS_BAD_USER",
                    None,
                    format!("allowed_mentions.users: \"{id}\" is not a valid snowflake."),
                ));
            }
        }
    }

    if let Some(thread_name) = str_field(message, "thread_name").filter(|s| !s.is_empty()) {
        if utf16_len(thread_name) > limits.thread_name {
            issues.push(Issue::error(
                "THREAD_NAME_LONG",
                None,
                format!(
                    "Forum thread name must be ≤{} characters.",
                    limits.thread_name
                ),
            ));
        }
    }

    if message.get("applied_tags").is_some_and(Value::is_array) {
        let tags = arr(message, "applied_tags");
        if tags.len() > limits.applied_tags {
            issues.push(Issue::error(
                "APPLIED_TAGS_LIMIT",
                None,
                format!(
                    "Forum posts accept at most {} applied tags.",
                    limits.applied_tags
                ),
            ));
        }
        for id in tags.iter().filter_map(Value::as_str) {
            if !is_snowflake(id) {
                issues.push(Issue::error(
                    "APPLIED_TAG_BAD",
                    None,
                    format!("applied_tags: \"{id}\" is not a valid snowflake."),
                ));
            }
        }
        let has_thread_name = str_field(message, "thread_name").is_some_and(|s| !s.is_empty());
        if !tags.is_empty() && !has_thread_name {
            issues.push(Issue::warning(
                "APPLIED_TAGS_NO_THREAD",
                None,
                "applied_tags are only honoured when posting to a forum channel with a thread_name.",
            ));
        }
    }

    if let Some(avatar) = str_field(message, "avatar_url").filter(|s| !s.is_empty()) {
        if utf16_len(avatar) > limits.webhook_avatar_url {
            issues.push(Issue::error(
                "AVATAR_URL_TOO_LONG",
                None,
                format!(
                    "Avatar URL must be ≤{} characters.",
                    limits.webhook_avatar_url
                ),
            ));
        }
        if !contains_placeholder(avatar) && !is_valid_url(avatar) {
            issues.push(Issue::warning(
                "AVATAR_URL_INVALID",
                None,
                "Avatar URL doesn't look like a valid http(s) URL.",
            ));
        }
    }
}

fn validate_node(node: &Value, path: &str, data: &SchemaData, issues: &mut Vec<Issue>) {
    let limits = &data.limits;

    if let Some(id) = node.get("id") {
        if !id.is_null() && id.as_i64().is_none() {
            issues.push(Issue::error(
                "COMPONENT_ID_NOT_INTEGER",
                Some(path.to_string()),
                "Component `id` must be a 32-bit integer.",
            ));
        }
    }

    let kind = node_type(node);

    // A button or select can appear as a Section accessory as well as inside a
    // row, and only reaches this function by that route — without the dispatch
    // an accessory button's missing URL would go unchecked.
    if kind == ct::BUTTON {
        validate_button(node, path, data, issues);
        return;
    }
    if is_select_type(kind) {
        validate_select(node, path, limits, issues);
        return;
    }

    match kind {
        ct::CONTAINER => {
            let children = arr(node, "components");
            if children.is_empty() {
                issues.push(Issue::error(
                    "CONTAINER_EMPTY",
                    Some(path.to_string()),
                    "Container must contain at least one component.",
                ));
            }
            if children.len() > limits.container_children {
                issues.push(Issue::error(
                    "CONTAINER_CHILDREN_LIMIT",
                    Some(path.to_string()),
                    format!(
                        "Container can hold at most {} children.",
                        limits.container_children
                    ),
                ));
            }
            if let Some(accent) = node.get("accent_color").filter(|v| !v.is_null()) {
                let bad = match accent.as_i64() {
                    Some(n) => !(0..=limits.color_max).contains(&n),
                    None => true,
                };
                if bad {
                    issues.push(Issue::error(
                        "CONTAINER_ACCENT_RANGE",
                        Some(path.to_string()),
                        format!(
                            "Container accent_color must be an integer in 0…{} (0xFFFFFF).",
                            limits.color_max
                        ),
                    ));
                }
            }
            for (i, child) in children.iter().enumerate() {
                validate_node(child, &format!("{path}.components[{i}]"), data, issues);
            }
        }
        ct::SECTION => {
            let texts = arr(node, "components");
            if texts.len() < limits.section_texts_min || texts.len() > limits.section_texts_max {
                issues.push(Issue::error(
                    "SECTION_TEXT_COUNT",
                    Some(path.to_string()),
                    format!(
                        "Section must contain {}–{} text components.",
                        limits.section_texts_min, limits.section_texts_max
                    ),
                ));
            }
            for (i, child) in texts.iter().enumerate() {
                validate_node(child, &format!("{path}.components[{i}]"), data, issues);
            }
            match node.get("accessory").filter(|v| v.is_object()) {
                Some(accessory) => {
                    validate_node(accessory, &format!("{path}.accessory"), data, issues)
                }
                None => issues.push(Issue::error(
                    "SECTION_ACCESSORY_MISSING",
                    Some(path.to_string()),
                    "Section needs an accessory — either a thumbnail or a button.",
                )),
            }
        }
        ct::MEDIA_GALLERY => {
            let items = arr(node, "items");
            if items.is_empty() {
                issues.push(Issue::error(
                    "GALLERY_EMPTY",
                    Some(path.to_string()),
                    "Media gallery must contain at least one item.",
                ));
            }
            if items.len() > limits.gallery_items {
                issues.push(Issue::error(
                    "GALLERY_LIMIT",
                    Some(path.to_string()),
                    format!(
                        "Media gallery can hold at most {} items.",
                        limits.gallery_items
                    ),
                ));
            }
            for (i, item) in items.iter().enumerate() {
                let item_path = format!("{path}.items[{i}]");
                validate_media(
                    item.get("media").unwrap_or(&Value::Null),
                    &item_path,
                    &format!("Gallery item {}", i + 1),
                    false,
                    issues,
                );
                if let Some(description) = str_field(item, "description") {
                    if utf16_len(description) > limits.media_description {
                        issues.push(Issue::error(
                            "GALLERY_DESC_LONG",
                            Some(item_path),
                            format!(
                                "Gallery item {} description must be ≤{} characters.",
                                i + 1,
                                limits.media_description
                            ),
                        ));
                    }
                }
            }
        }
        ct::FILE => {
            validate_media(
                node.get("file").unwrap_or(&Value::Null),
                path,
                "File",
                true,
                issues,
            );
        }
        ct::THUMBNAIL => {
            validate_media(
                node.get("media").unwrap_or(&Value::Null),
                path,
                "Thumbnail",
                false,
                issues,
            );
            if let Some(description) = str_field(node, "description") {
                if utf16_len(description) > limits.media_description {
                    issues.push(Issue::error(
                        "THUMB_DESC_LONG",
                        Some(path.to_string()),
                        format!(
                            "Thumbnail description must be ≤{} characters.",
                            limits.media_description
                        ),
                    ));
                }
            }
        }
        ct::ACTION_ROW => {
            let children = arr(node, "components");
            if children.is_empty() {
                issues.push(Issue::error(
                    "ROW_EMPTY",
                    Some(path.to_string()),
                    "Action row must contain at least one button or a select.",
                ));
            }
            let first_is_select = children
                .first()
                .is_some_and(|c| is_select_type(node_type(c)));
            if first_is_select {
                if children.len() != 1 {
                    issues.push(Issue::error(
                        "ROW_SELECT_MIXED",
                        Some(path.to_string()),
                        "An action row with a select must contain exactly one component.",
                    ));
                }
                validate_select(
                    &children[0],
                    &format!("{path}.components[0]"),
                    limits,
                    issues,
                );
            } else {
                if children.len() > limits.action_row_buttons {
                    issues.push(Issue::error(
                        "ROW_LIMIT",
                        Some(path.to_string()),
                        format!(
                            "Action row can hold at most {} buttons.",
                            limits.action_row_buttons
                        ),
                    ));
                }
                for (i, child) in children.iter().enumerate() {
                    if is_select_type(node_type(child)) {
                        issues.push(Issue::error(
                            "ROW_SELECT_MIXED",
                            Some(path.to_string()),
                            "Buttons and selects cannot share the same action row.",
                        ));
                    } else {
                        validate_button(child, &format!("{path}.components[{i}]"), data, issues);
                    }
                }
            }
        }
        ct::TEXT_DISPLAY => {
            let content = str_field(node, "content").unwrap_or("");
            if content.trim().is_empty() {
                issues.push(Issue::error(
                    "TEXT_EMPTY",
                    Some(path.to_string()),
                    "Text display can't be empty — Discord requires content here.",
                ));
            }
            if utf16_len(content) > limits.text_display_content {
                issues.push(Issue::error(
                    "TEXT_TOO_LONG",
                    Some(path.to_string()),
                    format!(
                        "Text content exceeds {} characters.",
                        limits.text_display_content
                    ),
                ));
            }
        }
        _ => {}
    }
}

fn is_select_type(kind: u64) -> bool {
    matches!(
        kind,
        ct::STRING_SELECT
            | ct::USER_SELECT
            | ct::ROLE_SELECT
            | ct::MENTIONABLE_SELECT
            | ct::CHANNEL_SELECT
    )
}

fn validate_button(btn: &Value, path: &str, data: &SchemaData, issues: &mut Vec<Issue>) {
    let limits = &data.limits;
    let style = u64_field(btn, "style").unwrap_or(0);

    if style == LINK {
        let url = str_field(btn, "url").unwrap_or("");
        if !contains_placeholder(url) && !is_valid_https_url(url) {
            issues.push(Issue::error(
                "BUTTON_URL_INVALID",
                Some(path.to_string()),
                "Link button needs a valid https:// URL.",
            ));
        } else if utf16_len(url) > limits.button_url {
            issues.push(Issue::error(
                "BUTTON_URL_LONG",
                Some(path.to_string()),
                format!("Link button URL must be ≤{} characters.", limits.button_url),
            ));
        }
        // A link-plugin URL that still carries a fill-me `{token}` would post a
        // button opening a dead link, with nothing to substitute it.
        if let Some(plugin) = data
            .link_plugins
            .iter()
            .filter(|p| url.starts_with(&p.prefix))
            .max_by_key(|p| p.prefix.len())
        {
            let mut seen: Vec<&str> = Vec::new();
            for token in placeholder_tokens(url) {
                if data.core_placeholder_tokens.iter().any(|t| t == token) {
                    continue;
                }
                if seen.contains(&token) {
                    continue;
                }
                seen.push(token);
                issues.push(Issue::error(
                    "BUTTON_LINK_URL_UNFINISHED",
                    Some(path.to_string()),
                    format!(
                        "{}: the URL still has a {{{token}}} placeholder — paste your finished link over it.",
                        plugin.name
                    ),
                ));
            }
        }
    } else if style == PREMIUM {
        match str_field(btn, "sku_id").filter(|s| !s.is_empty()) {
            None => issues.push(Issue::error(
                "BUTTON_SKU_MISSING",
                Some(path.to_string()),
                "Premium button requires a SKU id.",
            )),
            Some(sku) => {
                if !contains_placeholder(sku) && !is_snowflake(sku) {
                    issues.push(Issue::error(
                        "BUTTON_SKU_INVALID",
                        Some(path.to_string()),
                        "Premium button SKU id must be a Discord snowflake.",
                    ));
                }
            }
        }
    } else {
        match str_field(btn, "custom_id").filter(|s| !s.is_empty()) {
            None => issues.push(Issue::error(
                "BUTTON_CUSTOM_ID_MISSING",
                Some(path.to_string()),
                "Interactive button requires a custom_id (used by your bot).",
            )),
            Some(custom_id) => {
                if utf16_len(custom_id) > limits.button_custom_id {
                    issues.push(Issue::error(
                        "BUTTON_CUSTOM_ID_LONG",
                        Some(path.to_string()),
                        format!("custom_id must be ≤{} characters.", limits.button_custom_id),
                    ));
                }
            }
        }
    }

    let label = str_field(btn, "label").filter(|s| !s.is_empty());
    let emoji = btn.get("emoji").filter(|v| v.is_object());
    let has_emoji = emoji.is_some_and(|e| {
        str_field(e, "id").is_some_and(|s| !s.is_empty())
            || str_field(e, "name").is_some_and(|s| !s.is_empty())
    });
    if style != PREMIUM && label.is_none() && !has_emoji {
        issues.push(Issue::error(
            "BUTTON_NO_LABEL",
            Some(path.to_string()),
            "Button needs a label or an emoji — Discord rejects a button with neither.",
        ));
    }
    if let Some(label) = label {
        if utf16_len(label) > limits.button_label {
            issues.push(Issue::error(
                "BUTTON_LABEL_LONG",
                Some(path.to_string()),
                format!("Button label must be ≤{} characters.", limits.button_label),
            ));
        }
    }
    if let Some(emoji) = emoji {
        let has_id = str_field(emoji, "id").is_some_and(|s| !s.is_empty());
        let has_name = str_field(emoji, "name").is_some_and(|s| !s.is_empty());
        if has_id && !has_name {
            issues.push(Issue::error(
                "EMOJI_NAME_MISSING",
                Some(path.to_string()),
                "Custom emoji needs an alias name alongside its id.",
            ));
        }
    }
}

fn validate_select(sel: &Value, path: &str, limits: &Limits, issues: &mut Vec<Issue>) {
    match str_field(sel, "custom_id").filter(|s| !s.is_empty()) {
        None => issues.push(Issue::error(
            "SELECT_CUSTOM_ID_MISSING",
            Some(path.to_string()),
            "Select requires a custom_id (used by your bot).",
        )),
        Some(custom_id) => {
            if utf16_len(custom_id) > limits.select_custom_id {
                issues.push(Issue::error(
                    "SELECT_CUSTOM_ID_LONG",
                    Some(path.to_string()),
                    format!(
                        "Select custom_id must be ≤{} characters.",
                        limits.select_custom_id
                    ),
                ));
            }
        }
    }
    if let Some(placeholder) = str_field(sel, "placeholder").filter(|s| !s.is_empty()) {
        if utf16_len(placeholder) > limits.select_placeholder {
            issues.push(Issue::error(
                "SELECT_PLACEHOLDER_LONG",
                Some(path.to_string()),
                format!(
                    "Select placeholder must be ≤{} characters.",
                    limits.select_placeholder
                ),
            ));
        }
    }

    let min = sel.get("min_values").and_then(Value::as_i64).unwrap_or(1);
    let max = sel.get("max_values").and_then(Value::as_i64).unwrap_or(1);
    if min < limits.select_min_values || min > limits.select_max_values {
        issues.push(Issue::error(
            "SELECT_MIN_RANGE",
            Some(path.to_string()),
            format!(
                "min_values must be {}–{}.",
                limits.select_min_values, limits.select_max_values
            ),
        ));
    }
    if max < 1 || max > limits.select_max_values {
        issues.push(Issue::error(
            "SELECT_MAX_RANGE",
            Some(path.to_string()),
            format!("max_values must be 1–{}.", limits.select_max_values),
        ));
    }
    if min > max {
        issues.push(Issue::error(
            "SELECT_MIN_GT_MAX",
            Some(path.to_string()),
            "min_values cannot exceed max_values.",
        ));
    }

    if node_type(sel) == ct::STRING_SELECT {
        let options = arr(sel, "options");
        if options.is_empty() {
            issues.push(Issue::error(
                "SELECT_NO_OPTIONS",
                Some(path.to_string()),
                "String select needs at least one option.",
            ));
        }
        if options.len() > limits.select_options {
            issues.push(Issue::error(
                "SELECT_OPTIONS_LIMIT",
                Some(path.to_string()),
                format!(
                    "String select can hold at most {} options.",
                    limits.select_options
                ),
            ));
        }
        let mut seen_values: Vec<&str> = Vec::new();
        let mut defaults = 0i64;
        for (i, option) in options.iter().enumerate() {
            let where_ = format!("Option {}", i + 1);
            match str_field(option, "label").filter(|s| !s.is_empty()) {
                None => issues.push(Issue::error(
                    "OPTION_LABEL_MISSING",
                    Some(path.to_string()),
                    format!("{where_}: label is required."),
                )),
                Some(label) => {
                    if utf16_len(label) > limits.select_option_label {
                        issues.push(Issue::error(
                            "OPTION_LABEL_LONG",
                            Some(path.to_string()),
                            format!(
                                "{where_}: label must be ≤{} chars.",
                                limits.select_option_label
                            ),
                        ));
                    }
                }
            }
            match str_field(option, "value").filter(|s| !s.is_empty()) {
                None => issues.push(Issue::error(
                    "OPTION_VALUE_MISSING",
                    Some(path.to_string()),
                    format!("{where_}: value is required."),
                )),
                Some(value) => {
                    if utf16_len(value) > limits.select_option_value {
                        issues.push(Issue::error(
                            "OPTION_VALUE_LONG",
                            Some(path.to_string()),
                            format!(
                                "{where_}: value must be ≤{} chars.",
                                limits.select_option_value
                            ),
                        ));
                    }
                    if seen_values.contains(&value) {
                        issues.push(Issue::error(
                            "OPTION_VALUE_DUP",
                            Some(path.to_string()),
                            format!("{where_}: value \"{value}\" is duplicated."),
                        ));
                    } else {
                        seen_values.push(value);
                    }
                }
            }
            if let Some(description) = str_field(option, "description").filter(|s| !s.is_empty()) {
                if utf16_len(description) > limits.select_option_description {
                    issues.push(Issue::error(
                        "OPTION_DESC_LONG",
                        Some(path.to_string()),
                        format!(
                            "{where_}: description must be ≤{} chars.",
                            limits.select_option_description
                        ),
                    ));
                }
            }
            if let Some(emoji) = option.get("emoji").filter(|v| v.is_object()) {
                let has_id = str_field(emoji, "id").is_some_and(|s| !s.is_empty());
                let has_name = str_field(emoji, "name").is_some_and(|s| !s.is_empty());
                if has_id && !has_name {
                    issues.push(Issue::error(
                        "OPTION_EMOJI_NAME",
                        Some(path.to_string()),
                        format!("{where_}: custom emoji needs an alias name alongside its id."),
                    ));
                }
            }
            if option.get("default").and_then(Value::as_bool) == Some(true) {
                defaults += 1;
            }
        }
        if defaults > max {
            issues.push(Issue::error(
                "OPTION_DEFAULT_OVER_MAX",
                Some(path.to_string()),
                "More options marked default than max_values allows.",
            ));
        }
        if !options.is_empty() && max > options.len() as i64 {
            issues.push(Issue::error(
                "SELECT_MAX_OVER_OPTIONS",
                Some(path.to_string()),
                format!(
                    "max_values ({max}) can't exceed the number of options ({}).",
                    options.len()
                ),
            ));
        }
    } else {
        let defaults = arr(sel, "default_values");
        if defaults.len() > limits.select_default_values {
            issues.push(Issue::error(
                "SELECT_DEFAULTS_LIMIT",
                Some(path.to_string()),
                format!(
                    "default_values can have at most {} entries.",
                    limits.select_default_values
                ),
            ));
        }
        if defaults.len() as i64 > max {
            issues.push(Issue::error(
                "SELECT_DEFAULTS_OVER_MAX",
                Some(path.to_string()),
                "default_values has more entries than max_values allows.",
            ));
        }
        for entry in defaults {
            let id = str_field(entry, "id").unwrap_or("");
            if !is_snowflake(id) {
                issues.push(Issue::error(
                    "SELECT_DEFAULT_BAD_ID",
                    Some(path.to_string()),
                    format!("default_values: \"{id}\" is not a valid snowflake."),
                ));
            }
        }
    }
}

fn validate_media(
    media: &Value,
    path: &str,
    context: &str,
    require_attachment: bool,
    issues: &mut Vec<Issue>,
) {
    let url = str_field(media, "url").filter(|s| !s.is_empty());
    let attachment_id = str_field(media, "attachment_id").filter(|s| !s.is_empty());

    if url.is_none() && attachment_id.is_none() {
        issues.push(Issue::error(
            "MEDIA_REQUIRED",
            Some(path.to_string()),
            format!("{context} needs a URL or an attachment_id."),
        ));
        return;
    }
    if let Some(id) = attachment_id {
        if !is_snowflake(id) {
            issues.push(Issue::error(
                "MEDIA_ATTACHMENT_ID_BAD",
                Some(path.to_string()),
                format!("{context}: attachment_id must be a Discord snowflake."),
            ));
        }
    }
    let Some(url) = url else { return };
    if contains_placeholder(url) {
        // Resolves to a real link only at send; every format check is skipped
        // on the raw token form.
        return;
    }
    if !is_valid_media_url(url) {
        issues.push(Issue::error(
            "MEDIA_URL_INVALID",
            Some(path.to_string()),
            format!("{context}: URL must be https:// or attachment://filename."),
        ));
        return;
    }
    if url.starts_with("session://") {
        // Well-formed, and unresolvable here by construction: the bytes only
        // ever existed in the browser that uploaded them.
        issues.push(Issue::error(
            "ATTACHMENT_MISSING",
            Some(path.to_string()),
            format!(
                "{context} points at a file uploaded in someone's browser, which this server cannot reach — post from there, or use a public https:// URL."
            ),
        ));
        return;
    }
    if require_attachment && is_external_web_url(url) && !is_discord_cdn_url(url) {
        issues.push(Issue::error(
            "FILE_URL_NOT_ATTACHMENT",
            Some(path.to_string()),
            format!(
                "{context} can only display an uploaded attachment — use an attachment://filename reference, not an external URL."
            ),
        ));
    }
}

/// Discord rejects a message where two components share a numeric `id`, or two
/// interactive components share a `custom_id`. Every offender is flagged, not
/// just the second one, so a caller can see the whole collision.
fn validate_unique_ids(message: &Value, issues: &mut Vec<Issue>) {
    let mut nodes = Vec::new();
    walk(message, &mut nodes);

    let mut by_numeric: HashMap<i64, Vec<String>> = HashMap::new();
    let mut by_custom: HashMap<String, Vec<String>> = HashMap::new();
    for (path, node) in &nodes {
        if let Some(id) = node.get("id").and_then(Value::as_i64) {
            by_numeric.entry(id).or_default().push(path.clone());
        }
        let kind = node_type(node);
        if kind == ct::BUTTON || is_select_type(kind) {
            if let Some(custom_id) = str_field(node, "custom_id").filter(|s| !s.is_empty()) {
                by_custom
                    .entry(custom_id.to_string())
                    .or_default()
                    .push(path.clone());
            }
        }
    }

    let mut numeric: Vec<_> = by_numeric.into_iter().collect();
    numeric.sort_by_key(|(id, _)| *id);
    for (id, paths) in numeric {
        if paths.len() < 2 {
            continue;
        }
        for path in &paths {
            issues.push(Issue::error(
                "COMPONENT_ID_DUPLICATE",
                Some(path.clone()),
                format!(
                    "Component id {id} is used by {} components — each id must be unique within a message.",
                    paths.len()
                ),
            ));
        }
    }

    let mut custom: Vec<_> = by_custom.into_iter().collect();
    custom.sort_by(|a, b| a.0.cmp(&b.0));
    for (custom_id, paths) in custom {
        if paths.len() < 2 {
            continue;
        }
        for path in &paths {
            issues.push(Issue::error(
                "CUSTOM_ID_DUPLICATE",
                Some(path.clone()),
                format!(
                    "custom_id \"{custom_id}\" is used by {} components — each custom_id must be unique within a message.",
                    paths.len()
                ),
            ));
        }
    }
}

/* ─── Capabilities ───────────────────────────────────────────────────── */

/// What a message needs from its destination to work as built. Not a rejection:
/// the caller may well know their webhook is app-owned.
#[derive(Debug, Clone, Serialize)]
pub struct Requirement {
    pub kind: &'static str,
    pub title: String,
    pub detail: String,
}

pub fn requirements(message: &Value, thread_id_provided: bool) -> Vec<Requirement> {
    let mut nodes = Vec::new();
    walk(message, &mut nodes);

    let mut interactive = 0usize;
    let mut premium = 0usize;
    for (_, node) in &nodes {
        let kind = node_type(node);
        if is_select_type(kind) {
            interactive += 1;
        } else if kind == ct::BUTTON {
            match u64_field(node, "style").unwrap_or(0) {
                PREMIUM => premium += 1,
                LINK => {}
                _ => interactive += 1,
            }
        }
    }

    let mut out = Vec::new();
    if interactive > 0 {
        out.push(Requirement {
            kind: "app_webhook",
            title: format!(
                "Needs an app-owned webhook ({interactive} interactive component{})",
                if interactive == 1 { "" } else { "s" }
            ),
            detail: "Buttons and menus only work from a webhook owned by a bot or app. A regular webhook can't post them."
                .into(),
        });
    }
    if premium > 0 {
        out.push(Requirement {
            kind: "monetization",
            title: format!(
                "Needs app monetization ({premium} Premium button{})",
                if premium == 1 { "" } else { "s" }
            ),
            detail: "Premium buttons only work if the owning app has a product set up.".into(),
        });
    }

    let has_thread_name = str_field(message, "thread_name").is_some_and(|s| !s.is_empty());
    let has_tags = !arr(message, "applied_tags").is_empty();
    if has_thread_name || has_tags {
        out.push(Requirement {
            kind: "forum_channel",
            title: "Needs a forum or media channel".into(),
            detail: "A forum post title and applied tags only work in a forum or media channel — Discord rejects a post to other channel kinds while they are set."
                .into(),
        });
    }
    if has_thread_name && thread_id_provided {
        out.push(Requirement {
            kind: "conflict",
            title: "Two thread settings clash".into(),
            detail: "A thread to post in and a new forum post title are both set. Discord uses the thread and ignores the title — pick one."
                .into(),
        });
    } else if thread_id_provided {
        out.push(Requirement {
            kind: "existing_thread",
            title: "Posts into an existing thread".into(),
            detail: "A thread is set, so this posts there instead of the webhook's main channel."
                .into(),
        });
    }
    if message.get("tts").and_then(Value::as_bool) == Some(true) {
        out.push(Requirement {
            kind: "tts_noop",
            title: "Text-to-speech won't play".into(),
            detail: "Text-to-speech reads plain text, which this message type doesn't use. The setting is ignored."
                .into(),
        });
    }
    out
}

/* ─── Destination ────────────────────────────────────────────────────── */

/// Discord channel types that only accept posts starting a new thread.
pub const THREAD_ONLY_CHANNEL_TYPES: [u64; 2] = [15, 16];

/// The `thread_name` rule cuts both ways: a forum/media destination requires
/// one (it is the post's title), and every other channel kind rejects a post
/// that carries one. Checked separately from [`validate`], which is
/// destination-agnostic.
pub fn validate_destination(
    message: &Value,
    channel_type: Option<u64>,
    channel_name: Option<&str>,
) -> Vec<Issue> {
    let Some(channel_type) = channel_type else {
        return Vec::new();
    };
    let has_title = str_field(message, "thread_name").is_some_and(|s| !s.trim().is_empty());
    let dest = channel_name
        .map(|n| format!("#{n}"))
        .unwrap_or_else(|| "this channel".into());

    if THREAD_ONLY_CHANNEL_TYPES.contains(&channel_type) {
        if has_title {
            return Vec::new();
        }
        let kind = if channel_type == 16 { "media" } else { "forum" };
        return vec![Issue::error(
            "THREAD_NAME_REQUIRED",
            None,
            format!("Posting to {dest} starts a new {kind} post, which needs a title — set `thread_name` on the message."),
        )];
    }
    if !has_title {
        return Vec::new();
    }
    vec![Issue::error(
        "THREAD_NAME_FORBIDDEN",
        None,
        format!("Discord rejects a post to {dest} while `thread_name` is set — clear it, or pick a forum/media channel."),
    )]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// The shared corpus: messages plus the exact `(code, path)` pairs the
    /// TypeScript validator produces for each. See the module comment.
    #[derive(Deserialize)]
    struct Corpus {
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        message: Value,
        errors: Vec<RecordedIssue>,
        warnings: Vec<RecordedIssue>,
    }

    #[derive(Deserialize, PartialEq, Eq, Debug, Clone)]
    struct RecordedIssue {
        code: String,
        path: Option<String>,
    }

    fn schema_data() -> SchemaData {
        serde_json::from_str(include_str!("catalog.json")).expect("catalog.json parses")
    }

    fn corpus() -> Corpus {
        serde_json::from_str(include_str!("validation-corpus.json"))
            .expect("validation-corpus.json parses")
    }

    /// Same ordering the generator applies, so a comparison is about content
    /// rather than traversal order.
    fn recorded(issues: &[Issue], severity: Severity) -> Vec<RecordedIssue> {
        let mut out: Vec<RecordedIssue> = Vec::new();
        for issue in issues.iter().filter(|i| i.severity == severity) {
            let entry = RecordedIssue {
                code: issue.code.to_string(),
                path: issue.path.clone(),
            };
            if !out.contains(&entry) {
                out.push(entry);
            }
        }
        out.sort_by(|a, b| {
            a.code.cmp(&b.code).then_with(|| {
                a.path
                    .clone()
                    .unwrap_or_default()
                    .cmp(&b.path.clone().unwrap_or_default())
            })
        });
        out
    }

    /// The whole point of this file: every rule, on both sides, agreeing.
    #[test]
    fn matches_the_typescript_validator_on_every_corpus_case() {
        let data = schema_data();
        let corpus = corpus();
        assert!(
            corpus.cases.len() >= 100,
            "corpus shrank to {} cases",
            corpus.cases.len()
        );

        let mut failures: Vec<String> = Vec::new();
        for case in &corpus.cases {
            // The corpus stores the wire form, already carrying the repairs the
            // boundary applies, so normalizing is a no-op that also proves the
            // boundary accepts everything the browser can produce.
            let message = match normalize(case.message.clone()) {
                Ok(m) => m,
                Err(e) => {
                    failures.push(format!("{}: normalize refused it: {e}", case.name));
                    continue;
                }
            };
            let issues = validate(&message, &data);
            let errors = recorded(&issues, Severity::Error);
            let warnings = recorded(&issues, Severity::Warning);
            if errors != case.errors {
                failures.push(format!(
                    "{}: errors\n  rust: {errors:?}\n  ts:   {:?}",
                    case.name, case.errors
                ));
            }
            if warnings != case.warnings {
                failures.push(format!(
                    "{}: warnings\n  rust: {warnings:?}\n  ts:   {:?}",
                    case.name, case.warnings
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} corpus cases disagree with the TypeScript validator:\n{}",
            failures.len(),
            corpus.cases.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn every_rule_in_the_corpus_is_one_this_validator_can_emit() {
        // Guards the other direction from the generator's coverage check: a code
        // recorded in the corpus that Rust never emits would make the case above
        // fail with a confusing diff, so name it here instead.
        let data = schema_data();
        let corpus = corpus();
        let mut produced: Vec<String> = Vec::new();
        for case in &corpus.cases {
            if let Ok(message) = normalize(case.message.clone()) {
                for issue in validate(&message, &data) {
                    let code = issue.code.to_string();
                    if !produced.contains(&code) {
                        produced.push(code);
                    }
                }
            }
        }
        let mut expected: Vec<String> = Vec::new();
        for case in &corpus.cases {
            for issue in case.errors.iter().chain(case.warnings.iter()) {
                if !expected.contains(&issue.code) {
                    expected.push(issue.code.clone());
                }
            }
        }
        expected.sort();
        produced.sort();
        assert_eq!(expected, produced, "rule coverage differs from the corpus");
    }

    #[test]
    fn utf16_lengths_match_javascript() {
        assert_eq!(utf16_len("abc"), 3);
        // One code point, two UTF-16 units, four UTF-8 bytes — the number that
        // has to match is 2.
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!("😀".chars().count(), 1);
        assert_eq!("😀".len(), 4);
    }

    #[test]
    fn placeholder_tokens_are_strict() {
        assert!(contains_placeholder("{server_icon}"));
        assert!(contains_placeholder("https://e.test/{form_id}/go"));
        // Ordinary prose must not read as a placeholder.
        assert!(!contains_placeholder("{ this }"));
        assert!(!contains_placeholder("{TODO}"));
        assert!(!contains_placeholder("no braces here"));
        assert!(!contains_placeholder("{}"));
        let tokens: Vec<&str> = placeholder_tokens("a{one}b{two}c").collect();
        assert_eq!(tokens, vec!["one", "two"]);
    }

    #[test]
    fn the_boundary_refuses_what_it_cannot_validate() {
        assert!(normalize(Value::String("nope".into())).is_err());
        assert!(normalize(serde_json::json!({})).is_err());
        assert!(normalize(serde_json::json!({ "components": [1] })).is_err());
        assert!(normalize(serde_json::json!({ "components": [{ "content": "x" }] })).is_err());
        // Components V2 forbids these, and dropping them silently would post a
        // message missing content the caller wrote.
        assert!(normalize(serde_json::json!({ "components": [], "content": "hi" })).is_err());
        assert!(normalize(serde_json::json!({ "components": [], "embeds": [] })).is_err());
    }

    #[test]
    fn the_boundary_repairs_rather_than_refuses_a_missing_field() {
        let repaired = normalize(serde_json::json!({
            "components": [
                { "type": 10 },
                { "type": 17 },
                { "type": 12 },
                { "type": 11 },
                { "type": 2, "style": 5, "label": "x" }
            ]
        }))
        .expect("repairable");
        let components = repaired["components"].as_array().unwrap();
        assert_eq!(components[0]["content"], Value::String(String::new()));
        assert_eq!(components[1]["components"], Value::Array(vec![]));
        assert_eq!(components[2]["items"], Value::Array(vec![]));
        assert_eq!(components[3]["media"]["url"], Value::String(String::new()));
        assert_eq!(components[4]["url"], Value::String(String::new()));
    }

    #[test]
    fn to_wire_forces_the_components_v2_flag_and_keeps_the_others() {
        let plain = to_wire(&serde_json::json!({ "components": [] }));
        assert_eq!(plain["flags"], Value::from(FLAG_IS_COMPONENTS_V2));
        let silent = to_wire(&serde_json::json!({
            "components": [],
            "flags": FLAG_SUPPRESS_NOTIFICATIONS
        }));
        assert_eq!(
            silent["flags"],
            Value::from(FLAG_IS_COMPONENTS_V2 | FLAG_SUPPRESS_NOTIFICATIONS)
        );
    }

    #[test]
    fn a_forum_destination_needs_a_title_and_every_other_kind_refuses_one() {
        let titled = serde_json::json!({ "components": [], "thread_name": "Patch notes" });
        let plain = serde_json::json!({ "components": [] });

        assert!(validate_destination(&titled, Some(15), None).is_empty());
        assert_eq!(
            validate_destination(&plain, Some(15), Some("help"))[0].code,
            "THREAD_NAME_REQUIRED"
        );
        assert!(validate_destination(&plain, Some(0), None).is_empty());
        assert_eq!(
            validate_destination(&titled, Some(0), None)[0].code,
            "THREAD_NAME_FORBIDDEN"
        );
        // No destination known: nothing to say.
        assert!(validate_destination(&titled, None, None).is_empty());
    }
}
