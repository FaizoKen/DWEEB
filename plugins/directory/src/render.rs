//! Turning a config plus a live guild read into a Components V2 reply.
//!
//! Everything here is **pure** — no client, no clock, no store. That's the point:
//! the interesting behaviour of this plugin is its formatting and its budget
//! arithmetic, and both are fully testable without a network.
//!
//! ## Two hard limits shape the output
//!
//! 1. **4000 characters of text**, total, across every Text Display in the
//!    message ([`crate::discord::MAX_V2_TEXT`]). A directory is one of the few
//!    things that can genuinely overflow this — 25 roles with notes, or a
//!    200-channel server. So lines are admitted through a [`Budget`] and the
//!    reply ends with an honest "…and N more" rather than being rejected by
//!    Discord as a whole.
//! 2. **A component ceiling.** Discord caps a message's components; a directory
//!    could otherwise emit one per section without limit. Sections are grouped
//!    into whole Text Displays (one block per section, not one per line) and
//!    capped at [`MAX_SECTION_BLOCKS`], which keeps the count in single digits
//!    no matter how the host configures it.
//!
//! ## Untrusted text
//!
//! Channel topics are arbitrary member-written text, and Discord's inline styles
//! **cross newlines** — so one unbalanced `*` in a topic would italicise the rest
//! of the block. Every value that didn't come from our own config UI goes through
//! [`escape_markdown`]. Host-written copy (group names, notes) is deliberately
//! left as markdown, because writing `**bold**` there is the point.

use serde_json::{json, Value};

use crate::discord::{
    COMPONENT_CONTAINER, COMPONENT_SEPARATOR, COMPONENT_TEXT_DISPLAY, MAX_V2_TEXT,
};
use crate::rest::{ChannelView, GuildStructure, RoleView, CHANNEL_CATEGORY, DEFAULT_CHANNEL_KINDS};
use crate::store::{
    InstanceConfig, CHANNEL_SOURCE_CATEGORIES, CHANNEL_SOURCE_PICKED, ROLE_SOURCE_HOISTED,
    ROLE_SOURCE_PICKED, ROLE_SOURCE_STAFF,
};

/// Text Displays a reply may carry beyond its header. Keeps the component count
/// bounded however many groups or categories the host configures.
const MAX_SECTION_BLOCKS: usize = 24;

/// A channel topic is up to 1024 characters; that's a paragraph, not a caption.
const MAX_TOPIC: usize = 140;

/// Budget for a list substituted into the author's own message.
///
/// Well under [`MAX_V2_TEXT`] on purpose: in `"message"` output the list shares
/// the message's single 4000-character allowance with everything the author
/// wrote, and a message over that limit is rejected by Discord *entirely* — so an
/// unbounded list wouldn't just look bad, it would make the refresh fail. Half
/// leaves the author generous room for their own copy.
const MAX_INLINE_TEXT: usize = 2000;

/// Select-option value meaning "show the whole directory".
pub const SECTION_ALL: &str = "all";
/// Prefix for a roles-mode section pick: `g:<group key>`.
pub const SECTION_GROUP_PREFIX: &str = "g:";
/// Prefix for a channels-mode section pick: `c:<category id>`.
pub const SECTION_CATEGORY_PREFIX: &str = "c:";

/// Everything the renderer needs. Borrowed, so a cached structure is rendered
/// without being cloned.
pub struct RenderInput<'a> {
    pub cfg: &'a InstanceConfig,
    pub structure: &'a GuildStructure,
    /// The section a select pick narrowed to, if any. An unrecognised value
    /// renders everything — a read-only list fails open.
    pub section: Option<&'a str>,
}

/// Build the Components V2 `components` array for a directory reply.
pub fn render(input: &RenderInput<'_>) -> Vec<Value> {
    let cfg = input.cfg;
    let mut budget = Budget::new(MAX_V2_TEXT);

    // Header: the heading, the optional server totals, then the optional intro.
    let mut header = String::new();
    header.push_str(&format!("## {}\n", title_of(cfg)));
    if let Some(counts) = server_counts(input) {
        header.push_str(&format!("-# {counts}\n"));
    }
    if let Some(intro) = cfg.intro.as_deref() {
        header.push_str(&one_line(intro));
        header.push('\n');
    }
    let header = header.trim_end().to_string();
    budget.charge(&header);

    let sections = if cfg.is_roles() {
        role_sections(input, &mut budget)
    } else {
        channel_sections(input, &mut budget)
    };

    // Footer: the honest small print. Never silently omitted.
    let mut footnotes: Vec<String> = Vec::new();
    if budget.exhausted {
        footnotes.push("The list was too long to show in full.".into());
    }

    let mut children: Vec<Value> = vec![text_display(&header)];
    if !sections.is_empty() || !footnotes.is_empty() {
        children.push(json!({
            "type": COMPONENT_SEPARATOR,
            "divider": true,
            "spacing": 1,
        }));
    }
    if sections.is_empty() {
        children.push(text_display(&empty_notice(cfg)));
    } else {
        for block in sections {
            children.push(text_display(&block));
        }
    }
    for note in &footnotes {
        children.push(text_display(&format!("-# {note}")));
    }

    let mut container = json!({
        "type": COMPONENT_CONTAINER,
        "components": children,
    });
    if let Some(color) = cfg.accent_color {
        container["accent_color"] = json!(color & 0xFF_FF_FF);
    }
    vec![container]
}

/// What one `{directory}` placeholder resolves to, plus the scalars beside it.
pub struct ListText {
    /// The rendered list — the value of `{directory}`.
    pub list: String,
    /// How many roles / channels the list actually names — `{directory_count}`.
    pub count: usize,
}

