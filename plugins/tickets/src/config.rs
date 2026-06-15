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
// (`src/core/guild/config.ts`) and the same constant in every other plugin that
// builds an invite for the shared bot (e.g. self-role): all of them produce the
// one value every invite carries. Bump them together when a plugin's needs
// change.

/// Manage Channels — tickets creates/deletes the per-ticket channel
/// (`POST /guilds/{guild}/channels`, `DELETE /channels/{id}`).
const MANAGE_CHANNELS: u64 = 1 << 4;
/// Manage Roles — required to set a channel's permission overwrites (the
/// per-ticket "only the opener + staff can see this" rule). Also what self-role
/// needs to assign roles, so it is shared across both plugins.
const MANAGE_ROLES: u64 = 1 << 28;

/// The union every shared-bot invite must request: Manage Channels + Manage Roles.
const SHARED_BOT_PERMISSIONS: u64 = MANAGE_CHANNELS | MANAGE_ROLES;

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
    /// Port to bind. Defaults to 8093.
    pub port: u16,
    /// Public origin this service is reachable at, e.g.
    /// `https://tickets.example.com`. Used to build the `configUrl` in the
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
    /// SQLite database file path. Defaults to `./tickets.db`.
    pub database_path: String,
    /// The deployment-wide shared "Tickets" bot token. Every panel opens tickets
    /// with this bot — a server admin only ever *invites* it, never pastes a
    /// token. Stored only in memory, never returned to a browser. None = no bot
    /// configured, so the config UI refuses to set up a panel and clicks can't
    /// open tickets.
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
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8093);

        let public_base_url = env::var("PUBLIC_BASE_URL")
            .unwrap_or_else(|_| format!("http://localhost:{port}"))
            .trim_end_matches('/')
            .to_string();

        let discord_public_key = env::var("DISCORD_PUBLIC_KEY")
            .map_err(|_| "DISCORD_PUBLIC_KEY is required (your Discord app's public key)".to_string())?
            .trim()
            .to_string();

        if hex::decode(&discord_public_key).map(|b| b.len()) != Ok(32) {
            return Err("DISCORD_PUBLIC_KEY must be 32 bytes of hex (64 chars)".to_string());
        }

        let dispatcher_forward_secret = env::var("DISPATCHER_FORWARD_SECRET")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        let database_path = env::var("DATABASE_PATH").unwrap_or_else(|_| "./tickets.db".to_string());

        let default_bot_token = env::var("BOT_TOKEN")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        let bot_invite_url = env::var("BOT_INVITE_URL")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .map(|raw| normalize_invite_permissions(&raw));

        Ok(Self {
            port,
            public_base_url,
            discord_public_key,
            dispatcher_forward_secret,
            database_path,
            default_bot_token,
            bot_invite_url,
        })
    }

    /// True when the deployment has the shared bot configured, so panels can be
    /// set up and clicks can open tickets.
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

    /// The union string every DWEEB shared-bot invite must carry. Mirrors
    /// `SHARED_BOT_PERMISSIONS` in the frontend and self-role; this test is the
    /// tripwire that fails if the three drift apart.
    const UNION: &str = "268435472"; // (1<<4) | (1<<28)

    #[test]
    fn union_is_manage_channels_plus_manage_roles() {
        assert_eq!(SHARED_BOT_PERMISSIONS.to_string(), UNION);
    }

    #[test]
    fn rewrites_a_too_narrow_permissions_to_the_union() {
        // Operator pasted permissions=0 — must be forced up to the shared union
        // so re-inviting through this link can't strip another plugin's grant.
        let out = normalize_invite_permissions(
            "https://discord.com/oauth2/authorize?client_id=123&scope=bot&permissions=0",
        );
        assert_eq!(perms_of(&out).as_deref(), Some(UNION));
    }

    #[test]
    fn adds_permissions_when_absent_and_keeps_other_params() {
        let out = normalize_invite_permissions(
            "https://discord.com/oauth2/authorize?client_id=123&scope=bot",
        );
        let url = reqwest::Url::parse(&out).unwrap();
        // client_id / scope preserved verbatim…
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "client_id").map(|(_, v)| v.into_owned()),
            Some("123".to_string())
        );
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "scope").map(|(_, v)| v.into_owned()),
            Some("bot".to_string())
        );
        // …and the union is appended, exactly once.
        assert_eq!(perms_of(&out).as_deref(), Some(UNION));
        assert_eq!(url.query_pairs().filter(|(k, _)| k == "permissions").count(), 1);
    }

    #[test]
    fn unparseable_url_is_left_untouched() {
        let raw = "not a url";
        assert_eq!(normalize_invite_permissions(raw), raw);
    }
}
