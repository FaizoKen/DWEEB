//! Runtime configuration, read once from the environment at startup.

use std::env;

// ── Shared-bot invite permissions ────────────────────────────────────────────
//
// Discord's bot invite is destructive on re-authorization: adding the bot to a
// guild sets its integration-managed role to *exactly* the `permissions` value
// in the URL — it replaces, it never merges. The DWEEB bot is shared, and one
// message can mix plugins with different needs, so every invite URL for it must
// request the SAME union — otherwise re-inviting through a narrower link strips
// the permissions the other plugins rely on. The base is 0; each bit is added
// only because a bundled plugin requires it.
//
// This MUST mirror `SHARED_BOT_PERMISSIONS` in the DWEEB frontend
// (`src/core/guild/config.ts`): both produce the one value every invite carries.
// Bump both together when a plugin's needs change.
//
// This plugin itself needs NO permission bit at all — it only ever *reads*
// (`GET /guilds/{id}/roles`, `/channels`, `/members`), which the bot may do
// simply by being a member of the guild. It still normalizes the invite to the
// full union so an operator pasting a narrower link here can't strip another
// plugin's grant.

/// Create Instant Invite — the proxy's bot mints an Activity invite so
/// `discord.gg/…` launches DWEEB in a channel ("Collaborate in Discord").
const CREATE_INSTANT_INVITE: u64 = 1 << 0;
/// Manage Channels — the tickets plugin creates/deletes per-ticket channels.
const MANAGE_CHANNELS: u64 = 1 << 4;
/// Manage Roles — the self-role plugin assigns/removes roles.
const MANAGE_ROLES: u64 = 1 << 28;
/// Manage Webhooks — the proxy's Webhook Manager enumerates and manages a
/// server's webhooks through the shared bot token.
const MANAGE_WEBHOOKS: u64 = 1 << 29;

/// The union every shared-bot invite must request: Create Instant Invite +
/// Manage Channels + Manage Roles + Manage Webhooks.
const SHARED_BOT_PERMISSIONS: u64 =
    CREATE_INSTANT_INVITE | MANAGE_CHANNELS | MANAGE_ROLES | MANAGE_WEBHOOKS;

/// Force an operator-supplied invite URL's `permissions` to [`SHARED_BOT_PERMISSIONS`].
///
/// The operator only has to paste *an* invite for the shared bot (the client_id
/// is what matters); whatever `permissions` it carries — `0`, a stale value, a
/// too-narrow set — is overridden so this plugin's invite can never under-request
/// and strip another plugin's grant. A URL we can't parse is left untouched: a
/// working-ish link beats none, and the worst case is the old behaviour.
fn normalize_invite_permissions(raw: &str) -> String {
    match reqwest::Url::parse(raw) {
        Ok(mut url) => {
            // Keep every other query param verbatim (e.g. client_id, scope); only
            // `permissions` is rewritten.
            let kept: Vec<(String, String)> = url
                .query_pairs()
                .filter(|(k, _)| k != "permissions")
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            url.query_pairs_mut()
                .clear()
                .extend_pairs(kept)
                .append_pair("permissions", &SHARED_BOT_PERMISSIONS.to_string());
            url.into()
        }
        Err(_) => raw.to_string(),
    }
}