/// Render the directory as **plain markdown text**, for substitution into the
/// author's own message.
///
/// Deliberately built on the same `role_sections` / `channel_sections` the
/// component renderer uses, so the two views can never disagree about *what* is
/// listed — only about how it's wrapped. The only difference is the budget: this
/// text lands inside the author's message, which shares one 4000-character
/// Components V2 allowance with their own prose, so it gets [`MAX_INLINE_TEXT`]
/// rather than the whole thing. Header and footnotes are omitted — the author
/// writes their own heading around the token.
pub fn render_text(input: &RenderInput<'_>) -> ListText {
    let mut budget = Budget::new(MAX_INLINE_TEXT);
    // `Budget::new` reserves room for footnotes this view doesn't emit; hand it
    // back so the inline cap is the real one.
    budget.remaining = MAX_INLINE_TEXT;

    let sections = if input.cfg.is_roles() {
        role_sections(input, &mut budget)
    } else {
        channel_sections(input, &mut budget)
    };
    // Count what the list actually shows, not what it started from, or
    // `{directory_count}` contradicts the text right next to it.
    let count = if input.cfg.is_roles() {
        roster_roles(input.cfg, input.structure).len()
    } else {
        index_channels(input.cfg, input.structure).len()
    };

    if sections.is_empty() {
        return ListText {
            list: empty_notice(input.cfg),
            count: 0,
        };
    }
    let mut list = sections.join("\n");
    if budget.exhausted {
        list.push_str("\n-# (list truncated)");
    }
    ListText { list, count }
}

/// The heading, falling back to a per-mode default.
fn title_of(cfg: &InstanceConfig) -> String {
    match cfg.title.as_deref() {
        Some(t) => one_line(t),
        None if cfg.is_roles() => "Server roles".to_string(),
        None => "Channel directory".to_string(),
    }
}

/// The optional "1,204 members · 87 online" line under the heading.
///
/// `None` unless the host asked for it *and* Discord actually sent a total. This
/// is the server's own headline figure — never a per-role breakdown, which
/// Discord only exposes behind the privileged `GUILD_MEMBERS` intent (see the
/// `rest` module note). Rendering it as "0 members" when Discord stayed silent
/// would put a plain falsehood in a public message, so silence stays silence.
fn server_counts(input: &RenderInput<'_>) -> Option<String> {
    if !input.cfg.show_member_count {
        return None;
    }
    let mut parts = Vec::new();
    if let Some(total) = input.structure.member_count {
        parts.push(format!(
            "{} {}",
            thousands(total),
            if total == 1 { "member" } else { "members" }
        ));
    }
    if let Some(online) = input.structure.online_count {
        parts.push(format!("{} online", thousands(online)));
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// Group a number with thin thousands separators: `1204` → `1,204`.
fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// What to say when the configured directory resolves to nothing at all — a
/// picked role that was deleted, a "staff roles" server with none, a category
/// whose channels were all filtered out. Never an empty card.
fn empty_notice(cfg: &InstanceConfig) -> String {
    if cfg.is_roles() {
        match cfg.role_source.as_str() {
            ROLE_SOURCE_STAFF => {
                "No roles in this server carry moderation permissions.".to_string()
            }
            ROLE_SOURCE_HOISTED => {
                "No roles in this server are set to display separately.".to_string()
            }
            _ => "The roles this list points at no longer exist.".to_string(),
        }
    } else if cfg.require_topic {
        "None of these channels have a topic set yet.".to_string()
    } else {
        "There's nothing to list here yet.".to_string()
    }
}

// ── Roles mode ───────────────────────────────────────────────────────────────

/// The roles this roster lists, in display order, resolved against the live
/// guild. A picked role that no longer exists is dropped rather than rendered
/// from its cached name — a roster that quietly lists deleted roles is worse
/// than one that's a line shorter.
fn roster_roles<'a>(cfg: &InstanceConfig, structure: &'a GuildStructure) -> Vec<&'a RoleView> {
    match cfg.role_source.as_str() {
        ROLE_SOURCE_HOISTED => structure.roles.iter().filter(|r| r.hoist).collect(),
        ROLE_SOURCE_STAFF => structure.roles.iter().filter(|r| r.staff).collect(),
        // ROLE_SOURCE_PICKED (normalize() guarantees no other value).
        _ => cfg
            .picked_role_ids()
            .iter()
            .filter_map(|id| structure.role(id))
            .collect(),
    }
}

fn role_sections(input: &RenderInput<'_>, budget: &mut Budget) -> Vec<String> {
    let cfg = input.cfg;
    let available = roster_roles(cfg, input.structure);
    if available.is_empty() {
        return Vec::new();
    }

    // Grouped only when the host built groups AND is picking roles by hand:
    // "hoisted"/"staff" derive their list from the server, so a group's role ids
    // may not even be in it.
    let grouped = !cfg.groups.is_empty() && cfg.role_source == ROLE_SOURCE_PICKED;
    let mut blocks = Vec::new();

    if !grouped {
        let mut lines = Vec::new();
        for role in &available {
            if !push_role(input, role, &mut lines, budget) {
                break;
            }
        }
        if !lines.is_empty() {
            blocks.push(lines.join("\n"));
        }
        return blocks;
    }

    for group in &cfg.groups {
        if blocks.len() >= MAX_SECTION_BLOCKS {
            budget.exhausted = true;
            break;
        }
        if !section_selected(input.section, SECTION_GROUP_PREFIX, &group.key) {
            continue;
        }
        let roles: Vec<&&RoleView> = group
            .role_ids
            .iter()
            .filter_map(|id| available.iter().find(|r| &r.id == id))
            .collect();
        if roles.is_empty() {
            continue;
        }
        let heading = section_heading(group.emoji.as_deref(), &group.name);
        let mut lines = Vec::new();
        if let Some(h) = &heading {
            if !budget.take(h) {
                break;
            }
            lines.push(h.clone());
        }
        let mut any = false;
        for role in roles {
            if !push_role(input, role, &mut lines, budget) {
                break;
            }
            any = true;
        }
        if any {
            blocks.push(lines.join("\n"));
        }
        if budget.exhausted {
            break;
        }
    }
    blocks
}

