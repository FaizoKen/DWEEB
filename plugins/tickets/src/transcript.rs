//! The HTML record a closed ticket leaves behind — pure, no I/O.
//!
//! The close flow fetches the channel's history (`rest::fetch_history`) and
//! hands it here already reduced to [`Message`]s; this module decides what the
//! record says. It is a standalone file an admin downloads from the log channel
//! (or the opener gets by DM), so it is self-contained — no scripts, no remote
//! fonts or avatars — and carries a restrictive CSP of its own: every string in
//! it came from Discord users, and escaping is the first line of defence, not
//! the only one.
//!
//! **Message text needs the Message Content intent.** Discord withholds what
//! members type — `content`, attachments and embeds — from any app without that
//! privileged intent, on the REST API as much as on the gateway. Only the bot's
//! own messages (the welcome, the intake answers, the close notice) and messages
//! that mention it come through. The transcript therefore says so plainly
//! ([`Meta::content_withheld`]) instead of printing rows of empty bubbles, and
//! collapses a run of withheld messages into one line: who took part, and when.

use std::collections::HashMap;
use std::fmt::Write as _;

use crate::timefmt::{format_iso, format_utc_ms, humanize_ms, parse_iso_secs};

/// Consecutive messages from one author within this window share a header,
/// like Discord's own grouping.
const GROUP_GAP_SECS: i64 = 7 * 60;

/// Someone named in the header.
pub struct Person<'a> {
    pub id: &'a str,
    pub name: &'a str,
}

/// Everything the header says about the ticket.
pub struct Meta<'a> {
    pub channel_name: &'a str,
    pub guild_name: &'a str,
    pub number: i64,
    pub topic: &'a str,
    pub opener: Person<'a>,
    pub opened_at_ms: i64,
    pub closed_by: Person<'a>,
    pub closed_at_ms: i64,
    pub reason: &'a str,
    /// The claimer's user id, if the ticket was claimed.
    pub claimed_by: Option<&'a str>,
    /// More history existed than was fetched.
    pub truncated: bool,
    /// Discord withheld members' message text (see the module docs).
    pub content_withheld: bool,
}

/// One message, reduced to what the transcript renders.
#[derive(Debug, Clone, Default)]
pub struct Message {
    pub author_id: String,
    pub author_name: String,
    pub author_bot: bool,
    /// ISO 8601, as Discord sends it.
    pub timestamp: String,
    pub edited: bool,
    /// A system message (a pin, a member joining…) rather than a post.
    pub system: bool,
    pub content: String,
    pub attachments: Vec<Attachment>,
    pub embeds: Vec<Embed>,
    pub stickers: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Attachment {
    pub filename: String,
    pub url: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default)]
pub struct Embed {
    pub title: String,
    pub description: String,
    pub fields: Vec<(String, String)>,
    pub color: Option<u32>,
}

impl Message {
    /// Nothing renderable — what Discord sends in place of a member's message
    /// when the app lacks the Message Content intent.
    pub fn is_blank(&self) -> bool {
        self.content.trim().is_empty()
            && self.attachments.is_empty()
            && self.embeds.is_empty()
            && self.stickers.is_empty()
    }
}

/// Names that `<@id>`, `<@&id>` and `<#id>` markup resolves to.
#[derive(Default)]
pub struct Names {
    pub users: HashMap<String, String>,
    pub roles: HashMap<String, String>,
    pub channels: HashMap<String, String>,
}

/// Whether the history looks withheld: members spoke, and not one of their
/// messages carried anything. A real message is never empty, so this is the
/// fingerprint of a missing Message Content intent even when the app's flags
/// couldn't be read.
pub fn looks_withheld(messages: &[Message]) -> bool {
    let mut members = messages.iter().filter(|m| !m.author_bot && !m.system);
    let Some(first) = members.next() else {
        return false;
    };
    first.is_blank() && members.all(Message::is_blank)
}