#[derive(Clone)]
pub struct Config {
    /// Port to bind. Defaults to 8099.
    pub port: u16,
    /// Public origin this service is reachable at, e.g.
    /// `https://directory.example.com`. Used to build the `configUrl` in the
    /// registry so DWEEB embeds the right iframe. No trailing slash.
    pub public_base_url: String,
    /// Discord application **public key** (hex), from the Developer Portal.
    /// Used to verify interaction signatures.
    pub discord_public_key: String,
    /// Shared secret with the interactions dispatcher. When a forwarded
    /// request carries it, the dispatcher's `x-dweeb-public-key` header names
    /// the verifying key — how interactions from guild-registered custom apps
    /// still get cryptographically verified here. None = only the primary key
    /// ever verifies.
    pub dispatcher_forward_secret: Option<String>,
    /// SQLite database file path. Defaults to `./directory.db`.
    pub database_path: String,
    /// The deployment-wide shared bot token. Every directory is read through
    /// this bot — a server admin only ever *invites* it, never pastes a token.
    /// Stored only in memory, never returned to a browser. None = no bot
    /// configured, so the config UI refuses to set one up and clicks can't
    /// read the server.
    pub default_bot_token: Option<String>,
    /// Optional OAuth invite URL for the shared bot above (`scope=bot`),
    /// surfaced by `/api/meta` so the config UI can offer a one-click "Add the
    /// bot to your server" button. None = the UI shows generic guidance instead.
    ///
    /// Its `permissions` are normalized to [`SHARED_BOT_PERMISSIONS`] at parse
    /// time (see [`normalize_invite_permissions`]).
    pub bot_invite_url: Option<String>,
    /// Seconds a fetched role/channel list stays warm. Roles and channels are
    /// one cheap request each, so this exists to keep a spammed button from
    /// hammering Discord rather than to save real time. Default 60; a 0 disables
    /// caching entirely (useful while testing a live edit).
    pub structure_cache_secs: u64,
    /// Seconds a member scan stays warm. Much longer than the structure TTL: a
    /// scan is the expensive call (a page per 1000 members) and staff rosters
    /// barely move. Default 600.
    pub member_cache_secs: u64,
    /// How many guilds may hold a cached scan at once. Bounds process memory on
    /// a deployment serving many servers; the coldest entry is dropped past the
    /// cap. Default 64, floor 1.
    pub cache_max_guilds: usize,
    /// Pages of 1000 members a single scan may read before it stops and reports
    /// a partial result. This is the hard ceiling on what one click can cost:
    /// 10 pages ≈ 10 sequential Discord calls ≈ 10k members. Default 10, floor 1.
    pub member_scan_max_pages: usize,
    /// How many member scans may run at once, process-wide. Also the plugin's
    /// single-flight mechanism: a queued click re-checks the cache after
    /// acquiring its permit, so a burst of clicks on one server performs ONE
    /// scan. Default 1, floor 1.
    pub member_scan_concurrency: usize,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.trim().parse().ok())
            .unwrap_or(8099);

        let public_base_url = env::var("PUBLIC_BASE_URL")
            .unwrap_or_else(|_| format!("http://localhost:{port}"))
            .trim()
            .trim_end_matches('/')
            .to_string();

        let discord_public_key = env::var("DISCORD_PUBLIC_KEY")
            .map_err(|_| {
                "DISCORD_PUBLIC_KEY is required (your Discord app's public key)".to_string()
            })?
            .trim()
            .to_string();

        if hex::decode(&discord_public_key).map(|b| b.len()) != Ok(32) {
            return Err("DISCORD_PUBLIC_KEY must be 32 bytes of hex (64 chars)".to_string());
        }

        let dispatcher_forward_secret = env::var("DISPATCHER_FORWARD_SECRET")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        let database_path = env::var("DATABASE_PATH")
            .map(|p| p.trim().to_string())
            .ok()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "./directory.db".to_string());

        let default_bot_token = env::var("BOT_TOKEN")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        let bot_invite_url = env::var("BOT_INVITE_URL")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .map(|raw| normalize_invite_permissions(&raw));

        let structure_cache_secs = parse_num("STRUCTURE_CACHE_SECS", 60, 0)?;
        let member_cache_secs = parse_num("MEMBER_CACHE_SECS", 600, 0)?;
        let cache_max_guilds = parse_num("CACHE_MAX_GUILDS", 64, 1)? as usize;
        let member_scan_max_pages = parse_num("MEMBER_SCAN_MAX_PAGES", 10, 1)? as usize;
        let member_scan_concurrency = parse_num("MEMBER_SCAN_CONCURRENCY", 1, 1)? as usize;

        Ok(Self {
            port,
            public_base_url,
            discord_public_key,
            dispatcher_forward_secret,
            database_path,
            default_bot_token,
            bot_invite_url,
            structure_cache_secs,
            member_cache_secs,
            cache_max_guilds,
            member_scan_max_pages,
            member_scan_concurrency,
        })
    }

    /// True when the deployment has the shared bot configured, so a directory
    /// can be set up and a click can read the server.
    pub fn has_default_bot(&self) -> bool {
        self.default_bot_token.is_some()
    }
}