/// Append one role's lines. Returns false when the budget ran out, so the caller
/// stops instead of building lines that would be dropped anyway.
fn push_role(
    input: &RenderInput<'_>,
    role: &RoleView,
    lines: &mut Vec<String>,
    budget: &mut Budget,
) -> bool {
    let cfg = input.cfg;

    // The role mention renders as Discord's own colour pill, which no amount of
    // markdown can reproduce — and it stays correct if the role is renamed.
    let mut head = format!("<@&{}>", role.id);
    if let Some(emoji) = &role.unicode_emoji {
        head = format!("{} {}", one_line(emoji), head);
    }
    if cfg.show_permissions && !role.badges.is_empty() {
        head.push_str(&format!(" `{}`", role.badges.join(" · ")));
    }
    if !budget.take(&head) {
        return false;
    }
    lines.push(head);

    if let Some(note) = cfg.note_for(&role.id) {
        let line = format!("-# {}", one_line(note));
        if !budget.take(&line) {
            return false;
        }
        lines.push(line);
    }
    true
}

// ── Channels mode ────────────────────────────────────────────────────────────

/// True when a channel's type is one this directory lists.
fn kind_included(cfg: &InstanceConfig, kind: u8) -> bool {
    // A category is the *heading* of a section, never an entry inside it, so it
    // is excluded unconditionally — `include_kinds` comes from a config blob and
    // must not be able to list categories among their own children.
    if kind == CHANNEL_CATEGORY {
        return false;
    }
    if cfg.include_kinds.is_empty() {
        DEFAULT_CHANNEL_KINDS.contains(&kind)
    } else {
        cfg.include_kinds.contains(&kind)
    }
}

/// The channels this index lists, before grouping — in the host's order for a
/// hand-picked list, otherwise in Discord's own display order.
fn index_channels<'a>(cfg: &InstanceConfig, structure: &'a GuildStructure) -> Vec<&'a ChannelView> {
    let base: Vec<&ChannelView> = match cfg.channel_source.as_str() {
        CHANNEL_SOURCE_PICKED => cfg
            .channels
            .iter()
            .filter_map(|c| structure.channel(&c.id))
            .collect(),
        CHANNEL_SOURCE_CATEGORIES => {
            let wanted: Vec<&str> = cfg.categories.iter().map(|c| c.id.as_str()).collect();
            structure
                .channels
                .iter()
                .filter(|c| c.parent_id.as_deref().is_some_and(|p| wanted.contains(&p)))
                .collect()
        }
        // CHANNEL_SOURCE_ALL (normalize() guarantees no other value).
        _ => structure.channels.iter().collect(),
    };
    base.into_iter()
        .filter(|c| kind_included(cfg, c.kind))
        // A hand-picked channel is listed even without a topic — the host chose
        // it deliberately. `require_topic` is for the "all"/category sweeps,
        // where it's what keeps a 200-channel server readable.
        .filter(|c| {
            !cfg.require_topic
                || cfg.channel_source == CHANNEL_SOURCE_PICKED
                || c.topic.is_some()
                || cfg.note_for(&c.id).is_some()
        })
        .collect()
}

fn channel_sections(input: &RenderInput<'_>, budget: &mut Budget) -> Vec<String> {
    let cfg = input.cfg;
    let channels = index_channels(cfg, input.structure);
    if channels.is_empty() {
        return Vec::new();
    }

    if !cfg.group_by_category {
        let mut lines = Vec::new();
        for ch in &channels {
            if !push_channel(input, ch, &mut lines, budget) {
                break;
            }
        }
        return if lines.is_empty() {
            Vec::new()
        } else {
            vec![lines.join("\n")]
        };
    }

    // Category order follows Discord's own; uncategorised channels lead, which
    // is where Discord itself shows them.
    let mut blocks: Vec<String> = Vec::new();
    let mut buckets: Vec<(Option<&ChannelView>, Vec<&ChannelView>)> = Vec::new();
    let mut loose: Vec<&ChannelView> = Vec::new();
    for ch in &channels {
        match ch.parent_id.as_deref() {
            None => loose.push(ch),
            Some(parent) => {
                let cat = input.structure.channel(parent);
                match buckets
                    .iter_mut()
                    .find(|(c, _)| c.map(|c| c.id.as_str()) == Some(parent))
                {
                    Some((_, list)) => list.push(ch),
                    None => buckets.push((cat, vec![ch])),
                }
            }
        }
    }
    if !loose.is_empty() {
        buckets.insert(0, (None, loose));
    }

    for (category, list) in buckets {
        if blocks.len() >= MAX_SECTION_BLOCKS {
            budget.exhausted = true;
            break;
        }
        // A select pick narrows to one category. Uncategorised channels have no
        // id to pick, so they only appear in the unfiltered view.
        let key = category.map(|c| c.id.as_str()).unwrap_or("");
        if !section_selected(input.section, SECTION_CATEGORY_PREFIX, key) {
            continue;
        }
        let mut lines = Vec::new();
        if let Some(cat) = category {
            let heading = section_heading(None, &escape_markdown(&cat.name));
            if let Some(h) = heading {
                if !budget.take(&h) {
                    break;
                }
                lines.push(h);
            }
        }
        let mut any = false;
        for ch in list {
            if !push_channel(input, ch, &mut lines, budget) {
                break;
            }
            any = true;
        }
        if any {
            blocks.push(lines.join("\n"));
        }
        if budget.exhausted {
            break;
        }
    }
    blocks
}

