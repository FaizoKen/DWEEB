//! SQLite-backed instance store.
//!
//! One table. `instances` holds one JSON config blob per directory, keyed by the
//! opaque public id in the component's `custom_id`. A separate random edit token
//! authorizes replacement and only its SHA-256 digest is stored.
//!
//! There is deliberately **no second table**. A directory is a pure read of the
//! live server, so unlike the poll's ballots or the giveaway's entries this
//! plugin accumulates no per-member state — which is also why a replacement
//! instance loses nothing but the config itself.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

// ── Limits (also enforced in `validate.rs`, which explains each to the user) ──

pub const MAX_ROLES: usize = 25;
pub const MAX_GROUPS: usize = 10;
pub const MAX_CHANNELS: usize = 50;
pub const MAX_CATEGORIES: usize = 25;
pub const MAX_NOTES: usize = 60;
pub const MAX_TITLE: usize = 100;
pub const MAX_INTRO: usize = 400;
pub const MAX_NOTE_TEXT: usize = 150;
pub const MAX_GROUP_NAME: usize = 60;
pub const MAX_MEMBERS_PER_ROLE: u32 = 50;

/// A role referenced by id. `name`/`color`/`position` are cached at save time so
/// the config UI can render nicely and a reply can still name a role if a live
/// fetch degrades — the `id` is the only field that matters for matching.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Discord role colour as a 24-bit integer (0 = no colour). Cosmetic.
    #[serde(default)]
    pub color: u32,
}

/// A channel referenced by id. As with [`RoleRef`], everything but `id` is a
/// cached convenience.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Discord channel type (0 text, 2 voice, 4 category, 5 announcement, …).
    #[serde(default)]
    pub kind: u8,
}

/// One named section of the roster — "Owners", "Moderators", "Content team".
///
/// `key` is minted by the config UI and stays stable across edits because it is
/// the `value` wired onto a select option; renaming a group must not re-key it,
/// or a posted menu's options stop matching what a click resolves.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub key: String,
    #[serde(default)]
    pub name: String,
    /// Optional leading glyph for the section heading and the select option.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// Role ids in this section, in the order the host arranged them.
    #[serde(default)]
    pub role_ids: Vec<String>,
}

/// A host-written line attached to one role or channel id — the "what this role
/// actually does" subtitle a Discord role has no field for, and the caption for
/// a channel whose topic is empty or too terse.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub text: String,
}

/// Who may use this directory. Empty/zero fields mean "no restriction" — open to
/// everyone by default. Mirrors the poll and giveaway plugins' gate so the
/// config UI reads the same everywhere.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Requirement {
    /// Roles gating use. Empty = no role requirement.
    #[serde(default)]
    pub roles: Vec<RoleRef>,
    /// When true a member must hold **all** of `roles`; otherwise **any one**.
    #[serde(default)]
    pub require_all: bool,
    /// Minimum Discord account age in days (0 = no minimum). Derived from the
    /// member's user-id snowflake at click time — no Discord call needed.
    #[serde(default)]
    pub min_account_age_days: u32,
}

impl Requirement {
    /// True when nothing is gated — the common case, so the gate is skipped.
    pub fn is_open(&self) -> bool {
        self.roles.is_empty() && self.min_account_age_days == 0
    }
}

/// Which roles the roster lists.
pub const ROLE_SOURCE_PICKED: &str = "picked";
pub const ROLE_SOURCE_HOISTED: &str = "hoisted";
pub const ROLE_SOURCE_STAFF: &str = "staff";

/// Which channels the index lists.
pub const CHANNEL_SOURCE_PICKED: &str = "picked";
pub const CHANNEL_SOURCE_CATEGORIES: &str = "categories";
pub const CHANNEL_SOURCE_ALL: &str = "all";

pub const MODE_ROLES: &str = "roles";
pub const MODE_CHANNELS: &str = "channels";

/// Where the answer appears.
///
/// `"reply"` — a separate reply to the clicker (ephemeral unless `public`). The
/// default, and the right choice for a long roster: it has its own 4000-character
/// budget and leaves the channel clean.
///
/// `"message"` — the list is written **into the host's own message**, wherever
/// they put a `{directory}` placeholder, and a click re-stamps it in place. So it
/// is visible to everyone *without* clicking, and any click refreshes it for
/// everyone. The trade-off is that the list now shares the message's single
/// 4000-character Components V2 budget with the author's own text, which is why
/// the text renderer has its own tighter cap.
pub const OUTPUT_REPLY: &str = "reply";
pub const OUTPUT_MESSAGE: &str = "message";