/// Render the whole transcript.
pub fn render(meta: &Meta, messages: &[Message], names: &Names) -> String {
    let mut html = String::with_capacity(4096 + messages.len() * 256);
    let title = format!("Ticket #{:04} — {}", meta.number, meta.channel_name);
    let _ = write!(
        html,
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">\
<meta name=\"referrer\" content=\"no-referrer\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<title>{}</title><style>{STYLE}</style></head><body><header><h1>{}</h1>",
        esc(&title),
        esc(&title)
    );

    // ── Header ───────────────────────────────────────────────────────────────
    html.push_str("<table class=\"meta\">");
    let mut row = |label: &str, value: &str| {
        let _ = write!(html, "<tr><th>{}</th><td>{}</td></tr>", esc(label), value);
    };
    if !meta.guild_name.is_empty() {
        row("Server", &esc(meta.guild_name));
    }
    if !meta.topic.is_empty() {
        row("Topic", &esc(meta.topic));
    }
    row(
        "Opened by",
        &format!(
            "{} · {}",
            person(&meta.opener),
            esc(&format_utc_ms(meta.opened_at_ms))
        ),
    );
    row(
        "Closed by",
        &format!(
            "{} · {} · open {}",
            person(&meta.closed_by),
            esc(&format_utc_ms(meta.closed_at_ms)),
            esc(&humanize_ms(meta.closed_at_ms - meta.opened_at_ms))
        ),
    );
    if let Some(id) = meta.claimed_by {
        let name = names.users.get(id).map(String::as_str).unwrap_or(id);
        row("Claimed by", &person(&Person { id, name }));
    }
    let reason = meta.reason.trim();
    if !reason.is_empty() {
        row(
            "Reason",
            &format!("<span class=\"pre\">{}</span>", esc(reason)),
        );
    }
    let posts = messages.iter().filter(|m| !m.system).count();
    let mut count = format!("{posts}");
    if meta.truncated {
        count.push_str(" (the most recent only)");
    }
    row("Messages", &esc(&count));
    html.push_str("</table></header>");

    // ── Notices ──────────────────────────────────────────────────────────────
    if meta.content_withheld {
        html.push_str(
            "<p class=\"notice\">Members' message text isn't in this transcript. Discord only \
shares what people type with apps that have the <b>Message Content</b> intent, and this bot \
doesn't have it — so below is who took part and when, plus the bot's own messages (the \
welcome, the intake answers, the close reason).</p>",
        );
    }
    if meta.truncated {
        html.push_str(
            "<p class=\"notice\">This ticket ran long, so only its most recent messages are \
included.</p>",
        );
    }

    // ── Messages ─────────────────────────────────────────────────────────────
    html.push_str("<main>");
    if messages.is_empty() {
        html.push_str("<p class=\"muted\">No messages.</p>");
    }
    for group in group_messages(messages) {
        render_group(&mut html, &group, names);
    }
    html.push_str("</main>");

    let has_files = messages.iter().any(|m| !m.attachments.is_empty());
    let _ = write!(
        html,
        "<footer>Generated by DWEEB Tickets · {}{}</footer></body></html>",
        esc(&format_utc_ms(meta.closed_at_ms)),
        if has_files {
            " · Attachment links point to Discord's CDN, which expires them after a while."
        } else {
            ""
        }
    );
    html
}

/// A run of messages sharing one header.
struct Group<'a> {
    first: &'a Message,
    messages: Vec<&'a Message>,
}

fn group_messages(messages: &[Message]) -> Vec<Group<'_>> {
    let mut groups: Vec<Group> = Vec::new();
    let mut last_secs: Option<i64> = None;
    for m in messages {
        let secs = parse_iso_secs(&m.timestamp);
        let joins = match groups.last() {
            Some(g) => {
                !m.system
                    && !g.first.system
                    && g.first.author_id == m.author_id
                    && matches!((last_secs, secs), (Some(a), Some(b)) if b - a <= GROUP_GAP_SECS)
            }
            None => false,
        };
        if joins {
            groups.last_mut().expect("checked").messages.push(m);
        } else {
            groups.push(Group {
                first: m,
                messages: vec![m],
            });
        }
        last_secs = secs;
    }
    groups
}

