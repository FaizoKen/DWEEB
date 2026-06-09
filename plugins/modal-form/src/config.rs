//! Runtime configuration, read once from the environment at startup.

use std::env;

#[derive(Clone)]
pub struct Config {
    /// Port to bind. Defaults to 8090.
    pub port: u16,
    /// Public origin this service is reachable at, e.g.
    /// `https://modalform.example.com`. Used to build the `configUrl` in the
    /// registry so DWEEB embeds the right iframe. No trailing slash.
    pub public_base_url: String,
    /// Discord application **public key** (hex), from the Developer Portal.
    /// Used to verify interaction signatures.
    pub discord_public_key: String,
    /// SQLite database file path. Defaults to `./modal-form.db`.
    pub database_path: String,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8090);

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

        let database_path =
            env::var("DATABASE_PATH").unwrap_or_else(|_| "./modal-form.db".to_string());

        Ok(Self {
            port,
            public_base_url,
            discord_public_key,
            database_path,
        })
    }
}
