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

/// Manage Channels — the tickets plugin creates/deletes per-ticket channels.
/// Self Role doesn't use it, but the shared bot's invite must still request it
/// so re-inviting through *this* plugin's link can't strip tickets' grant.
const MANAGE_CHANNELS: u64 = 1 << 4;
/// Manage Roles — self-role assigns/removes roles (`PUT …/members/{user}/roles`).
const MANAGE_ROLES: u64 = 1 << 28;

/// Manage Webhooks — the proxy's Webhook Manager enumerates and manages a
/// server's webhooks through the shared bot token (`GET /guilds/{id}/webhooks`
/// and every create/modify/delete call requires it).
const MANAGE_WEBHOOKS: u64 = 1 << 29;

/// The union every shared-bot invite must request: Manage Channels + Manage
/// Roles + Manage Webhooks.
const SHARED_BOT_PERMISSIONS: u64 = MANAGE_CHANNELS | MANAGE_ROLES | MANAGE_WEBHOOKS;

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
    /// Port to bind. Defaults to 8092.
    pub port: u16,
    /// Public origin this service is reachable at, e.g.
    /// `https://selfrole.example.com`. Used to build the `configUrl` in the
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
    /// SQLite database file path. Defaults to `./self-role.db`.
    pub database_path: String,
    /// The deployment-wide shared "Self Role" bot token. Every instance assigns
    /// roles with this bot — a server admin only ever *invites* it, never pastes
    /// a token. Stored only in memory, never returned to a browser. None = no bot
    /// configured, so the config UI refuses to set up a menu and clicks can't
    /// assign roles.
    pub default_bot_token: Option<String>,
    /// Optional OAuth invite URL for the shared bot above (`scope=bot`),
    /// surfaced by `/api/meta` so the config UI can offer a one-click "Add the
    /// bot to your server" button. None = the UI shows generic guidance instead.
    ///
    /// Its `permissions` are normalized to [`SHARED_BOT_PERMISSIONS`] at parse
    /// time (see [`normalize_invite_permissions`]), so the operator only needs to
    /// supply a valid invite for the right app — they can't accidentally make it
    /// request a set that would strip another plugin's grant on re-invite.
    pub bot_invite_url: Option<String>,
    /// How often (seconds) the temporary-role reaper wakes to take back expired
    /// roles. Defaults to 30; clamped to a 5s floor. Lower it in dev to watch
    /// auto-removal happen quickly.
    pub reaper_interval_secs: u64,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8092);

        let public_base_url = env::var("PUBLIC_BASE_URL")
            .unwrap_or_else(|_| format!("http://localhost:{port}"))
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

        let database_path =
            env::var("DATABASE_PATH").unwrap_or_else(|_| "./self-role.db".to_string());

        let default_bot_token = env::var("BOT_TOKEN")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        let bot_invite_url = env::var("BOT_INVITE_URL")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .map(|raw| normalize_invite_permissions(&raw));

        let reaper_interval_secs = env::var("REAPER_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);

        Ok(Self {
            port,
            public_base_url,
            discord_public_key,
            dispatcher_forward_secret,
            database_path,
            default_bot_token,
            bot_invite_url,
            reaper_interval_secs,
        })
    }

    /// True when the deployment has the shared bot configured, so menus can be
    /// set up and clicks can assign roles.
    pub fn has_default_bot(&self) -> bool {
        self.default_bot_token.is_some()
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
        assert_eq!(perms_of(&out).as_deref(), Some("805306384"));
    }

    #[test]
    fn adds_permissions_when_absent_and_keeps_other_params() {
        let out = normalize_invite_permissions(
            "https://discord.com/oauth2/authorize?client_id=123&scope=bot",
        );
        let url = reqwest::Url::parse(&out).unwrap();
        // client_id / scope preserved verbatim…
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "client_id")
                .map(|(_, v)| v.into_owned()),
            Some("123".to_string())
        );
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "scope")
                .map(|(_, v)| v.into_owned()),
            Some("bot".to_string())
        );
        // …and the union is appended.
        assert_eq!(perms_of(&out).as_deref(), Some("805306384"));
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
}
