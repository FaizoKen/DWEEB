//! Pictures and files a reply can actually send.
//!
//! A DWEEB saved message can hold pictures uploaded from the author's computer.
//! The editor keeps each one as a `session://<id>/<name>` handle to a file that
//! lives only in that browser, and DWEEB's own Send uploads the bytes beside the
//! message. A quick reply is sent from this service at click time, where no such
//! file exists — and Discord refuses the **whole** interaction response over a
//! single media URL it can't fetch, which the member sees as "<app> didn't
//! respond in time" (reported 2026-10-01: two of four topics on one menu were
//! dead, exactly the two whose thumbnail was an upload, while each saved message
//! posted fine on its own). So:
//!
//! - saving refuses a saved message that carries one ([`unsendable_media`],
//!   called from `validate.rs`), naming the file so the admin can swap it out;
//! - a reply stored before that check sends with those pictures left out
//!   ([`strip_unsendable`]) instead of not at all.
//!
//! "Sendable" means an `http(s)://` link, which Discord fetches itself.
//! Everything else is unreachable from here: a `session://` upload, an
//! `attachment://` reference (it names a file uploaded *with* a message, and a
//! reply uploads none), a `{server_icon}`-style placeholder only DWEEB's Send
//! fills in, a bare attachment id, or no link at all.
//!
//! `static/config.html` mirrors this walk (`unsendableMedia`) to warn on the
//! card the moment such a message is picked; keep the two in step.

use serde_json::Value;

const COMPONENT_SECTION: u64 = 9;
const COMPONENT_THUMBNAIL: u64 = 11;
const COMPONENT_MEDIA_GALLERY: u64 = 12;
const COMPONENT_FILE: u64 = 13;
const COMPONENT_CONTAINER: u64 = 17;

/// Longest file name an error message quotes before eliding the rest.
const MAX_NAME_CHARS: usize = 80;

/// One picture or file a reply can't send, named the way its author would
/// recognise it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsendable {
    /// The uploaded file's name, else the raw reference as written.
    pub name: String,
    /// A File component rather than a picture. A picture can be swapped for a
    /// link; a File component only ever shows an uploaded attachment, so the
    /// only fix for one is to take it out.
    pub is_file: bool,
}

/// Whether Discord can fetch this media URL itself.
pub fn is_sendable_url(url: &str) -> bool {
    ["https://", "http://"].iter().any(|scheme| {
        url.len() > scheme.len()
            && url.as_bytes()[..scheme.len()].eq_ignore_ascii_case(scheme.as_bytes())
    })
}

/// Every picture or file in `components` that a reply couldn't send, in
/// document order. Empty when the whole message can be sent.
pub fn unsendable_media(components: &[Value]) -> Vec<Unsendable> {
    let mut out = Vec::new();
    collect(components, &mut out);
    out
}

fn collect(components: &[Value], out: &mut Vec<Unsendable>) {
    for node in components {
        match kind(node) {
            Some(COMPONENT_SECTION) => {
                if let Some(accessory) = node
                    .get("accessory")
                    .filter(|a| kind(a) == Some(COMPONENT_THUMBNAIL))
                {
                    note(out, accessory.get("media"), false);
                }
            }
            Some(COMPONENT_THUMBNAIL) => note(out, node.get("media"), false),
            Some(COMPONENT_MEDIA_GALLERY) => {
                for item in node
                    .get("items")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    note(out, item.get("media"), false);
                }
            }
            Some(COMPONENT_FILE) => note(out, node.get("file"), true),
            Some(COMPONENT_CONTAINER) => {
                if let Some(children) = node.get("components").and_then(Value::as_array) {
                    collect(children, out);
                }
            }
            _ => {}
        }
    }
}