/// The placeholder tokens this plugin offers for the host's message text.
///
/// Deliberately namespaced. A bare `{roles}` would collide with the Self Role
/// plugin's own declared token, and the host resolves a collision first-wins in
/// binding order — so two plugins on one message would silently fight over it.
pub const TOKEN_LIST: &str = "directory";
pub const TOKEN_COUNT: &str = "directory_count";
pub const TOKEN_UPDATED: &str = "directory_updated";

/// Upper bound on a stored `message_template`, mirroring the poll plugin. The
/// template is the author's whole component tree, so this bounds both the row and
/// the work a click does re-rendering it.
pub const MAX_TEMPLATE_BYTES: usize = 16 * 1024;

pub const TARGET_BUTTON: &str = "button";
pub const TARGET_STRING_SELECT: &str = "string_select";

/// The full, stored configuration for one directory.
///
/// New fields are additive with serde defaults so configs written by an older
/// build keep deserializing. [`normalize`](Self::normalize) then folds anything
/// unrecognised back onto a valid value, so every reader downstream — the
/// renderer especially — only ever sees the canonical model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceConfig {
    /// `"button"` or `"string_select"` — the component kind this binds to.
    #[serde(default = "default_target")]
    pub target: String,
    /// `"roles"` (a staff/role roster) or `"channels"` (a channel index).
    #[serde(default = "default_mode")]
    pub mode: String,
    /// The guild this directory reads. Cross-checked against the interaction's
    /// guild at click time so a posted directory can't be reused elsewhere.
    pub guild_id: String,
    /// Cached guild name for the config UI. Cosmetic.
    #[serde(default)]
    pub guild_name: String,

    // ── Presentation (both modes) ────────────────────────────────────────────
    /// Heading of the reply. Empty = a sensible default per mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Optional line under the heading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro: Option<String>,
    /// When true the reply is posted for the whole channel to see; otherwise —
    /// the default — it is ephemeral, visible only to whoever clicked. Ignored in
    /// `"message"` output, where the list lives in the host's own public message.
    #[serde(default)]
    pub public: bool,
    /// [`OUTPUT_REPLY`] (default) or [`OUTPUT_MESSAGE`] — see those constants.
    #[serde(default = "default_output")]
    pub output: String,
    /// `"message"` output only: the author's component tree with this plugin's
    /// own `{token}`s left raw, captured at save time.
    ///
    /// The host bakes every *foreign* token (core `{server}`, another plugin's)
    /// to its first-paint value before handing this over, so re-rendering can't
    /// decay someone else's placeholder into literal text. Re-rendering always
    /// starts from this raw template rather than from the live message, which is
    /// what makes a refresh idempotent — otherwise the second click would try to
    /// substitute into text where the token has already been replaced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_template: Option<Value>,
    /// Container accent colour (24-bit). None = no accent stripe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<u32>,
    /// Per-id host copy, for roles or channels depending on `mode`.
    #[serde(default)]
    pub notes: Vec<Note>,
    /// Who may use this directory.
    #[serde(default)]
    pub requirements: Requirement,

    // ── Roles mode ──────────────────────────────────────────────────────────
    /// `"picked"` (only `roles`), `"hoisted"` (roles Discord shows separately in
    /// the member list — the server's own idea of "notable"), or `"staff"`
    /// (roles carrying a moderation permission).
    #[serde(default = "default_role_source")]
    pub role_source: String,
    /// The roles listed when `role_source` is `"picked"`, in the host's order.
    #[serde(default)]
    pub roles: Vec<RoleRef>,
    /// Named sections. Empty = one flat list in Discord's hierarchy order.
    #[serde(default)]
    pub groups: Vec<Group>,
    /// Expand each role into the members who hold it.
    ///
    /// This is the only part of the plugin that needs Discord's **privileged
    /// `GUILD_MEMBERS` intent** — `GET /guilds/{id}/members` is gated on it while
    /// roles and channels are not. It is therefore an *enhancement*: with the
    /// intent off, the roster still renders (names, colours, permission badges,
    /// host notes) and simply says the member list is unavailable. See
    /// `rest::MemberScanOutcome`.
    #[serde(default)]
    pub show_members: bool,
    /// Cap on names listed per role before "+N more". 1..=[`MAX_MEMBERS_PER_ROLE`].
    #[serde(default = "default_max_members")]
    pub max_members_per_role: u32,
    /// List bot accounts alongside people. Off by default: a staff roster is
    /// about people, and integration roles are usually held by a bot that would
    /// pad every section. Counts follow the same rule, so "3 members" means
    /// three humans unless this is on.
    #[serde(default)]
    pub include_bots: bool,
    /// Show a compact badge line derived from each role's permission bits
    /// ("Admin · Bans · Timeouts") — what makes a roster readable as a *staff*
    /// list even when member expansion is unavailable.
    #[serde(default = "default_true")]
    pub show_permissions: bool,
    /// Skip roles that nobody holds. Only meaningful once members are known.
    #[serde(default)]
    pub hide_empty_roles: bool,

    // ── Channels mode ───────────────────────────────────────────────────────
    /// `"picked"` (only `channels`), `"categories"` (everything under
    /// `categories`), or `"all"`.
    #[serde(default = "default_channel_source")]
    pub channel_source: String,
    /// The channels listed when `channel_source` is `"picked"`, in host order.
    #[serde(default)]
    pub channels: Vec<ChannelRef>,
    /// The categories listed when `channel_source` is `"categories"`.
    #[serde(default)]
    pub categories: Vec<ChannelRef>,
    /// Discord channel types to include. Empty = the renderer's default set.
    #[serde(default)]
    pub include_kinds: Vec<u8>,
    /// Only list a channel that actually has a topic (or a host note).
    #[serde(default)]
    pub require_topic: bool,
    /// Group the list under its Discord category headings.
    #[serde(default = "default_true")]
    pub group_by_category: bool,
    /// Show each channel's topic under its mention.
    #[serde(default = "default_true")]
    pub show_topics: bool,
}