fn push_channel(
    input: &RenderInput<'_>,
    ch: &ChannelView,
    lines: &mut Vec<String>,
    budget: &mut Budget,
) -> bool {
    let cfg = input.cfg;
    // A channel mention renders with the right glyph per channel type (#, 🔊,
    // forum…) and is clickable, which is the whole value of a channel index.
    let mut line = format!("<#{}>", ch.id);
    if ch.nsfw {
        line.push_str(" `18+`");
    }
    // A host note wins over the channel's own topic: it was written for *this*
    // list, and it's the only way to caption a channel whose topic is empty.
    let caption = cfg
        .note_for(&ch.id)
        .map(one_line)
        .or_else(|| {
            if !cfg.show_topics {
                return None;
            }
            ch.topic
                .as_deref()
                .map(|t| truncate(&escape_markdown(&one_line(t)), MAX_TOPIC))
        })
        .filter(|c| !c.is_empty());
    if let Some(caption) = caption {
        line.push_str(&format!(" — {caption}"));
    }
    if !budget.take(&line) {
        return false;
    }
    lines.push(line);
    true
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/// Whether a section survives the select's pick.
///
/// No pick, or the explicit `all` sentinel, shows everything. An unrecognised
/// value also shows everything: a directory is read-only, so failing open costs
/// nothing and beats answering a member with a blank card because the message's
/// options drifted from the saved config.
fn section_selected(pick: Option<&str>, prefix: &str, key: &str) -> bool {
    match pick {
        None => true,
        Some(SECTION_ALL) => true,
        Some(p) => match p.strip_prefix(prefix) {
            Some(wanted) => wanted == key,
            None => true,
        },
    }
}

fn section_heading(emoji: Option<&str>, name: &str) -> Option<String> {
    let name = one_line(name);
    if name.is_empty() {
        return None;
    }
    Some(match emoji.map(one_line).filter(|e| !e.is_empty()) {
        Some(e) => format!("### {e} {name}"),
        None => format!("### {name}"),
    })
}

fn text_display(content: &str) -> Value {
    json!({ "type": COMPONENT_TEXT_DISPLAY, "content": content })
}

/// Collapse any run of whitespace (newlines included) into single spaces.
///
/// Load-bearing, not cosmetic: the renderer builds blocks by joining lines with
/// `\n`, so a value containing its own newline would silently invent lines and
/// break every structural assumption below it.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Neutralise markdown in text we didn't write.
///
/// Discord's inline styles cross newlines, so a channel topic containing a
/// single unbalanced `*` would italicise the remainder of the block — every
/// channel listed after it. Backslash-escaping is Discord's own mechanism and
/// renders as the literal character.
fn escape_markdown(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '*' | '_' | '~' | '`' | '|' | '\\' | '#' | '>') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Truncate to `max` characters on a word boundary where one is close by.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    let trimmed = match cut.rfind(' ') {
        // Only honour a word boundary in the last quarter; otherwise a long
        // unbroken string would collapse to almost nothing.
        Some(i) if i > max * 3 / 4 => &cut[..i],
        _ => cut.as_str(),
    };
    format!("{}…", trimmed.trim_end())
}

/// The Components V2 text allowance, spent line by line.
///
/// A reply that exceeds it is rejected by Discord *entirely* — so the budget has
/// to be enforced while building, not checked at the end. `exhausted` is what
/// makes the footer honest about a list that got cut short.
struct Budget {
    remaining: usize,
    exhausted: bool,
}

impl Budget {
    fn new(cap: usize) -> Self {
        Self {
            // Reserve room for the footnotes, which are appended after the
            // sections have already spent the budget. Without this, running out
            // mid-list would also swallow the line that admits it.
            remaining: cap.saturating_sub(240),
            exhausted: false,
        }
    }

    /// Spend unconditionally (the header, which always renders).
    fn charge(&mut self, s: &str) {
        self.remaining = self.remaining.saturating_sub(s.chars().count() + 1);
    }