fn render_group(html: &mut String, group: &Group, names: &Names) {
    let first = group.first;
    if first.system {
        let _ = write!(
            html,
            "<div class=\"sys\">{} {} · {}</div>",
            esc(&first.author_name),
            esc(&first.content),
            esc(&format_iso(&first.timestamp))
        );
        return;
    }
    let initial: String = first
        .author_name
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_else(|| "?".into());
    let _ = write!(
        html,
        "<div class=\"g\"><div class=\"av\" style=\"background:#{:06x}\">{}</div><div class=\"b\">\
<div class=\"h\"><span class=\"n\">{}</span>{}<span class=\"ts\">{}</span></div>",
        avatar_color(&first.author_id),
        esc(&initial),
        esc(&first.author_name),
        if first.author_bot {
            "<span class=\"tag\">BOT</span>"
        } else {
            ""
        },
        esc(&format_iso(&first.timestamp))
    );

    // Consecutive withheld messages collapse into one line — a column of empty
    // bubbles says nothing that a count doesn't.
    let mut blank_run = 0usize;
    let flush = |html: &mut String, run: &mut usize| {
        if *run > 0 {
            let _ = write!(
                html,
                "<div class=\"m withheld\">{} — text not available</div>",
                if *run == 1 {
                    "1 message".to_string()
                } else {
                    format!("{run} messages")
                }
            );
            *run = 0;
        }
    };
    for m in &group.messages {
        if m.is_blank() {
            blank_run += 1;
            continue;
        }
        flush(html, &mut blank_run);
        html.push_str("<div class=\"m\">");
        if !m.content.trim().is_empty() {
            html.push_str(&format_markdown(&esc(&resolve_markup(&m.content, names))));
        }
        if m.edited {
            html.push_str("<span class=\"ed\">(edited)</span>");
        }
        for e in &m.embeds {
            render_embed(html, e, names);
        }
        for a in &m.attachments {
            let _ = write!(
                html,
                "<div class=\"att\">📎 <a href=\"{}\" rel=\"noreferrer\">{}</a> <span class=\"muted\">{}</span></div>",
                esc(&a.url),
                esc(&a.filename),
                esc(&human_size(a.size))
            );
        }
        for s in &m.stickers {
            let _ = write!(html, "<div class=\"muted\">Sticker: {}</div>", esc(s));
        }
        html.push_str("</div>");
    }
    flush(html, &mut blank_run);
    html.push_str("</div></div>");
}

fn render_embed(html: &mut String, e: &Embed, names: &Names) {
    let _ = write!(
        html,
        "<div class=\"emb\" style=\"border-color:#{:06x}\">",
        e.color.unwrap_or(0x4e5058)
    );
    if !e.title.is_empty() {
        let _ = write!(html, "<div class=\"et\">{}</div>", esc(&e.title));
    }
    if !e.description.is_empty() {
        let _ = write!(
            html,
            "<div>{}</div>",
            format_markdown(&esc(&resolve_markup(&e.description, names)))
        );
    }
    for (name, value) in &e.fields {
        let _ = write!(
            html,
            "<div class=\"ef\"><b>{}</b><br>{}</div>",
            esc(name),
            format_markdown(&esc(&resolve_markup(value, names)))
        );
    }
    html.push_str("</div>");
}

/// Discord's everyday formatting on **already-escaped** text: ```` ``` ```` code
/// blocks, `` ` `` inline code, `**bold**`, `__underline__`, `~~strike~~`.
/// Only matched pairs convert — an unmatched marker stays literal — so every
/// tag emitted is closed (cross-nested markers like `**a __b** c__` can
/// interleave tags, which HTML parsers repair), and code keeps its contents
/// verbatim. Escaping first is what makes this safe: every `<` a user typed is
/// already `&lt;`, and the only tags that can appear are the ones emitted here
/// — attribute-free `pre`, `code`, `b`, `u`, `s`.
pub fn format_markdown(escaped: &str) -> String {
    let parts: Vec<&str> = escaped.split("```").collect();
    let mut out = String::with_capacity(escaped.len() + 32);
    for (i, part) in parts.iter().enumerate() {
        let inside_fence = i % 2 == 1;
        let closed = i + 1 < parts.len();
        match (inside_fence, closed) {
            (true, true) => {
                // A fence may open with a language tag on its own line.
                let body = match part.split_once('\n') {
                    Some((lang, rest))
                        if !lang.is_empty()
                            && lang
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-') =>
                    {
                        rest
                    }
                    _ => part.trim_start_matches('\n'),
                };
                out.push_str("<pre>");
                out.push_str(body);
                out.push_str("</pre>");
            }
            (true, false) => {
                out.push_str("```");
                out.push_str(&inline_markdown(part));
            }
            (false, _) => out.push_str(&inline_markdown(part)),
        }
    }
    out
}

