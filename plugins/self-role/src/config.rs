//! Runtime configuration, read once from the environment at startup.

use std::env;

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
    /// Optional OAuth invite URL for the shared bot above (scope=bot, with
    /// Manage Roles), surfaced by `/api/meta` so the config UI can offer a
    /// one-click "Add the bot to your server" button. None = the UI shows
    /// generic guidance instead.
    pub bot_invite_url: Option<String>,
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

        let database_path =
            env::var("DATABASE_PATH").unwrap_or_else(|_| "./self-role.db".to_string());

        let default_bot_token = env::var("BOT_TOKEN")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        let bot_invite_url = env::var("BOT_INVITE_URL")
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

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

    /// True when the deployment has the shared bot configured, so menus can be
    /// set up and clicks can assign roles.
    pub fn has_default_bot(&self) -> bool {
        self.default_bot_token.is_some()
    }
}