/// Leave out every picture or file a reply couldn't send, keeping the layout
/// one Discord accepts: a gallery keeps its other pictures (and goes once none
/// are left), a Section whose thumbnail goes becomes its own text — a Section
/// can't stand without its accessory — and a Container this empties goes too.
/// Returns how many pictures and files were left out.
pub fn strip_unsendable(components: &mut Vec<Value>) -> usize {
    let mut removed = 0;
    for mut node in std::mem::take(components) {
        match kind(&node) {
            Some(COMPONENT_SECTION) if section_thumbnail_unsendable(&node) => {
                removed += 1;
                if let Some(Value::Array(texts)) = node.get_mut("components").map(Value::take) {
                    components.extend(texts);
                }
            }
            Some(COMPONENT_THUMBNAIL) if !sendable(node.get("media")) => removed += 1,
            Some(COMPONENT_FILE) if !sendable(node.get("file")) => removed += 1,
            Some(COMPONENT_MEDIA_GALLERY) => {
                if let Some(Value::Array(items)) = node.get_mut("items") {
                    let before = items.len();
                    items.retain(|item| sendable(item.get("media")));
                    removed += before - items.len();
                    if items.is_empty() {
                        continue;
                    }
                }
                components.push(node);
            }
            Some(COMPONENT_CONTAINER) => {
                if let Some(Value::Array(children)) = node.get_mut("components") {
                    removed += strip_unsendable(children);
                    if children.is_empty() {
                        continue;
                    }
                }
                components.push(node);
            }
            _ => components.push(node),
        }
    }
    removed
}

fn note(out: &mut Vec<Unsendable>, media: Option<&Value>, is_file: bool) {
    if !sendable(media) {
        out.push(Unsendable {
            name: describe(media),
            is_file,
        });
    }
}

fn kind(node: &Value) -> Option<u64> {
    node.get("type").and_then(Value::as_u64)
}

fn section_thumbnail_unsendable(section: &Value) -> bool {
    section
        .get("accessory")
        .filter(|a| kind(a) == Some(COMPONENT_THUMBNAIL))
        .is_some_and(|thumbnail| !sendable(thumbnail.get("media")))
}

fn media_url(media: Option<&Value>) -> Option<&str> {
    media?.get("url")?.as_str()
}

fn sendable(media: Option<&Value>) -> bool {
    media_url(media).is_some_and(is_sendable_url)
}