/// Inline code first (its contents stay literal), then the text styles.
fn inline_markdown(s: &str) -> String {
    let parts: Vec<&str> = s.split('`').collect();
    let mut out = String::with_capacity(s.len());
    for (i, part) in parts.iter().enumerate() {
        if i % 2 == 1 && i + 1 < parts.len() {
            out.push_str("<code>");
            out.push_str(part);
            out.push_str("</code>");
        } else {
            if i % 2 == 1 {
                out.push('`');
            }
            let styled = wrap_pairs(part, "**", "b");
            let styled = wrap_pairs(&styled, "__", "u");
            out.push_str(&wrap_pairs(&styled, "~~", "s"));
        }
    }
    out
}

/// Wrap each matched pair of `marker` in `<tag>…</tag>`; a trailing unmatched
/// marker is kept as text.
fn wrap_pairs(s: &str, marker: &str, tag: &str) -> String {
    let parts: Vec<&str> = s.split(marker).collect();
    let mut out = String::with_capacity(s.len());
    for (i, part) in parts.iter().enumerate() {
        if i % 2 == 1 {
            if i + 1 < parts.len() && !part.is_empty() {
                let _ = write!(out, "<{tag}>{part}</{tag}>");
            } else {
                out.push_str(marker);
                out.push_str(part);
                if i + 1 < parts.len() {
                    out.push_str(marker);
                }
            }
        } else {
            out.push_str(part);
        }
    }
    out
}

/// Replace Discord's inline markup with readable text: `<@id>`/`<@!id>` → a
/// user's name, `<@&id>` → a role, `<#id>` → a channel, custom emoji → `:name:`,
/// `<t:unix>` → a UTC date, `</cmd:id>` → `/cmd`. Anything else — including a
/// stray `<` — is left verbatim. The output is plain text; the caller escapes it.
pub fn resolve_markup(text: &str, names: &Names) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(end) = tail.find('>') else {
            out.push_str(tail);
            return out;
        };
        let inner = &tail[1..end];
        match resolve_token(inner, names) {
            Some(text) => out.push_str(&text),
            None => out.push_str(&tail[..=end]),
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

fn resolve_token(inner: &str, names: &Names) -> Option<String> {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if let Some(id) = inner.strip_prefix("@&") {
        if digits(id) {
            let name = names.roles.get(id).map(String::as_str).unwrap_or("role");
            return Some(format!("@{name}"));
        }
        return None;
    }
    if let Some(id) = inner.strip_prefix("@!").or_else(|| inner.strip_prefix('@')) {
        if digits(id) {
            return Some(match names.users.get(id) {
                Some(name) => format!("@{name}"),
                None => format!("@{id}"),
            });
        }
        return None;
    }
    if let Some(id) = inner.strip_prefix('#') {
        if digits(id) {
            let name = names
                .channels
                .get(id)
                .map(String::as_str)
                .unwrap_or("channel");
            return Some(format!("#{name}"));
        }
        return None;
    }
    if let Some(body) = inner.strip_prefix("t:") {
        let unix = body.split(':').next().unwrap_or_default();
        if digits(unix) {
            return unix
                .parse::<i64>()
                .ok()
                .and_then(|s| s.checked_mul(1000))
                .map(format_utc_ms);
        }
        return None;
    }
    if let Some(body) = inner.strip_prefix('/') {
        let (cmd, id) = body.rsplit_once(':')?;
        return (digits(id) && !cmd.is_empty()).then(|| format!("/{cmd}"));
    }
    // Custom emoji: `:name:id` or `a:name:id`.
    let body = inner.strip_prefix('a').unwrap_or(inner);
    let body = body.strip_prefix(':')?;
    let (name, id) = body.rsplit_once(':')?;
    (digits(id) && !name.is_empty() && !name.contains(':')).then(|| format!(":{name}:"))
}

fn person(p: &Person) -> String {
    format!(
        "{} <span class=\"muted\">({})</span>",
        esc(p.name),
        esc(p.id)
    )
}

fn human_size(bytes: u64) -> String {
    match bytes {
        0 => String::new(),
        b if b < 1024 => format!("{b} B"),
        b if b < 1024 * 1024 => format!("{:.1} KB", b as f64 / 1024.0),
        b => format!("{:.1} MB", b as f64 / (1024.0 * 1024.0)),
    }
}

/// A stable, readable avatar colour per author, from their id.
fn avatar_color(id: &str) -> u32 {
    const PALETTE: [u32; 8] = [
        0x5865f2, 0x3ba55d, 0xfaa61a, 0xed4245, 0xeb459e, 0x3498db, 0x9b59b6, 0x1abc9c,
    ];
    let hash = id
        .bytes()
        .fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(b as u32));
    PALETTE[(hash as usize) % PALETTE.len()]
}