/// Parse a numeric env var, clamped up to `floor`.
///
/// A *present but unparseable* value is a boot error rather than a silent fall
/// back to the default — the house rule from the proxy's `config.rs`. Silently
/// defaulting is how a typo'd `MEMBER_SCAN_MAX_PAGES=1O` becomes an unexplained
/// behaviour change nobody can find. The value is trimmed first, so trailing
/// whitespace in an `.env` file is harmless.
fn parse_num(key: &str, default: u64, floor: u64) -> Result<u64, String> {
    match env::var(key) {
        Err(_) => Ok(default),
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Ok(default);
            }
            let parsed: u64 = trimmed
                .parse()
                .map_err(|_| format!("{key} must be a whole number (got {trimmed:?})"))?;
            Ok(parsed.max(floor))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perms_of(url: &str) -> Option<String> {
        reqwest::Url::parse(url)
            .unwrap()
            .query_pairs()
            .find(|(k, _)| k == "permissions")
            .map(|(_, v)| v.into_owned())
    }

    #[test]
    fn rewrites_a_too_narrow_permissions_to_the_union() {
        // Operator pasted permissions=0 — must be forced up to the shared union
        // so re-inviting through this link can't strip another plugin's grant.
        let out = normalize_invite_permissions(
            "https://discord.com/oauth2/authorize?client_id=123&scope=bot&permissions=0",
        );
        assert_eq!(perms_of(&out).as_deref(), Some("805306385"));
    }

    #[test]
    fn adds_permissions_when_absent_and_keeps_other_params() {
        let out = normalize_invite_permissions(
            "https://discord.com/oauth2/authorize?client_id=123&scope=bot",
        );
        let url = reqwest::Url::parse(&out).unwrap();
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "client_id")
                .map(|(_, v)| v.into_owned()),
            Some("123".to_string())
        );
        assert_eq!(perms_of(&out).as_deref(), Some("805306385"));
        // Exactly one `permissions` param, never duplicated.
        assert_eq!(
            url.query_pairs()
                .filter(|(k, _)| k == "permissions")
                .count(),
            1
        );
    }

    #[test]
    fn unparseable_url_is_left_untouched() {
        let raw = "not a url";
        assert_eq!(normalize_invite_permissions(raw), raw);
    }

    /// A malformed number must fail loudly at boot, never fall back to the
    /// default — the same rule the proxy's env parser enforces.
    #[test]
    fn a_malformed_number_is_a_boot_error() {
        // SAFETY-ish: these tests run in-process; the key is unique to this test.
        std::env::set_var("DWEEB_TEST_BAD_NUM", "1O");
        assert!(parse_num("DWEEB_TEST_BAD_NUM", 10, 1).is_err());
        std::env::remove_var("DWEEB_TEST_BAD_NUM");
    }

    #[test]
    fn an_absent_or_blank_number_takes_the_default_and_the_floor_clamps() {
        assert_eq!(parse_num("DWEEB_TEST_ABSENT_NUM", 7, 1), Ok(7));
        std::env::set_var("DWEEB_TEST_BLANK_NUM", "   ");
        assert_eq!(parse_num("DWEEB_TEST_BLANK_NUM", 7, 1), Ok(7));
        std::env::remove_var("DWEEB_TEST_BLANK_NUM");
        // A 0 where the floor is 1 is raised, not rejected: the operator meant
        // "as small as possible", and 0 pages/permits would wedge the feature.
        std::env::set_var("DWEEB_TEST_ZERO_NUM", "0");
        assert_eq!(parse_num("DWEEB_TEST_ZERO_NUM", 10, 1), Ok(1));
        std::env::remove_var("DWEEB_TEST_ZERO_NUM");
    }
}
