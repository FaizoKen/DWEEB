//! HTTP handlers and shared application state.
//!
//! The guild reads are now gated on a Discord login: every `/api/guilds/...`
//! request must carry a valid session, and the requested guild must be one the
//! signed-in user actually belongs to (and, by default, manages). That check is
//! what makes the proxy safe to expose publicly — a visitor can only read
//! servers that are genuinely theirs, not enumerate every guild the bot is in.
//!
//! Authorization data (the user's guild list) is cached per-user for the same
//! short TTL as the guild reads, so the hot path is a couple of map lookups
//! rather than a Discord round trip.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{FromRef, Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::cookie::{Key, PrivateCookieJar};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::cache::DataCache;
use crate::config::Config;
use crate::discord::Discord;
use crate::error::AppError;
use crate::session::{Session, SESSION_COOKIE};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub discord: Arc<Discord>,
    pub cache: Arc<DataCache>,
    /// Master key for encrypting/decrypting cookies.
    pub key: Key,
}

// Lets `PrivateCookieJar` be extracted from handlers that hold `AppState`.
impl FromRef<AppState> for Key {
    fn from_ref(state: &AppState) -> Self {
        state.key.clone()
    }
}

/// A guild the signed-in user may use, trimmed for the FE server picker.
#[derive(Serialize, Deserialize, Clone)]
pub struct UsableGuild {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
}

/// Liveness probe — no auth, no upstream calls.
pub async fn health() -> impl IntoResponse {
    axum::Json(json!({ "status": "ok" }))
}

// ── Guild reads (login + membership gated) ─────────────────────────────────

pub async fn roles(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let value = fetch_roles(&st, &guild).await?;
    Ok(value_response(&value))
}

pub async fn channels(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let value = fetch_channels(&st, &guild).await?;
    Ok(value_response(&value))
}

pub async fn emojis(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let value = fetch_emojis(&st, &guild).await?;
    Ok(value_response(&value))
}

/// Roles + channels + emojis in one response, so the builder can hydrate every
/// picker with a single request.
pub async fn bootstrap(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let roles = fetch_roles(&st, &guild).await?;
    let channels = fetch_channels(&st, &guild).await?;
    let emojis = fetch_emojis(&st, &guild).await?;

    let mut obj = Map::new();
    obj.insert("roles".to_string(), (*roles).clone());
    obj.insert("channels".to_string(), (*channels).clone());
    obj.insert("emojis".to_string(), (*emojis).clone());
    Ok(value_response(&Value::Object(obj)))
}

/// The signed-in user's usable servers, each flagged with whether the DWEEB bot
/// is already a member — drives the FE picker + "add the bot" prompts.
pub async fn list_guilds(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
) -> Result<Response, AppError> {
    let session = require_session(&jar)?;
    let guilds = usable_guilds(&st, &session).await?;
    let bot = bot_guild_set(&st).await;

    let items: Vec<Value> = guilds
        .iter()
        .map(|g| {
            json!({
                "id": g.id,
                "name": g.name,
                "icon": g.icon,
                "bot_present": bot.contains(&g.id),
            })
        })
        .collect();
    Ok(value_response(&json!({ "guilds": items })))
}

// ── Authorization ──────────────────────────────────────────────────────────

/// Decode a valid, unexpired session or reject with 401.
fn require_session(jar: &PrivateCookieJar) -> Result<Session, AppError> {
    current_session(jar)
        .ok_or_else(|| AppError::Unauthorized("Sign in with Discord to load server data.".into()))
}

/// Read + validate the session cookie (decrypted by the private jar).
pub fn current_session(jar: &PrivateCookieJar) -> Option<Session> {
    let cookie = jar.get(SESSION_COOKIE)?;
    let session: Session = serde_json::from_str(cookie.value()).ok()?;
    if session.is_expired() {
        return None;
    }
    Some(session)
}

/// Ensure the caller is signed in and the requested guild is one they may use.
async fn authorize_member(
    st: &AppState,
    jar: &PrivateCookieJar,
    guild: &str,
) -> Result<(), AppError> {
    let session = require_session(jar)?;
    let guilds = usable_guilds(st, &session).await?;
    if guilds.iter().any(|g| g.id == guild) {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "You can only load servers you manage. If you just added the bot, sign in again to refresh your server list.".into(),
        ))
    }
}

/// The user's usable guilds (owner or `MANAGE_GUILD`, unless that gate is off),
/// cached per-user so repeat reads don't re-hit Discord.
async fn usable_guilds(st: &AppState, session: &Session) -> Result<Vec<UsableGuild>, AppError> {
    let key = format!("uguilds:{}", session.uid);
    if let Some(v) = st.cache.get(&key).await {
        if let Ok(list) = serde_json::from_value::<Vec<UsableGuild>>((*v).clone()) {
            return Ok(list);
        }
    }
    let raw = st.discord.current_user_guilds(&session.token).await?;
    let require = st.config.require_manage_guild;
    let list: Vec<UsableGuild> = raw
        .into_iter()
        .filter(|g| !require || g.can_manage())
        .map(|g| UsableGuild {
            id: g.id,
            name: g.name,
            icon: g.icon,
        })
        .collect();
    if let Ok(val) = serde_json::to_value(&list) {
        st.cache.put(key, Arc::new(val)).await;
    }
    Ok(list)
}

/// The set of guild ids the bot is in (cached). Best-effort: an error here only
/// costs the picker its "bot already added" annotation, never a failed request.
async fn bot_guild_set(st: &AppState) -> HashSet<String> {
    const KEY: &str = "botguilds";
    if let Some(v) = st.cache.get(KEY).await {
        if let Ok(ids) = serde_json::from_value::<Vec<String>>((*v).clone()) {
            return ids.into_iter().collect();
        }
    }
    match st.discord.bot_guild_ids().await {
        Ok(ids) => {
            if let Ok(val) = serde_json::to_value(&ids) {
                st.cache.put(KEY.to_string(), Arc::new(val)).await;
            }
            ids.into_iter().collect()
        }
        Err(_) => HashSet::new(),
    }
}

// ── Cached guild reads ─────────────────────────────────────────────────────

async fn fetch_roles(st: &AppState, guild: &str) -> Result<Arc<Value>, AppError> {
    let key = format!("roles:{guild}");
    if let Some(v) = st.cache.get(&key).await {
        return Ok(v);
    }
    let value = Arc::new(to_value(st.discord.roles(guild).await?)?);
    st.cache.put(key, Arc::clone(&value)).await;
    Ok(value)
}

async fn fetch_channels(st: &AppState, guild: &str) -> Result<Arc<Value>, AppError> {
    let key = format!("channels:{guild}");
    if let Some(v) = st.cache.get(&key).await {
        return Ok(v);
    }
    let value = Arc::new(to_value(st.discord.channels(guild).await?)?);
    st.cache.put(key, Arc::clone(&value)).await;
    Ok(value)
}

async fn fetch_emojis(st: &AppState, guild: &str) -> Result<Arc<Value>, AppError> {
    let key = format!("emojis:{guild}");
    if let Some(v) = st.cache.get(&key).await {
        return Ok(v);
    }
    let value = Arc::new(to_value(st.discord.emojis(guild).await?)?);
    st.cache.put(key, Arc::clone(&value)).await;
    Ok(value)
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|e| AppError::Internal(e.to_string()))
}

/// Serialise a `Value` directly to bytes for the response body.
fn value_response(value: &Value) -> Response {
    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    ([(header::CONTENT_TYPE, "application/json")], bytes).into_response()
}