/// HTML-escape text for element content and double-quoted attributes.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

const STYLE: &str = "\
:root{color-scheme:dark}*{box-sizing:border-box}\
body{background:#313338;color:#dbdee1;font:15px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:24px;max-width:960px}\
h1{font-size:20px;color:#f2f3f5;margin:0 0 12px}\
header{background:#2b2d31;border-radius:8px;padding:16px 20px;margin-bottom:16px}\
.meta{border-collapse:collapse;font-size:14px}.meta th{text-align:left;color:#949ba4;font-weight:600;padding:3px 16px 3px 0;vertical-align:top;white-space:nowrap}\
.meta td{padding:3px 0}.pre{white-space:pre-wrap}\
.notice{background:#2b2d31;border-left:4px solid #f0b232;border-radius:4px;padding:10px 14px;font-size:14px;margin:0 0 12px}\
.g{display:flex;gap:14px;padding:6px 0;margin-top:10px}\
.av{flex:none;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700}\
.b{min-width:0;flex:1}.h{display:flex;align-items:baseline;gap:8px}.n{font-weight:600;color:#f2f3f5}\
.tag{background:#5865f2;color:#fff;font-size:10px;font-weight:700;border-radius:3px;padding:1px 4px}\
.ts{color:#949ba4;font-size:12px}.m{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:2px}\
.withheld,.muted,.ed{color:#949ba4}.withheld{font-style:italic}.ed{font-size:11px;margin-left:4px}\
.emb{border-left:4px solid;background:#2b2d31;border-radius:4px;padding:8px 12px;margin-top:6px;max-width:520px}\
.et{font-weight:600;color:#f2f3f5}.ef{margin-top:6px}.att{margin-top:4px}a{color:#00a8fc}\
.sys{color:#949ba4;font-size:13px;margin:10px 0 0 54px}\
pre{background:#2b2d31;border-radius:4px;padding:8px 10px;margin:4px 0;white-space:pre-wrap;font:13px/1.4 ui-monospace,Consolas,monospace}\
code{background:#2b2d31;border-radius:3px;padding:0 4px;font:13px ui-monospace,Consolas,monospace}\
footer{color:#949ba4;font-size:12px;margin-top:24px;border-top:1px solid #3f4147;padding-top:12px}";

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(author: &str, ts: &str, content: &str) -> Message {
        Message {
            author_id: author.into(),
            author_name: format!("user {author}"),
            timestamp: ts.into(),
            content: content.into(),
            ..Default::default()
        }
    }

    fn meta<'a>() -> Meta<'a> {
        Meta {
            channel_name: "ticket-0042",
            guild_name: "Test Server",
            number: 42,
            topic: "Billing",
            opener: Person {
                id: "1",
                name: "Ada",
            },
            opened_at_ms: 1_781_526_700_000,
            closed_by: Person {
                id: "2",
                name: "Bob",
            },
            closed_at_ms: 1_781_526_700_000 + 7_980_000,
            reason: "Solved <b>",
            claimed_by: Some("2"),
            truncated: false,
            content_withheld: false,
        }
    }

    #[test]
    fn every_user_string_is_escaped() {
        let evil = msg(
            "1",
            "2026-06-15T12:31:40+00:00",
            "<script>alert('x')</script> & <img src=x>",
        );
        let mut m = meta();
        m.guild_name = "<svg onload=alert(1)>";
        let html = render(&m, &[evil], &Names::default());
        assert!(!html.contains("<script>alert"));
        assert!(!html.contains("<img src=x>"));
        assert!(!html.contains("<svg onload"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("Solved &lt;b&gt;"));
        // Defence in depth: the file forbids scripts even if escaping slipped.
        assert!(html.contains("default-src 'none'"));
    }

    #[test]
    fn header_states_the_ticket_facts() {
        let html = render(&meta(), &[], &Names::default());
        assert!(html.contains("Ticket #0042 — ticket-0042"));
        assert!(html.contains("Test Server"));
        assert!(html.contains("Billing"));
        assert!(html.contains("2026-06-15 12:31 UTC"));
        assert!(html.contains("open 2h 13m"));
        assert!(html.contains("No messages."));
    }

    #[test]
    fn consecutive_messages_group_under_one_header() {
        let messages = vec![
            msg("1", "2026-06-15T12:31:00+00:00", "hello"),
            msg("1", "2026-06-15T12:32:00+00:00", "anyone?"),
            msg("2", "2026-06-15T12:33:00+00:00", "hi!"),
            // Same author as the previous group, but 20 minutes later.
            msg("2", "2026-06-15T12:53:00+00:00", "back"),
        ];
        let groups = group_messages(&messages);
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].messages.len(), 2);
    }

    #[test]
    fn withheld_history_is_detected_and_collapsed() {
        let mut bot = msg("9", "2026-06-15T12:31:00+00:00", "Welcome!");
        bot.author_bot = true;
        let messages = vec![
            bot,
            msg("1", "2026-06-15T12:32:00+00:00", ""),
            msg("1", "2026-06-15T12:33:00+00:00", ""),
            msg("2", "2026-06-15T12:34:00+00:00", ""),
        ];
        assert!(looks_withheld(&messages));
        let mut m = meta();
        m.content_withheld = true;
        let html = render(&m, &messages, &Names::default());
        assert!(html.contains("Message Content"));
        assert!(html.contains("2 messages — text not available"));
        assert!(html.contains("1 message — text not available"));
        assert!(html.contains("Welcome!"));

        // A single member message with text means the intent is there.
        let mut ok = messages.clone();
        ok[2].content = "real text".into();
        assert!(!looks_withheld(&ok));
        // No member messages at all: nothing to conclude.
        assert!(!looks_withheld(&messages[..1]));
    }

    #[test]
    fn markup_resolves_to_readable_text() {
        let mut names = Names::default();
        names.users.insert("11".into(), "Ada".into());
        names.roles.insert("22".into(), "Support".into());
        names.channels.insert("33".into(), "ticket-0042".into());
        assert_eq!(
            resolve_markup(
                "hi <@11> and <@!11>, <@&22> in <#33> <:wave:123> <a:party:456>",
                &names
            ),
            "hi @Ada and @Ada, @Support in #ticket-0042 :wave: :party:"
        );
        assert_eq!(
            resolve_markup("at <t:1781526700:R> run </help:99>", &names),
            "at 2026-06-15 12:31 UTC run /help"
        );
        // Unknown ids stay useful; non-markup stays verbatim.
        assert_eq!(resolve_markup("<@77> <@&88>", &names), "@77 @role");
        assert_eq!(resolve_markup("a < b > c <3", &names), "a < b > c <3");
        assert_eq!(resolve_markup("x <@abc> y", &names), "x <@abc> y");
    }

    #[test]
    fn attachments_embeds_and_stickers_render() {
        let mut m = msg("1", "2026-06-15T12:31:00+00:00", "");
        m.attachments.push(Attachment {
            filename: "shot.png".into(),
            url: "https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1".into(),
            size: 2048,
        });
        m.embeds.push(Embed {
            title: "Order".into(),
            description: "desc".into(),
            fields: vec![("Id".into(), "#1".into())],
            color: Some(0xff0000),
        });
        m.stickers.push("Wave".into());
        assert!(!m.is_blank());
        let html = render(&meta(), &[m], &Names::default());
        assert!(html.contains("shot.png"));
        assert!(html.contains("2.0 KB"));
        assert!(html.contains("Sticker: Wave"));
        assert!(html.contains("border-color:#ff0000"));
        assert!(html.contains("expires them"));
    }

    #[test]
    fn everyday_formatting_renders_and_stays_safe() {
        let md = |s: &str| format_markdown(&esc(s));
        assert_eq!(md("**Reason:** done"), "<b>Reason:</b> done");
        assert_eq!(md("__u__ and ~~gone~~"), "<u>u</u> and <s>gone</s>");
        // Code keeps its contents literal — no bold inside it.
        assert_eq!(md("run `a **b** c`"), "run <code>a **b** c</code>");
        assert_eq!(md("```rust\nfn x() {}\n```"), "<pre>fn x() {}\n</pre>");
        // Unmatched markers stay text, so every tag emitted is closed.
        assert_eq!(md("2 ** 3 and `tick"), "2 ** 3 and `tick");
        assert_eq!(md("open ``` fence"), "open ``` fence");
        // Formatting a user's markup never lets it out: escaping comes first.
        assert_eq!(
            md("**<script>alert(1)</script>**"),
            "<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>"
        );
        let html = render(
            &meta(),
            &[msg("1", "2026-06-15T12:31:00+00:00", "**hi** `x`")],
            &Names::default(),
        );
        assert!(html.contains("<b>hi</b> <code>x</code>"));
    }
}