/// What to call an unsendable picture in a message to its author: the name of
/// the file they uploaded (`session://<id>/<name>`, `attachment://<name>`), else
/// the reference exactly as they wrote it.
fn describe(media: Option<&Value>) -> String {
    let Some(url) = media_url(media).map(str::trim).filter(|u| !u.is_empty()) else {
        return "a picture with no link".to_string();
    };
    let name = url
        .strip_prefix("session://")
        .and_then(|rest| rest.split_once('/').map(|(_, name)| name))
        .or_else(|| url.strip_prefix("attachment://"))
        .filter(|name| !name.is_empty())
        .unwrap_or(url);
    if name.chars().count() > MAX_NAME_CHARS {
        let mut short: String = name.chars().take(MAX_NAME_CHARS).collect();
        short.push('…');
        short
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thumbnail(url: &str) -> Value {
        json!({ "type": COMPONENT_THUMBNAIL, "media": { "url": url } })
    }

    fn section(text: &str, thumb_url: &str) -> Value {
        json!({
            "type": COMPONENT_SECTION,
            "components": [{ "type": 10, "content": text }],
            "accessory": thumbnail(thumb_url),
        })
    }

    fn gallery(urls: &[&str]) -> Value {
        json!({
            "type": COMPONENT_MEDIA_GALLERY,
            "items": urls.iter().map(|u| json!({ "media": { "url": u } })).collect::<Vec<_>>(),
        })
    }

    fn names(found: &[Unsendable]) -> Vec<&str> {
        found.iter().map(|u| u.name.as_str()).collect()
    }

    /// The shape of the 2026-10-01 report: a container whose section carries
    /// an uploaded thumbnail beside the text.
    fn reported_reply(thumb_url: &str) -> Vec<Value> {
        vec![json!({
            "type": COMPONENT_CONTAINER,
            "accent_color": 5814783,
            "components": [
                section("## ⬩➤ Access Roles & Delays", thumb_url),
                { "type": 14 },
                { "type": 10, "content": "- {user}, these are the roles…" },
            ],
        })]
    }

    #[test]
    fn only_a_web_link_is_sendable() {
        for ok in [
            "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3&",
            "http://example.com/a.png",
            "HTTPS://EXAMPLE.COM/A.PNG",
        ] {
            assert!(is_sendable_url(ok), "{ok}");
        }
        for bad in [
            "session://365f8d9a61bd419e/icon67.png",
            "attachment://icon67.png",
            "{server_icon}",
            "https://",
            "",
            "ftp://example.com/a.png",
            "data:image/png;base64,AAAA",
        ] {
            assert!(!is_sendable_url(bad), "{bad}");
        }
    }

    #[test]
    fn finds_an_uploaded_thumbnail_by_its_file_name() {
        let found = unsendable_media(&reported_reply("session://365f8d9a61bd419e/icon67.png"));
        assert_eq!(
            found,
            vec![Unsendable {
                name: "icon67.png".into(),
                is_file: false
            }]
        );
        let linked = reported_reply("https://cdn.discordapp.com/attachments/1/2/Memory.png");
        assert!(unsendable_media(&linked).is_empty());
    }

    #[test]
    fn finds_every_kind_of_unsendable_media_in_document_order() {
        let components = vec![
            gallery(&[
                "https://ok/a.png",
                "session://abc/one.png",
                "attachment://two.png",
            ]),
            json!({
                "type": COMPONENT_CONTAINER,
                "components": [
                    section("text", "{server_icon}"),
                    { "type": COMPONENT_FILE, "file": { "url": "session://def/rules.pdf" } },
                ],
            }),
            // A media item with only an attachment id names nothing to fetch.
            json!({ "type": COMPONENT_THUMBNAIL, "media": { "attachment_id": "123456789012345678" } }),
        ];
        let found = unsendable_media(&components);
        assert_eq!(
            names(&found),
            vec![
                "one.png",
                "two.png",
                "{server_icon}",
                "rules.pdf",
                "a picture with no link"
            ]
        );
        assert_eq!(
            found.iter().map(|u| u.is_file).collect::<Vec<_>>(),
            vec![false, false, false, true, false]
        );
    }

    #[test]
    fn a_section_with_a_button_accessory_is_left_alone() {
        let components = vec![json!({
            "type": COMPONENT_SECTION,
            "components": [{ "type": 10, "content": "text" }],
            "accessory": { "type": 2, "style": 5, "label": "Open", "url": "https://x" },
        })];
        assert!(unsendable_media(&components).is_empty());
        let mut stripped = components.clone();
        assert_eq!(strip_unsendable(&mut stripped), 0);
        assert_eq!(stripped, components);
    }

    #[test]
    fn a_section_losing_its_thumbnail_becomes_its_own_text() {
        let mut components = reported_reply("session://365f8d9a61bd419e/icon67.png");
        assert_eq!(strip_unsendable(&mut components), 1);
        assert_eq!(
            components,
            vec![json!({
                "type": COMPONENT_CONTAINER,
                "accent_color": 5814783,
                "components": [
                    { "type": 10, "content": "## ⬩➤ Access Roles & Delays" },
                    { "type": 14 },
                    { "type": 10, "content": "- {user}, these are the roles…" },
                ],
            })]
        );
        assert!(unsendable_media(&components).is_empty());
    }

    #[test]
    fn a_gallery_keeps_its_linked_pictures_and_goes_once_none_are_left() {
        let mut mixed = vec![gallery(&["session://a/x.png", "https://ok/y.png"])];
        assert_eq!(strip_unsendable(&mut mixed), 1);
        assert_eq!(mixed, vec![gallery(&["https://ok/y.png"])]);

        let mut all_uploads = vec![
            json!({ "type": 10, "content": "Look:" }),
            gallery(&["session://a/x.png", "session://b/y.png"]),
        ];
        assert_eq!(strip_unsendable(&mut all_uploads), 2);
        assert_eq!(all_uploads, vec![json!({ "type": 10, "content": "Look:" })]);
    }

    #[test]
    fn a_container_emptied_by_stripping_goes_too() {
        let mut components = vec![
            json!({ "type": COMPONENT_CONTAINER, "components": [gallery(&["session://a/x.png"])] }),
            json!({ "type": COMPONENT_FILE, "file": { "url": "session://b/rules.pdf" } }),
        ];
        assert_eq!(strip_unsendable(&mut components), 2);
        assert!(components.is_empty());
    }

    #[test]
    fn a_sendable_message_comes_through_byte_for_byte() {
        let components = vec![
            section("hi", "https://ok/a.png"),
            gallery(&["https://ok/b.png"]),
            json!({ "type": COMPONENT_CONTAINER, "components": [{ "type": 10, "content": "x" }] }),
        ];
        let mut stripped = components.clone();
        assert_eq!(strip_unsendable(&mut stripped), 0);
        assert_eq!(stripped, components);
    }

    #[test]
    fn a_long_reference_is_elided_in_messages() {
        let long = format!("session://abc/{}.png", "n".repeat(200));
        let found = unsendable_media(&[thumbnail(&long)]);
        assert_eq!(found[0].name.chars().count(), MAX_NAME_CHARS + 1);
        assert!(found[0].name.ends_with('…'));
    }
}
