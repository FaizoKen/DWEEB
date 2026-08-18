//! The reference material the MCP server serves: the authoring guide, the
//! limits, and the built-in templates.
//!
//! None of it is written here. `catalog.json` is generated from
//! `src/data/presets.ts` and `src/core/schema/limits.ts` by
//! `scripts/gen-mcp-catalog.ts`, and the guide is sliced out of
//! `ai_prompt.txt` — the single instruction template this proxy already shares
//! with the browser's AI panel. Everything is `include_str!`'d, so the running
//! server needs no files beside its binary and the Docker build context (which
//! only copies `server/src`) stays sufficient.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::components::SchemaData;

/// One built-in template, as the tools present it.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub category: String,
    pub tags: Vec<String>,
    /// True when it carries a component only an application-owned webhook can
    /// make work.
    pub interactive: bool,
    pub pairs_with: Option<String>,
    /// The complete Components V2 payload.
    pub message: Value,
}

#[derive(Debug, Deserialize)]
struct RawCatalog {
    #[serde(flatten)]
    schema: SchemaData,
    templates: Vec<Template>,
}

struct Catalog {
    schema: SchemaData,
    templates: Vec<Template>,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        // A malformed catalog is a build-time mistake, not a runtime condition:
        // it ships inside the binary. Panicking here is a boot failure with an
        // exact reason, which is better than every tool call failing obscurely.
        let raw: RawCatalog = serde_json::from_str(include_str!("catalog.json"))
            .expect("server/src/mcp/catalog.json is malformed — re-run `bun run gen:mcp`");
        Catalog {
            schema: raw.schema,
            templates: raw.templates,
        }
    })
}

/// Limits, core placeholder tokens, and link-plugin prefixes — everything the
/// validator needs from the TypeScript side.
pub fn schema_data() -> &'static SchemaData {
    &catalog().schema
}

pub fn templates() -> &'static [Template] {
    &catalog().templates
}

pub fn template(id: &str) -> Option<&'static Template> {
    templates().iter().find(|t| t.id == id)
}

/* ── The authoring guide ─────────────────────────────────────────────── */

/// Heading that opens the editor-specific output contract in the shared prompt.
const CONTRACT_HEADING: &str = "## Output contract (read carefully)";
/// Heading the schema description proper starts at.
const SHAPE_HEADING: &str = "## Message object shape";

/// The contract that replaces the shared template's opening section.
///
/// `ai_prompt.txt` opens by telling a model to answer with a fenced ```json
/// block, because that is how the *editor* applies a change. Over MCP there is
/// no such block — the message travels as a tool argument — and leaving the
/// instruction in invites a model to reply with code instead of calling a tool.
const MCP_CONTRACT: &str = r#"## How this server is driven
- The message is a JSON object passed as the `message` argument of a tool — never a
  fenced code block in your reply. Describing a change does nothing; calling a tool does.
- Always pass the COMPLETE message object, never a partial diff. The tools replace,
  they do not merge.
- `validate_message` is cheap and exact: it runs Discord's own rules before Discord
  does, and names the path of every offending component. Run it before sending.
- `preview_message` re-states the payload as the layout a reader sees, which is the
  fastest way to catch nesting and ordering mistakes.
- `create_share_link` opens the message in DWEEB's visual editor. That is how a human
  reviews it — prefer offering the link over describing the message in prose.
- Never include editor-internal fields like `_id`. Never include `content` or
  `embeds` at the top level."#;

/// The full authoring guide: this transport's contract, then the canonical
/// schema description.
///
/// If the shared template ever loses the headings this slices by, the whole
/// text is returned rather than half the schema — wrong-but-complete beats
/// silently missing, and `the_guide_is_sliced_from_the_shared_prompt` fails so
/// it gets fixed.
pub fn authoring_guide() -> &'static str {
    static GUIDE: OnceLock<String> = OnceLock::new();
    GUIDE.get_or_init(|| {
        let shared = shared_prompt();
        match (
            shared.contains(CONTRACT_HEADING),
            shared.find(SHAPE_HEADING),
        ) {
            (true, Some(start)) => format!("{MCP_CONTRACT}\n\n{}", shared[start..].trim_end()),
            _ => shared.to_string(),
        }
    })
}

/// The shared instruction template, newline-normalized (a Windows checkout can
/// hand `include_str!` CRLF endings).
fn shared_prompt() -> &'static str {
    static PROMPT: OnceLock<String> = OnceLock::new();
    PROMPT.get_or_init(|| include_str!("../ai_prompt.txt").replace("\r\n", "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_parses_and_carries_every_template() {
        assert!(
            templates().len() >= 30,
            "only {} templates — did the generator run?",
            templates().len()
        );
        assert!(template("welcome").is_some());
        assert!(template("no-such-template").is_none());
        for t in templates() {
            assert!(!t.id.is_empty());
            assert!(
                t.message.get("components").is_some(),
                "{} has no components",
                t.id
            );
        }
    }

    #[test]
    fn every_template_passes_the_validator() {
        // The catalogue is what a caller is told to start from, so anything in
        // it that Discord would reject is a bug shipped to every user of the
        // server. The one accepted exception is a link-plugin template whose
        // URL still carries the `{token}` the server owner must fill in.
        let data = schema_data();
        for t in templates() {
            let message = super::super::components::normalize(t.message.clone())
                .unwrap_or_else(|e| panic!("template {} does not normalize: {e}", t.id));
            let blocking: Vec<&str> = super::super::components::validate(&message, data)
                .into_iter()
                .filter(|i| i.severity == super::super::components::Severity::Error)
                .map(|i| i.code)
                .filter(|c| *c != "BUTTON_LINK_URL_UNFINISHED")
                .collect();
            assert!(
                blocking.is_empty(),
                "template {} is invalid: {blocking:?}",
                t.id
            );
        }
    }

    #[test]
    fn the_limits_come_from_the_generated_catalog() {
        let limits = &schema_data().limits;
        // Spot-check against Discord's documented caps. These are asserted, not
        // defined, here: the values live in `src/core/schema/limits.ts`.
        assert_eq!(limits.total_components, 40);
        assert_eq!(limits.top_level_components, 10);
        assert_eq!(limits.total_characters, 4000);
        assert!(!schema_data().core_placeholder_tokens.is_empty());
    }

    #[test]
    fn the_guide_is_sliced_from_the_shared_prompt() {
        let guide = authoring_guide();
        // The schema half survives…
        assert!(guide.contains("## Message object shape"));
        assert!(guide.contains("## Component types"));
        assert!(guide.contains("## Rejections to avoid"));
        // …and the editor's apply contract is replaced by this transport's.
        assert!(guide.contains("## How this server is driven"));
        assert!(!guide.contains("THE APP APPLIES CHANGES ONLY FROM THAT JSON BLOCK"));
    }

    #[test]
    fn the_guide_matches_the_prompt_the_ai_relay_uses() {
        // Both read the same file. If someone copies the prompt instead of
        // sharing it, this notices.
        assert!(shared_prompt().contains("Components V2"));
        assert!(shared_prompt().len() > 3000);
    }
}