    /// Spend if it fits. Returns false — and latches `exhausted` — if not.
    fn take(&mut self, s: &str) -> bool {
        let cost = s.chars().count() + 1; // + the joining newline
        if cost > self.remaining {
            self.exhausted = true;
            return false;
        }
        self.remaining -= cost;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rest::permission_badges;
    use crate::store::{tests::base_config, ChannelRef, Group, Note, RoleRef};

    fn role(id: &str, name: &str, hoist: bool, perms: u64) -> RoleView {
        RoleView {
            id: id.into(),
            name: name.into(),
            color: 0,
            position: 10,
            hoist,
            managed: false,
            staff: perms != 0,
            badges: permission_badges(perms),
            unicode_emoji: None,
        }
    }

    fn channel(
        id: &str,
        name: &str,
        kind: u8,
        parent: Option<&str>,
        topic: Option<&str>,
    ) -> ChannelView {
        ChannelView {
            id: id.into(),
            name: name.into(),
            kind,
            parent_id: parent.map(|s| s.to_string()),
            position: 0,
            topic: topic.map(|s| s.to_string()),
            nsfw: false,
        }
    }

    fn structure(roles: Vec<RoleView>, channels: Vec<ChannelView>) -> GuildStructure {
        GuildStructure {
            guild_id: "1".into(),
            guild_name: "Test Server".into(),
            roles,
            channels,
            member_count: None,
            online_count: None,
        }
    }

    /// A structure that carries the guild totals `?with_counts=true` supplies.
    fn structure_with_counts(
        roles: Vec<RoleView>,
        members: Option<u64>,
        online: Option<u64>,
    ) -> GuildStructure {
        GuildStructure {
            member_count: members,
            online_count: online,
            ..structure(roles, vec![])
        }
    }

    /// Flatten the rendered container into the text a member would read.
    fn text_of(components: &[Value]) -> String {
        let mut out = String::new();
        for child in components[0]["components"].as_array().unwrap() {
            if let Some(c) = child["content"].as_str() {
                out.push_str(c);
                out.push('\n');
            }
        }
        out
    }

    fn char_total(components: &[Value]) -> usize {
        components[0]["components"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["content"].as_str())
            .map(|c| c.chars().count())
            .sum()
    }

    // ── Roles mode ──────────────────────────────────────────────────────────

    #[test]
    fn a_picked_roster_renders_mentions_badges_and_notes() {
        let mut cfg = base_config();
        cfg.roles = vec![
            RoleRef {
                id: "r1".into(),
                name: "Admin".into(),
                color: 0,
            },
            RoleRef {
                id: "r2".into(),
                name: "Mod".into(),
                color: 0,
            },
        ];
        cfg.notes = vec![Note {
            id: "r2".into(),
            text: "Handles the mod queue".into(),
        }];
        let st = structure(
            vec![
                role("r1", "Admin", true, 1 << 3),
                role("r2", "Mod", true, 1 << 2),
            ],
            vec![],
        );
        let out = render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        let text = text_of(&out);
        // Role *mentions*, so Discord paints its own colour pill and a rename
        // can't stale the reply.
        assert!(text.contains("<@&r1>"), "{text}");
        assert!(text.contains("<@&r2>"), "{text}");
        assert!(text.contains("`Admin`"), "badge missing: {text}");
        assert!(text.contains("`Bans`"), "badge missing: {text}");
        assert!(text.contains("-# Handles the mod queue"), "{text}");
        // With member expansion off, nothing claims to know counts.
        assert!(!text.contains("member"), "{text}");
    }

    #[test]
    fn a_deleted_picked_role_is_dropped_not_rendered_from_cache() {
        let mut cfg = base_config();
        cfg.roles = vec![
            RoleRef {
                id: "gone".into(),
                name: "Deleted Role".into(),
                color: 0,
            },
            RoleRef {
                id: "r1".into(),
                name: "Admin".into(),
                color: 0,
            },
        ];
        let st = structure(vec![role("r1", "Admin", true, 1 << 3)], vec![]);
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(!text.contains("Deleted Role"), "{text}");
        assert!(!text.contains("<@&gone>"), "{text}");
        assert!(text.contains("<@&r1>"), "{text}");
    }

    /// Every picked role being gone must still produce a readable card that says
    /// what happened — never an empty container.
    #[test]
    fn a_roster_whose_roles_all_vanished_explains_itself() {
        let mut cfg = base_config();
        cfg.roles = vec![RoleRef {
            id: "gone".into(),
            name: "X".into(),
            color: 0,
        }];
        let st = structure(vec![], vec![]);
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(text.contains("no longer exist"), "{text}");
    }

    #[test]
    fn hoisted_and_staff_sources_derive_the_list_from_the_server() {
        let st = structure(
            vec![
                role("r1", "Admin", true, 1 << 3),    // hoisted + staff
                role("r2", "Member", false, 0),       // neither
                role("r3", "Helper", false, 1 << 13), // staff only
            ],
            vec![],
        );
        let mut cfg = base_config();

        cfg.role_source = ROLE_SOURCE_HOISTED.into();
        let ids: Vec<&str> = roster_roles(&cfg, &st)
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        assert_eq!(ids, vec!["r1"]);

        cfg.role_source = ROLE_SOURCE_STAFF.into();
        let ids: Vec<&str> = roster_roles(&cfg, &st)
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        assert_eq!(ids, vec!["r1", "r3"]);
    }

    #[test]
    fn groups_become_headed_sections_in_host_order() {
        let mut cfg = base_config();
        cfg.groups = vec![
            Group {
                key: "g1".into(),
                name: "Leadership".into(),
                emoji: Some("👑".into()),
                role_ids: vec!["r1".into()],
            },
            Group {
                key: "g2".into(),
                name: "Moderators".into(),
                emoji: None,
                role_ids: vec!["r2".into()],
            },
        ];
        let st = structure(
            vec![
                role("r1", "Owner", true, 1 << 3),
                role("r2", "Mod", true, 1 << 2),
            ],
            vec![],
        );
        let out = render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        let text = text_of(&out);
        assert!(text.contains("### 👑 Leadership"), "{text}");
        assert!(text.contains("### Moderators"), "{text}");
        assert!(
            text.find("Leadership").unwrap() < text.find("Moderators").unwrap(),
            "host order must be preserved: {text}"
        );
    }

    /// A group is only a group when the host is picking roles by hand — the
    /// derived sources build their list from the server, so a group's ids may
    /// not even be in it.
    #[test]
    fn a_derived_source_ignores_groups() {
        let mut cfg = base_config();
        cfg.role_source = ROLE_SOURCE_STAFF.into();
        cfg.groups = vec![Group {
            key: "g1".into(),
            name: "Leadership".into(),
            emoji: None,
            role_ids: vec!["r1".into()],
        }];
        let st = structure(vec![role("r1", "Owner", true, 1 << 3)], vec![]);
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(!text.contains("### Leadership"), "{text}");
        assert!(text.contains("<@&r1>"), "{text}");
    }

    // ── Server totals ───────────────────────────────────────────────────────
    //
    // The intent-free replacement for per-role member expansion: Discord's own
    // guild totals, which ride along on the structure read. There is deliberately
    // no per-role breakdown anywhere in this renderer — see the `rest` note.

    fn count_cfg() -> InstanceConfig {
        let mut cfg = base_config();
        cfg.roles = vec![RoleRef {
            id: "r1".into(),
            name: "Mod".into(),
            color: 0,
        }];
        cfg.show_member_count = true;
        cfg
    }

    #[test]
    fn server_totals_render_under_the_heading_when_asked_for() {
        let cfg = count_cfg();
        let st = structure_with_counts(vec![role("r1", "Mod", true, 1 << 2)], Some(1204), Some(87));
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(text.contains("1,204 members · 87 online"), "{text}");
        // The roster itself is unaffected.
        assert!(text.contains("<@&r1>"), "{text}");
        assert!(text.contains("`Bans`"), "{text}");
    }

    /// Off by default, and off means *absent* — not a zero.
    #[test]
    fn server_totals_are_omitted_unless_the_host_asked() {
        let mut cfg = count_cfg();
        cfg.show_member_count = false;
        let st = structure_with_counts(vec![role("r1", "Mod", true, 0)], Some(1204), Some(87));
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(!text.contains("1,204"), "{text}");
        assert!(!text.contains("online"), "{text}");
    }

    /// Discord may answer without the counts. Printing "0 members" then would be
    /// a plain falsehood in a public message, so silence stays silence — and the
    /// roster still renders, exactly as it does when the counts are present.
    #[test]
    fn a_missing_total_is_omitted_rather_than_rendered_as_zero() {
        let cfg = count_cfg();
        let st = structure_with_counts(vec![role("r1", "Mod", true, 0)], None, None);
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(!text.contains("0 members"), "{text}");
        assert!(!text.contains("online"), "{text}");
        assert!(text.contains("<@&r1>"), "the roster must survive: {text}");

        // One count without the other renders just that one.
        let st = structure_with_counts(vec![role("r1", "Mod", true, 0)], Some(12), None);
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(text.contains("12 members"), "{text}");
        assert!(!text.contains("online"), "{text}");
    }

    #[test]
    fn one_member_is_singular_and_thousands_are_grouped() {
        let cfg = count_cfg();
        let st = structure_with_counts(vec![role("r1", "Mod", true, 0)], Some(1), None);
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(text.contains("1 member"), "{text}");
        assert!(!text.contains("1 members"), "{text}");

        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1000), "1,000");
        assert_eq!(thousands(12_345), "12,345");
        assert_eq!(thousands(1_234_567), "1,234,567");
    }

    // ── Channels mode ───────────────────────────────────────────────────────

    #[test]
    fn a_channel_index_groups_by_category_with_topics() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        let st = structure(
            vec![],
            vec![
                channel("c0", "Information", 4, None, None),
                channel("c1", "rules", 0, Some("c0"), Some("Read before posting")),
                channel("c2", "general", 0, None, Some("Anything goes")),
            ],
        );
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(text.contains("### Information"), "{text}");
        assert!(text.contains("<#c1> — Read before posting"), "{text}");
        // Uncategorised channels lead, matching where Discord shows them.
        assert!(
            text.find("<#c2>").unwrap() < text.find("### Information").unwrap(),
            "{text}"
        );
    }

    /// Threads and categories are never listed as entries — they'd swamp the
    /// index and the category is already the heading.
    #[test]
    fn threads_and_categories_are_not_entries() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        let st = structure(
            vec![],
            vec![
                channel("cat", "Stuff", 4, None, None),
                channel("t", "a-thread", 11, Some("cat"), Some("chatter")),
                channel("c", "real", 0, Some("cat"), Some("a channel")),
            ],
        );
        let listed: Vec<&str> = index_channels(&cfg, &st)
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(listed, vec!["c"]);
    }

    #[test]
    fn require_topic_filters_sweeps_but_never_a_hand_picked_channel() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        cfg.require_topic = true;
        let st = structure(
            vec![],
            vec![
                channel("c1", "has-topic", 0, None, Some("Yes")),
                channel("c2", "no-topic", 0, None, None),
            ],
        );
        let listed: Vec<&str> = index_channels(&cfg, &st)
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(listed, vec!["c1"]);

        // A host note counts as a topic — it's a caption they wrote on purpose.
        cfg.notes = vec![Note {
            id: "c2".into(),
            text: "Quiet corner".into(),
        }];
        let listed: Vec<&str> = index_channels(&cfg, &st)
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(listed, vec!["c1", "c2"]);

        // Hand-picked channels are listed regardless: the host chose them.
        cfg.notes = vec![];
        cfg.channel_source = CHANNEL_SOURCE_PICKED.into();
        cfg.channels = vec![ChannelRef {
            id: "c2".into(),
            name: "no-topic".into(),
            kind: 0,
        }];
        let listed: Vec<&str> = index_channels(&cfg, &st)
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(listed, vec!["c2"]);
    }

    #[test]
    fn a_host_note_overrides_the_channels_own_topic() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        cfg.notes = vec![Note {
            id: "c1".into(),
            text: "**Start here**".into(),
        }];
        let st = structure(
            vec![],
            vec![channel("c1", "rules", 0, None, Some("Discord's topic"))],
        );
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(
            text.contains("**Start here**"),
            "host markdown is kept: {text}"
        );
        assert!(!text.contains("Discord's topic"), "{text}");
    }

    #[test]
    fn nsfw_channels_are_flagged() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        let mut ch = channel("c1", "spicy", 0, None, Some("t"));
        ch.nsfw = true;
        let st = structure(vec![], vec![ch]);
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(text.contains("`18+`"), "{text}");
    }

    /// A topic is member-written text and Discord's inline styles cross
    /// newlines, so one stray `*` would italicise every channel listed after it.
    #[test]
    fn an_unbalanced_marker_in_a_topic_cannot_bleed_into_later_lines() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        let st = structure(
            vec![],
            vec![
                channel("c1", "first", 0, None, Some("look *here")),
                channel("c2", "second", 0, None, Some("normal")),
            ],
        );
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(text.contains("look \\*here"), "{text}");
        // A topic can't smuggle a heading in either.
        let st2 = structure(vec![], vec![channel("c1", "x", 0, None, Some("# Huge"))]);
        let text2 = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st2,
            section: None,
        }));
        assert!(text2.contains("\\# Huge"), "{text2}");
    }

    /// A multi-line topic must not invent lines in a block whose structure is
    /// built by joining on `\n`.
    #[test]
    fn a_multiline_topic_is_collapsed_to_one_line() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        let st = structure(
            vec![],
            vec![channel(
                "c1",
                "x",
                0,
                None,
                Some("line one\nline two\n\nline three"),
            )],
        );
        let out = render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        let block = out[0]["components"].as_array().unwrap().last().unwrap()["content"]
            .as_str()
            .unwrap();
        assert_eq!(block.lines().count(), 1, "{block}");
        assert!(block.contains("line one line two line three"), "{block}");
    }

    #[test]
    fn a_long_topic_is_truncated_with_an_ellipsis() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        let long = "word ".repeat(80);
        let st = structure(vec![], vec![channel("c1", "x", 0, None, Some(&long))]);
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        }));
        assert!(text.contains('…'), "{text}");
        assert!(
            text.chars().count() < 400,
            "topic not truncated: {}",
            text.len()
        );
    }

    // ── Select sections ─────────────────────────────────────────────────────

    #[test]
    fn a_select_pick_narrows_to_one_section() {
        let mut cfg = base_config();
        cfg.groups = vec![
            Group {
                key: "g1".into(),
                name: "Leadership".into(),
                emoji: None,
                role_ids: vec!["r1".into()],
            },
            Group {
                key: "g2".into(),
                name: "Moderators".into(),
                emoji: None,
                role_ids: vec!["r2".into()],
            },
        ];
        let st = structure(
            vec![
                role("r1", "Owner", true, 1 << 3),
                role("r2", "Mod", true, 1 << 2),
            ],
            vec![],
        );
        let pick = |section: Option<&str>| {
            text_of(&render(&RenderInput {
                cfg: &cfg,
                structure: &st,
                section,
            }))
        };
        let one = pick(Some("g:g2"));
        assert!(one.contains("Moderators"), "{one}");
        assert!(!one.contains("Leadership"), "{one}");
        // The explicit "everything" sentinel, and no pick at all, both show all.
        assert!(pick(Some(SECTION_ALL)).contains("Leadership"));
        assert!(pick(None).contains("Leadership"));
    }

    /// A stale option value must fail OPEN. The alternative — a blank card
    /// because the posted menu drifted from the saved config — is strictly worse
    /// for a read-only list.
    #[test]
    fn an_unrecognised_section_shows_everything() {
        // A pick in this namespace that names another section hides this one…
        assert!(!section_selected(
            Some("g:gone"),
            SECTION_GROUP_PREFIX,
            "g1"
        ));
        // …but a value that isn't even in this mode's namespace falls open.
        assert!(section_selected(
            Some("garbage"),
            SECTION_GROUP_PREFIX,
            "g1"
        ));
        assert!(section_selected(Some("c:123"), SECTION_GROUP_PREFIX, "g1"));
    }

    /// A category can never be listed as an entry, even if a stored
    /// `include_kinds` names its type — it is the heading of the section its
    /// children sit in.
    #[test]
    fn a_category_is_never_an_entry_even_if_include_kinds_says_so() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        cfg.include_kinds = vec![0, CHANNEL_CATEGORY];
        let st = structure(
            vec![],
            vec![
                channel("cat", "Info", CHANNEL_CATEGORY, None, None),
                channel("c1", "rules", 0, Some("cat"), Some("t")),
            ],
        );
        let listed: Vec<&str> = index_channels(&cfg, &st)
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(listed, vec!["c1"]);
    }

    #[test]
    fn a_category_pick_narrows_the_channel_index() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        let st = structure(
            vec![],
            vec![
                channel("cat1", "Info", 4, None, None),
                channel("cat2", "Chat", 4, None, None),
                channel("c1", "rules", 0, Some("cat1"), Some("t")),
                channel("c2", "general", 0, Some("cat2"), Some("t")),
            ],
        );
        let text = text_of(&render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: Some("c:cat2"),
        }));
        assert!(text.contains("<#c2>"), "{text}");
        assert!(!text.contains("<#c1>"), "{text}");
    }

    // ── Budget ──────────────────────────────────────────────────────────────

    /// The budget is the difference between a long directory and a reply Discord
    /// rejects outright. It must hold even at the largest configuration.
    #[test]
    fn a_huge_roster_stays_inside_the_v2_text_budget_and_says_it_was_cut() {
        let mut cfg = base_config();
        cfg.show_member_count = true;
        cfg.notes = (0..25)
            .map(|i| Note {
                id: format!("r{i}"),
                text: "n".repeat(150),
            })
            .collect();
        cfg.roles = (0..25)
            .map(|i| RoleRef {
                id: format!("r{i}"),
                name: format!("Role {i}"),
                color: 0,
            })
            .collect();
        let st = structure_with_counts(
            (0..25)
                .map(|i| role(&format!("r{i}"), &format!("Role {i}"), true, 1 << 3))
                .collect(),
            Some(120_000),
            Some(9_000),
        );
        let out = render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        let total = char_total(&out);
        assert!(total <= MAX_V2_TEXT, "over the V2 budget: {total}");
        assert!(text_of(&out).contains("too long to show in full"));
    }

    #[test]
    fn a_huge_channel_index_stays_inside_the_budget() {
        let mut cfg = base_config();
        cfg.mode = crate::store::MODE_CHANNELS.into();
        let mut channels = Vec::new();
        for c in 0..30 {
            channels.push(channel(
                &format!("cat{c}"),
                &format!("Category {c}"),
                4,
                None,
                None,
            ));
            for i in 0..20 {
                channels.push(channel(
                    &format!("ch{c}_{i}"),
                    &format!("channel-{i}"),
                    0,
                    Some(&format!("cat{c}")),
                    Some("A reasonably wordy channel topic that eats budget"),
                ));
            }
        }
        let st = structure(vec![], channels);
        let out = render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        assert!(char_total(&out) <= MAX_V2_TEXT, "{}", char_total(&out));
        // The component count stays bounded no matter how many categories exist.
        assert!(
            out[0]["components"].as_array().unwrap().len() <= MAX_SECTION_BLOCKS + 4,
            "too many components"
        );
    }

    /// Running out of budget mid-list must not also swallow the footnote that
    /// admits it — hence the reserve in `Budget::new`.
    #[test]
    fn the_footer_survives_an_exhausted_budget() {
        let mut budget = Budget::new(MAX_V2_TEXT);
        assert!(budget.remaining < MAX_V2_TEXT, "no reserve held back");
        while budget.take("x") {}
        assert!(budget.exhausted);
    }

    // ── Inline text render (`{directory}`) ──────────────────────────────────

    #[test]
    fn the_text_render_lists_the_same_things_as_the_component_render() {
        let mut cfg = base_config();
        cfg.roles = vec![
            RoleRef {
                id: "r1".into(),
                name: "Admin".into(),
                color: 0,
            },
            RoleRef {
                id: "r2".into(),
                name: "Mod".into(),
                color: 0,
            },
        ];
        cfg.notes = vec![Note {
            id: "r2".into(),
            text: "Mod queue".into(),
        }];
        let st = structure(
            vec![
                role("r1", "Admin", true, 1 << 3),
                role("r2", "Mod", true, 1 << 2),
            ],
            vec![],
        );
        let input = RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        };
        let text = render_text(&input);
        assert_eq!(text.count, 2);
        assert!(text.list.contains("<@&r1>"), "{}", text.list);
        assert!(text.list.contains("`Bans`"), "{}", text.list);
        assert!(text.list.contains("-# Mod queue"), "{}", text.list);
        // No heading: the author writes their own around the token.
        assert!(!text.list.contains("## "), "{}", text.list);
    }

    /// The inline list shares the message's single 4000-char budget with the
    /// author's own prose, and Discord rejects an over-budget message *entirely* —
    /// so an unbounded list wouldn't look bad, it would make the refresh fail.
    #[test]
    fn the_text_render_is_capped_well_below_the_message_budget() {
        let mut cfg = base_config();
        cfg.roles = (0..40)
            .map(|i| RoleRef {
                id: format!("r{i}"),
                name: format!("Role {i}"),
                color: 0,
            })
            .collect();
        cfg.notes = (0..40)
            .map(|i| Note {
                id: format!("r{i}"),
                text: "n".repeat(150),
            })
            .collect();
        let st = structure(
            (0..40)
                .map(|i| role(&format!("r{i}"), &format!("Role {i}"), true, 1 << 3))
                .collect(),
            vec![],
        );
        let text = render_text(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        let len = text.list.chars().count();
        assert!(
            len <= MAX_INLINE_TEXT + 40,
            "inline list ran to {len} chars"
        );
        assert!(
            len < MAX_V2_TEXT,
            "must leave room for the author's own text"
        );
        assert!(text.list.contains("truncated"), "a cut list must say so");
    }

    /// The substituted text is the list and nothing else.
    ///
    /// It lands inside the author's own prose, so it must never carry an
    /// apology, a status note, or anything else the author didn't write. The
    /// removed member expansion used to append "Member lists aren't available
    /// right now." here, which read as the author's own words — that line is
    /// what this test exists to keep out.
    #[test]
    fn the_text_render_carries_the_list_and_no_status_chatter() {
        let mut cfg = base_config();
        cfg.roles = vec![RoleRef {
            id: "r1".into(),
            name: "Mod".into(),
            color: 0,
        }];
        cfg.show_member_count = true;
        let st = structure_with_counts(vec![role("r1", "Mod", true, 0)], Some(1204), Some(87));
        let text = render_text(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        assert!(text.list.contains("<@&r1>"), "{}", text.list);
        for chatter in ["available", "Couldn't", "member", "online"] {
            assert!(
                !text.list.contains(chatter),
                "inline list leaked {chatter:?}: {}",
                text.list
            );
        }
    }

    /// An empty directory must resolve the token to a readable sentence, never to
    /// an empty string that would leave a hole in the author's message.
    #[test]
    fn the_text_render_never_resolves_to_nothing() {
        let mut cfg = base_config();
        cfg.role_source = ROLE_SOURCE_STAFF.into();
        let st = structure(vec![role("r1", "Member", false, 0)], vec![]);
        let text = render_text(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        assert_eq!(text.count, 0);
        assert!(!text.list.trim().is_empty());
        assert!(
            text.list.contains("moderation permissions"),
            "{}",
            text.list
        );
    }

    /// `{directory_count}` must agree with the list printed beside it — a picked
    /// role that no longer exists is neither listed nor counted.
    #[test]
    fn the_count_matches_what_the_list_actually_shows() {
        let mut cfg = base_config();
        cfg.roles = (1..=3)
            .map(|i| RoleRef {
                id: format!("r{i}"),
                name: format!("R{i}"),
                color: 0,
            })
            .collect();
        // r3 was deleted in Discord since the host picked it.
        let st = structure(
            (1..=2)
                .map(|i| role(&format!("r{i}"), &format!("R{i}"), true, 0))
                .collect(),
            vec![],
        );
        let text = render_text(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        assert_eq!(text.count, 2, "a deleted role must not be counted");
        assert!(text.list.contains("<@&r1>"), "{}", text.list);
        assert!(!text.list.contains("<@&r3>"), "{}", text.list);
    }

    #[test]
    fn the_text_render_honours_a_select_section_pick() {
        let mut cfg = base_config();
        cfg.groups = vec![
            Group {
                key: "g1".into(),
                name: "Leads".into(),
                emoji: None,
                role_ids: vec!["r1".into()],
            },
            Group {
                key: "g2".into(),
                name: "Mods".into(),
                emoji: None,
                role_ids: vec!["r2".into()],
            },
        ];
        let st = structure(
            vec![
                role("r1", "Lead", true, 1 << 3),
                role("r2", "Mod", true, 1 << 2),
            ],
            vec![],
        );
        let text = render_text(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: Some("g:g2"),
        });
        assert!(text.list.contains("Mods"), "{}", text.list);
        assert!(!text.list.contains("Leads"), "{}", text.list);
    }

    #[test]
    fn accent_color_is_masked_to_24_bits_and_omitted_when_unset() {
        let mut cfg = base_config();
        cfg.roles = vec![RoleRef {
            id: "r1".into(),
            name: "A".into(),
            color: 0,
        }];
        let st = structure(vec![role("r1", "A", true, 0)], vec![]);
        let rendered = render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        assert!(rendered[0]["accent_color"].is_null());

        // A colour arriving with an alpha byte set must be masked, not passed
        // through — Discord rejects an `accent_color` above 0xFFFFFF.
        cfg.accent_color = Some(0xFF_12_34_56);
        let rendered = render(&RenderInput {
            cfg: &cfg,
            structure: &st,
            section: None,
        });
        assert_eq!(rendered[0]["accent_color"], json!(0x12_34_56));
    }

    #[test]
    fn the_title_falls_back_per_mode() {
        let mut cfg = base_config();
        assert_eq!(title_of(&cfg), "Server roles");
        cfg.mode = crate::store::MODE_CHANNELS.into();
        assert_eq!(title_of(&cfg), "Channel directory");
        cfg.title = Some("Our  Staff\nTeam".into());
        assert_eq!(title_of(&cfg), "Our Staff Team");
    }

    #[test]
    fn helpers_behave() {
        assert_eq!(one_line("  a \n\n b\tc "), "a b c");
        assert_eq!(
            escape_markdown("a*b_c`d|e~f\\g#h>i"),
            "a\\*b\\_c\\`d\\|e\\~f\\\\g\\#h\\>i"
        );
        assert_eq!(truncate("short", 20), "short");
        // A word boundary near the end is honoured…
        assert_eq!(truncate("alpha beta gamma delta", 17), "alpha beta gamma…");
        // …but an unbroken run is cut hard rather than collapsing to nothing.
        assert_eq!(
            truncate(&"x".repeat(30), 10),
            format!("{}…", "x".repeat(10))
        );
    }
}