fn default_target() -> String {
    TARGET_BUTTON.to_string()
}
fn default_mode() -> String {
    MODE_ROLES.to_string()
}
fn default_role_source() -> String {
    ROLE_SOURCE_PICKED.to_string()
}
fn default_channel_source() -> String {
    CHANNEL_SOURCE_ALL.to_string()
}
fn default_output() -> String {
    OUTPUT_REPLY.to_string()
}
fn default_max_members() -> u32 {
    20
}
fn default_true() -> bool {
    true
}

impl InstanceConfig {
    /// True when this is a role roster (rather than a channel index).
    pub fn is_roles(&self) -> bool {
        self.mode == MODE_ROLES
    }

    /// True when a click re-stamps the host's own message instead of replying.
    pub fn writes_to_message(&self) -> bool {
        self.output == OUTPUT_MESSAGE
    }

    /// The host's note for one role/channel id, if any.
    pub fn note_for(&self, id: &str) -> Option<&str> {
        self.notes
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.text.trim())
            .filter(|t| !t.is_empty())
    }

    /// Fold every out-of-range or unrecognised value back onto a valid one.
    ///
    /// Called on **every** read from the store, not just on save, so a config
    /// written by an older build (or hand-edited in the database) can never
    /// reach the renderer in a shape it doesn't expect. The renderer then needs
    /// no defensive branches of its own.
    pub fn normalize(&mut self) {
        if self.target != TARGET_STRING_SELECT {
            self.target = TARGET_BUTTON.to_string();
        }
        if self.mode != MODE_CHANNELS {
            self.mode = MODE_ROLES.to_string();
        }
        if self.output != OUTPUT_MESSAGE {
            self.output = OUTPUT_REPLY.to_string();
        }
        // A template only means anything in "message" output. Dropping it when the
        // author switches back to a reply keeps the row from carrying a stale copy
        // of a message they've since rewritten.
        if self.output != OUTPUT_MESSAGE {
            self.message_template = None;
        }
        // A template that isn't an array isn't a component tree. Refusing it here
        // rather than at render time means the click path never has to branch on a
        // shape that can't work.
        if self
            .message_template
            .as_ref()
            .is_some_and(|t| !t.is_array())
        {
            self.message_template = None;
        }
        if ![ROLE_SOURCE_PICKED, ROLE_SOURCE_HOISTED, ROLE_SOURCE_STAFF]
            .contains(&self.role_source.as_str())
        {
            self.role_source = ROLE_SOURCE_PICKED.to_string();
        }
        if ![
            CHANNEL_SOURCE_PICKED,
            CHANNEL_SOURCE_CATEGORIES,
            CHANNEL_SOURCE_ALL,
        ]
        .contains(&self.channel_source.as_str())
        {
            self.channel_source = CHANNEL_SOURCE_ALL.to_string();
        }
        self.max_members_per_role = self.max_members_per_role.clamp(1, MAX_MEMBERS_PER_ROLE);

        self.roles.truncate(MAX_ROLES);
        self.channels.truncate(MAX_CHANNELS);
        self.categories.truncate(MAX_CATEGORIES);
        self.notes.truncate(MAX_NOTES);
        self.groups.truncate(MAX_GROUPS);
        for g in &mut self.groups {
            g.role_ids.truncate(MAX_ROLES);
        }
        // A group whose name and roles are both gone is noise, not a section.
        self.groups
            .retain(|g| !g.role_ids.is_empty() || !g.name.trim().is_empty());

        clamp_opt(&mut self.title, MAX_TITLE);
        clamp_opt(&mut self.intro, MAX_INTRO);
        for n in &mut self.notes {
            n.text = clamp(&n.text, MAX_NOTE_TEXT);
        }
        for g in &mut self.groups {
            g.name = clamp(&g.name, MAX_GROUP_NAME);
        }
    }

    /// Every role id this roster may show, in host order: the group members when
    /// grouped, else the flat pick list. Used by validation and by the renderer
    /// to decide whether a `"picked"` source has anything to show at all.
    pub fn picked_role_ids(&self) -> Vec<String> {
        if self.groups.is_empty() {
            return self.roles.iter().map(|r| r.id.clone()).collect();
        }
        let mut out = Vec::new();
        for g in &self.groups {
            for id in &g.role_ids {
                if !out.contains(id) {
                    out.push(id.clone());
                }
            }
        }
        out
    }
}

fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn clamp_opt(field: &mut Option<String>, max: usize) {
    if let Some(v) = field {
        let trimmed = clamp(v.trim(), max);
        if trimmed.is_empty() {
            *field = None;
        } else {
            *v = trimmed;
        }
    }
}

/// What the config UI is allowed to read back. There is no secret in a directory
/// config — no bot token (the deployment's shared bot is used) and no webhook —
/// so this is the config verbatim plus its id.
#[derive(Debug, Serialize)]
pub struct MaskedInstance {
    pub id: String,
    #[serde(flatten)]
    pub config: InstanceConfig,
}

pub struct Store {
    conn: Mutex<Connection>,
}

pub enum EditLookup {
    Authorized,
    Unknown,
    Forbidden,
}

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Take the connection lock, shrugging off poisoning.
    ///
    /// The only thing that runs under this lock is `rusqlite` work, which
    /// returns errors rather than panicking — so the lock can't actually be
    /// poisoned today. Recovering anyway (instead of `unwrap()`) keeps one
    /// unlucky panic in a future caller from bricking every later DB op for the
    /// life of the process.
    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Insert a new instance and store only the edit-token digest.
    pub fn create(
        &self,
        id: &str,
        edit_token: &str,
        config: &InstanceConfig,
    ) -> rusqlite::Result<()> {
        let json = serde_json::to_string(config).expect("serialize config");
        let token_hash = hash_edit_token(edit_token);
        let now = unix_millis();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO instances (id, created_at, config, edit_token_hash)
             VALUES (?1, ?2, ?3, ?4)",
            (id, now, json, token_hash),
        )?;
        Ok(())
    }

    /// Decide whether this browser may replace `id` in place. The instance id is
    /// a public binding (it lives in the message's `custom_id`), so a rebind
    /// needs the separate 256-bit edit credential. Rows written before protocol
    /// v2 carry a null digest and deliberately cannot be updated — the config UI
    /// turns the resulting 403 into a create-a-replacement flow.
    pub fn authorize_edit(&self, id: &str, edit_token: &str) -> rusqlite::Result<EditLookup> {
        let conn = self.lock();
        let row: Option<Option<String>> = conn
            .query_row(
                "SELECT edit_token_hash FROM instances WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        drop(conn);
        let Some(stored_hash) = row else {
            return Ok(EditLookup::Unknown);
        };
        let Some(stored_hash) = stored_hash else {
            return Ok(EditLookup::Forbidden);
        };
        Ok(if edit_token_matches(edit_token, &stored_hash) {
            EditLookup::Authorized
        } else {
            EditLookup::Forbidden
        })
    }

    /// Atomically replace only when the edit-token digest matches. The `WHERE`
    /// re-checks the digest so this is safe on its own even without the
    /// `authorize_edit` pre-flight (which exists to distinguish 404 from 403).
    pub fn update(
        &self,
        id: &str,
        edit_token: &str,
        config: &InstanceConfig,
    ) -> rusqlite::Result<bool> {
        let json = serde_json::to_string(config).expect("serialize config");
        let token_hash = hash_edit_token(edit_token);
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE instances SET config = ?2 WHERE id = ?1 AND edit_token_hash = ?3",
            (id, json, token_hash),
        )?;
        Ok(n > 0)
    }

    /// Read an instance, normalized so callers only see the canonical model.
    pub fn get(&self, id: &str) -> rusqlite::Result<Option<InstanceConfig>> {
        let conn = self.lock();
        let row: Option<String> = conn
            .query_row("SELECT config FROM instances WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        drop(conn);
        Ok(row.and_then(|json| {
            serde_json::from_str::<InstanceConfig>(&json)
                .ok()
                .map(|mut c| {
                    c.normalize();
                    c
                })
        }))
    }

    /// Cheap liveness probe for `/health`-adjacent checks and boot verification.
    pub fn ping(&self) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.query_row("SELECT 1", [], |_| Ok(()))
    }
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         CREATE TABLE IF NOT EXISTS instances (
             id              TEXT PRIMARY KEY,
             created_at      INTEGER NOT NULL,
             config          TEXT NOT NULL,
             edit_token_hash TEXT
         );",
    )
}

fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hash_edit_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// Compare a presented token against the stored digest without leaking the
/// match length through timing.
fn edit_token_matches(presented: &str, stored_hash: &str) -> bool {
    let computed = hash_edit_token(presented);
    crate::discord::constant_time_eq(computed.as_bytes(), stored_hash.as_bytes())
}

/// Shared test fixtures. `pub(crate)` so `render`, `validate` and `discord` can
/// all build on one canonical config instead of each inventing its own.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn base_config() -> InstanceConfig {
        InstanceConfig {
            target: TARGET_BUTTON.into(),
            mode: MODE_ROLES.into(),
            guild_id: "100000000000000000".into(),
            guild_name: "Test".into(),
            title: None,
            intro: None,
            public: false,
            output: OUTPUT_REPLY.into(),
            message_template: None,
            accent_color: None,
            notes: vec![],
            requirements: Requirement::default(),
            role_source: ROLE_SOURCE_PICKED.into(),
            roles: vec![],
            groups: vec![],
            show_members: false,
            max_members_per_role: 20,
            include_bots: false,
            show_permissions: true,
            hide_empty_roles: false,
            channel_source: CHANNEL_SOURCE_ALL.into(),
            channels: vec![],
            categories: vec![],
            include_kinds: vec![],
            require_topic: false,
            group_by_category: true,
            show_topics: true,
        }
    }

    /// An unrecognised enum-ish string must fold onto a valid one rather than
    /// reaching the renderer, which branches on these without a fallback arm.
    #[test]
    fn normalize_folds_unknown_values_onto_valid_ones() {
        let mut cfg = base_config();
        cfg.target = "wat".into();
        cfg.mode = "wat".into();
        cfg.role_source = "wat".into();
        cfg.channel_source = "wat".into();
        cfg.normalize();
        assert_eq!(cfg.target, TARGET_BUTTON);
        assert_eq!(cfg.mode, MODE_ROLES);
        assert_eq!(cfg.role_source, ROLE_SOURCE_PICKED);
        assert_eq!(cfg.channel_source, CHANNEL_SOURCE_ALL);
    }

    /// Switching back to a reply must drop the template, or the row keeps a stale
    /// copy of a message the author has since rewritten — which would come back if
    /// they ever switched to in-message output again.
    #[test]
    fn normalize_drops_a_template_that_no_longer_applies() {
        let template = serde_json::json!([{ "type": 10, "content": "{directory}" }]);

        let mut cfg = base_config();
        cfg.output = OUTPUT_MESSAGE.into();
        cfg.message_template = Some(template.clone());
        cfg.normalize();
        assert!(cfg.writes_to_message());
        assert!(cfg.message_template.is_some(), "kept in message output");

        cfg.output = OUTPUT_REPLY.into();
        cfg.normalize();
        assert!(cfg.message_template.is_none(), "dropped in reply output");

        // An unrecognised output value folds onto the safe default…
        let mut cfg = base_config();
        cfg.output = "wat".into();
        cfg.message_template = Some(template);
        cfg.normalize();
        assert_eq!(cfg.output, OUTPUT_REPLY);
        assert!(cfg.message_template.is_none());
    }

    /// A template that isn't a component tree is refused here, so the click path
    /// never has to branch on a shape that can't render.
    #[test]
    fn normalize_drops_a_template_that_is_not_an_array() {
        let mut cfg = base_config();
        cfg.output = OUTPUT_MESSAGE.into();
        cfg.message_template = Some(serde_json::json!({ "not": "an array" }));
        cfg.normalize();
        assert!(cfg.message_template.is_none());
    }

    #[test]
    fn normalize_clamps_counts_and_text() {
        let mut cfg = base_config();
        cfg.max_members_per_role = 9999;
        cfg.title = Some(" ".repeat(4) + &"t".repeat(500));
        cfg.notes = vec![Note {
            id: "1".into(),
            text: "n".repeat(500),
        }];
        cfg.normalize();
        assert_eq!(cfg.max_members_per_role, MAX_MEMBERS_PER_ROLE);
        assert_eq!(cfg.title.as_ref().unwrap().chars().count(), MAX_TITLE);
        assert_eq!(cfg.notes[0].text.chars().count(), MAX_NOTE_TEXT);

        // A zero cap is raised to 1, never left at 0 (which would render every
        // role as a bare "+N more").
        let mut cfg = base_config();
        cfg.max_members_per_role = 0;
        cfg.normalize();
        assert_eq!(cfg.max_members_per_role, 1);
    }

    /// A whitespace-only title is the same as no title: the renderer must fall
    /// back to its per-mode default rather than print a blank heading line.
    #[test]
    fn normalize_drops_blank_optional_text() {
        let mut cfg = base_config();
        cfg.title = Some("   ".into());
        cfg.intro = Some("\n\t ".into());
        cfg.normalize();
        assert!(cfg.title.is_none());
        assert!(cfg.intro.is_none());
    }

    #[test]
    fn normalize_drops_a_group_with_neither_name_nor_roles() {
        let mut cfg = base_config();
        cfg.groups = vec![
            Group {
                key: "g1".into(),
                name: "Staff".into(),
                emoji: None,
                role_ids: vec!["1".into()],
            },
            Group {
                key: "g2".into(),
                name: "  ".into(),
                emoji: None,
                role_ids: vec![],
            },
        ];
        cfg.normalize();
        assert_eq!(cfg.groups.len(), 1);
        assert_eq!(cfg.groups[0].key, "g1");
    }

    /// Grouped rosters take their role ids from the groups (deduped, in order);
    /// ungrouped ones from the flat list.
    #[test]
    fn picked_role_ids_prefers_groups_and_dedupes() {
        let mut cfg = base_config();
        cfg.roles = vec![RoleRef {
            id: "flat".into(),
            name: "Flat".into(),
            color: 0,
        }];
        assert_eq!(cfg.picked_role_ids(), vec!["flat".to_string()]);

        cfg.groups = vec![
            Group {
                key: "g1".into(),
                name: "A".into(),
                emoji: None,
                role_ids: vec!["r1".into(), "r2".into()],
            },
            Group {
                key: "g2".into(),
                name: "B".into(),
                emoji: None,
                // r2 appears twice across groups — one role can legitimately sit
                // in two sections, but the id list must not double-count it.
                role_ids: vec!["r2".into(), "r3".into()],
            },
        ];
        assert_eq!(
            cfg.picked_role_ids(),
            vec!["r1".to_string(), "r2".to_string(), "r3".to_string()]
        );
    }

    #[test]
    fn note_lookup_ignores_blank_text() {
        let mut cfg = base_config();
        cfg.notes = vec![
            Note {
                id: "a".into(),
                text: "  real note ".into(),
            },
            Note {
                id: "b".into(),
                text: "   ".into(),
            },
        ];
        assert_eq!(cfg.note_for("a"), Some("real note"));
        assert_eq!(cfg.note_for("b"), None);
        assert_eq!(cfg.note_for("missing"), None);
    }

    // ── Store round-trips ───────────────────────────────────────────────────

    fn temp_store() -> (Store, tempdir::Dir) {
        let dir = tempdir::Dir::new();
        let store = Store::open(dir.path().to_str().unwrap()).expect("open");
        (store, dir)
    }

    #[test]
    fn create_then_get_round_trips_and_normalizes() {
        let (store, _dir) = temp_store();
        let mut cfg = base_config();
        cfg.max_members_per_role = 9999; // stored raw, normalized on read
        store.create("abc", "t".repeat(64).as_str(), &cfg).unwrap();
        let loaded = store.get("abc").unwrap().expect("present");
        assert_eq!(loaded.guild_id, cfg.guild_id);
        assert_eq!(loaded.max_members_per_role, MAX_MEMBERS_PER_ROLE);
        assert!(store.get("nope").unwrap().is_none());
        store.ping().unwrap();
    }

    /// The public instance id is a binding, never edit authority: an update must
    /// require the separate token, and a wrong one must not be able to
    /// distinguish itself from a right one by anything but the answer.
    #[test]
    fn update_requires_the_edit_token() {
        let (store, _dir) = temp_store();
        let good = "a".repeat(64);
        let bad = "b".repeat(64);
        let mut cfg = base_config();
        store.create("abc", &good, &cfg).unwrap();

        assert!(matches!(
            store.authorize_edit("abc", &good).unwrap(),
            EditLookup::Authorized
        ));
        assert!(matches!(
            store.authorize_edit("abc", &bad).unwrap(),
            EditLookup::Forbidden
        ));
        assert!(matches!(
            store.authorize_edit("missing", &good).unwrap(),
            EditLookup::Unknown
        ));

        cfg.title = Some("Renamed".into());
        assert!(!store.update("abc", &bad, &cfg).unwrap());
        assert!(store.update("abc", &good, &cfg).unwrap());
        assert_eq!(
            store.get("abc").unwrap().unwrap().title.as_deref(),
            Some("Renamed")
        );
    }

    /// A row with no digest is a pre-protocol-v2 instance: it can never be
    /// updated in place, which is what pushes the config UI into its
    /// create-a-replacement flow instead of silently failing.
    #[test]
    fn a_legacy_row_without_a_digest_can_never_be_updated() {
        let (store, _dir) = temp_store();
        let cfg = base_config();
        {
            let conn = store.lock();
            conn.execute(
                "INSERT INTO instances (id, created_at, config, edit_token_hash)
                 VALUES ('legacy', 0, ?1, NULL)",
                [serde_json::to_string(&cfg).unwrap()],
            )
            .unwrap();
        }
        assert!(matches!(
            store.authorize_edit("legacy", &"a".repeat(64)).unwrap(),
            EditLookup::Forbidden
        ));
        assert!(!store.update("legacy", &"a".repeat(64), &cfg).unwrap());
        // …but it still *reads*, so a posted directory keeps working.
        assert!(store.get("legacy").unwrap().is_some());
    }

    /// A config blob that doesn't deserialize reads as "no such instance"
    /// rather than propagating an error — the click path then answers its
    /// "this directory is no longer set up" note instead of a storage error.
    #[test]
    fn an_undecodable_config_reads_as_absent() {
        let (store, _dir) = temp_store();
        {
            let conn = store.lock();
            conn.execute(
                "INSERT INTO instances (id, created_at, config, edit_token_hash)
                 VALUES ('broken', 0, '{not json', NULL)",
                [],
            )
            .unwrap();
        }
        assert!(store.get("broken").unwrap().is_none());
    }

    /// A minimal scratch-directory helper so the store tests touch a real
    /// SQLite file (WAL pragmas and all) without pulling in a dev-dependency.
    mod tempdir {
        use std::path::{Path, PathBuf};

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new() -> Self {
                let mut bytes = [0u8; 8];
                getrandom::getrandom(&mut bytes).expect("CSPRNG");
                let path = std::env::temp_dir()
                    .join(format!("dweeb-directory-test-{}", hex::encode(bytes)));
                std::fs::create_dir_all(&path).expect("mkdir");
                Self(path.join("directory.db"))
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                if let Some(parent) = self.0.parent() {
                    let _ = std::fs::remove_dir_all(parent);
                }
            }
        }
    }
}
