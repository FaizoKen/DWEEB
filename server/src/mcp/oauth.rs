//! OAuth 2.1 authorization server for the MCP endpoint.
//!
//! A remote MCP server can post to people's Discord channels, so it cannot be
//! open, and it cannot use DWEEB's session cookie either: the client is another
//! service, not a browser tab on our origin. MCP's answer is OAuth, and this is
//! DWEEB acting as the authorization server for exactly one resource — `/mcp`.
//!
//! **Discord remains the identity provider.** Nothing here authenticates a
//! person; the authorize endpoint hands the browser to Discord's own OAuth and
//! is called back with a Discord access token. That token is what every MCP
//! request ultimately acts with, which is what makes the whole authorization
//! model fall out for free: a caller can reach exactly the servers and channels
//! the *user* can, checked by the same `authorize_member_session` gate the web
//! app and the Activity already go through. There is no ambient bot authority
//! to leak.
//!
//! **The authorization request rides in `state`, sealed.** The browser doing
//! the Discord round trip belongs to the connector, so it carries none of our
//! cookies — the same problem the Activity's connect flow has, solved the same
//! way: the client id, redirect URI, PKCE challenge, and the client's own
//! `state` travel AES-GCM sealed inside the `state` parameter (its own AAD
//! domain, so it can never be replayed as another kind of sealed value) and are
//! authenticated by opening it on the way back.
//!
//! **PKCE is required, S256 only.** OAuth 2.1 drops the implicit flow and makes
//! PKCE mandatory even for confidential clients, and an MCP client registering
//! dynamically is public by nature — there is nowhere for it to keep a secret.
//! An authorization code intercepted in transit is useless without the verifier.
//!
//! Deliberately **no refresh tokens**: ours could not refresh Discord's, so once
//! the underlying token dies the honest answer is another authorization round
//! trip — which is silent when the user's Discord session is still good. See
//! `store.rs`.

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::{Form, Json};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::routes::AppState;
use crate::seal;
use crate::session::now;

use super::store::{CodeError, McpStore, TokenIdentity};

/// The single scope this resource defines. Named for what it lets a caller do,
/// because that string is what the user is shown when they authorize.
pub const SCOPE: &str = "dweeb:messages";

/// State prefix that routes the Discord callback back into this flow. Matches
/// the convention `auth.rs` already uses for its other flows.
pub const STATE_PREFIX: &str = "mcp_";

/// How long an authorization request may sit between leaving here and coming
/// back from Discord.
const STATE_TTL_SECS: i64 = 600;

/// The sealed payload carried through Discord's OAuth as `state`.
#[derive(Serialize, Deserialize)]
struct PendingAuthorization {
    client_id: String,
    redirect_uri: String,
    /// PKCE S256 challenge; verified at the token endpoint.
    challenge: String,
    /// The client's own `state`, returned untouched.
    client_state: Option<String>,
    exp: i64,
}

/* ── Discovery ───────────────────────────────────────────────────────── */

/// `GET /.well-known/oauth-protected-resource` (RFC 9728).
///
/// How a client that hit a 401 finds the authorization server. The 401 itself
/// points here via `WWW-Authenticate`, so a connector needs only the MCP URL to
/// bootstrap the whole flow.
pub async fn protected_resource(State(st): State<AppState>) -> Response {
    // Advertising an authorization server for a resource this deployment does
    // not serve would send a client through a whole OAuth flow to reach a 501.
    if st.mcp.is_none() {
        return not_enabled();
    }
    let base = public_base(&st);
    Json(json!({
        "resource": format!("{base}/mcp"),
        "authorization_servers": [base],
        "scopes_supported": [SCOPE],
        "bearer_methods_supported": ["header"],
        "resource_documentation": "https://dweeb.faizo.net/",
    }))
    .into_response()
}

/// `GET /.well-known/oauth-authorization-server` (RFC 8414).
pub async fn authorization_server(State(st): State<AppState>) -> Response {
    if st.mcp.is_none() {
        return not_enabled();
    }
    let base = public_base(&st);
    Json(json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/oauth/authorize"),
        "token_endpoint": format!("{base}/oauth/token"),
        "registration_endpoint": format!("{base}/oauth/register"),
        "scopes_supported": [SCOPE],
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        // S256 only. `plain` is permitted by RFC 7636 and forbidden by OAuth
        // 2.1 for good reason: it protects nothing against an attacker who can
        // read the authorization request.
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
        "service_documentation": "https://dweeb.faizo.net/",
    }))
    .into_response()
}

/* ── Dynamic client registration ─────────────────────────────────────── */

#[derive(Deserialize)]
pub struct RegisterRequest {
    #[serde(default)]
    redirect_uris: Vec<String>,
    #[serde(default)]
    client_name: Option<String>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
}

/// `POST /oauth/register` (RFC 7591).
///
/// Open registration, which is what makes a connector work without the user
/// copying credentials around — and is why the store caps the table and why a
/// registration grants nothing on its own: a client id is only useful once a
/// *user* completes an authorization with it.
pub async fn register(
    State(st): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<Response, AppError> {
    let store = require_store(&st)?;

    let uris: Vec<String> = body
        .redirect_uris
        .iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();
    if uris.is_empty() {
        return Ok(registration_error(
            "invalid_redirect_uri",
            "At least one redirect_uri is required.",
        ));
    }
    for uri in &uris {
        if !is_acceptable_redirect(uri) {
            return Ok(registration_error(
                "invalid_redirect_uri",
                "Redirect URIs must be absolute https:// URLs (or http://localhost for local development), with no fragment.",
            ));
        }
    }
    if uris.len() > 8 {
        return Ok(registration_error(
            "invalid_redirect_uri",
            "At most 8 redirect URIs.",
        ));
    }

    // A client asking for `none` is public and gets no secret — the normal case
    // for an MCP client, which has nowhere to keep one.
    let wants_secret = body
        .token_endpoint_auth_method
        .as_deref()
        .is_some_and(|m| m != "none");
    let secret = wants_secret.then(|| super::store::random_hex(32));

    let name = body
        .client_name
        .as_deref()
        .map(|n| n.chars().take(120).collect::<String>());
    let client = store
        .register_client(&uris, name.as_deref(), secret.as_deref())
        .map_err(|e| {
            // Registration failing is our problem, not the caller's.
            AppError::Internal(format!("could not register the client: {e}"))
        })?;

    tracing::info!(
        target: "mcp_oauth",
        client_id = %client.client_id,
        name = %name.as_deref().unwrap_or("(unnamed)"),
        "registered an MCP client"
    );

    let mut out = json!({
        "client_id": client.client_id,
        "redirect_uris": client.redirect_uris,
        "token_endpoint_auth_method": if secret.is_some() { "client_secret_post" } else { "none" },
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
        // No expiry: the registration stays valid until the store is swept.
        "client_id_issued_at": now(),
    });
    if let Some(secret) = secret {
        out["client_secret"] = json!(secret);
    }
    if let Some(name) = name {
        out["client_name"] = json!(name);
    }
    Ok((StatusCode::CREATED, Json(out)).into_response())
}

fn registration_error(code: &str, description: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": code, "error_description": description })),
    )
        .into_response()
}

/// A redirect target we are willing to send a user's authorization code to.
/// https only, except for loopback (which an MCP client running on the user's
/// own machine legitimately needs), and never with a fragment.
fn is_acceptable_redirect(raw: &str) -> bool {
    let Ok(parsed) = url::Url::parse(raw) else {
        return false;
    };
    if parsed.fragment().is_some() {
        return false;
    }
    match parsed.scheme() {
        "https" => true,
        "http" => matches!(
            parsed.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("::1")
        ),
        _ => false,
    }
}

/* ── Authorization ───────────────────────────────────────────────────── */

#[derive(Deserialize)]
pub struct AuthorizeQuery {
    #[serde(default)]
    response_type: String,
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    redirect_uri: String,
    #[serde(default)]
    code_challenge: String,
    #[serde(default)]
    code_challenge_method: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    scope: Option<String>,
}

/// `GET /oauth/authorize`.
///
/// Validates the request, then hands the browser to Discord. Note the ordering:
/// anything wrong with the **client or the redirect URI** is rendered as a page,
/// because redirecting an error to an unverified URI is how an open redirector
/// is built. Only once the redirect URI is known-registered do errors travel
/// back to the client the way OAuth expects.
pub async fn authorize(
    State(st): State<AppState>,
    Query(q): Query<AuthorizeQuery>,
) -> Result<Response, AppError> {
    let store = require_store(&st)?;

    let Some(client) = store.client(q.client_id.trim()) else {
        return Ok(error_page(
            "That app isn't registered",
            "The connector asked to authorize with a client id this server doesn't know. Removing and re-adding the connector will register it again.",
        ));
    };
    let redirect_uri = q.redirect_uri.trim().to_string();
    if !client.redirect_uris.iter().any(|u| u == &redirect_uri) {
        return Ok(error_page(
            "That redirect address isn't registered",
            "The connector asked to be sent back to an address it didn't register. Nothing was authorized.",
        ));
    }

    // From here the redirect URI is trusted, so failures go back to the client.
    if q.response_type.trim() != "code" {
        return Ok(redirect_error(
            &redirect_uri,
            "unsupported_response_type",
            "Only the authorization code flow is supported.",
            q.state.as_deref(),
        ));
    }
    if q.code_challenge_method.as_deref().unwrap_or("") != "S256" {
        return Ok(redirect_error(
            &redirect_uri,
            "invalid_request",
            "PKCE with code_challenge_method=S256 is required.",
            q.state.as_deref(),
        ));
    }
    let challenge = q.code_challenge.trim().to_string();
    if challenge.len() < 43 || challenge.len() > 128 {
        return Ok(redirect_error(
            &redirect_uri,
            "invalid_request",
            "code_challenge must be a base64url-encoded SHA-256 digest.",
            q.state.as_deref(),
        ));
    }

    let pending = PendingAuthorization {
        client_id: client.client_id.clone(),
        redirect_uri,
        challenge,
        client_state: q.state.clone(),
        exp: now() + STATE_TTL_SECS,
    };
    let payload = serde_json::to_string(&pending)
        .map_err(|e| AppError::Internal(format!("could not encode the request: {e}")))?;
    let sealed = seal::seal_mcp_state(&st.key, &payload)
        .ok_or_else(|| AppError::Internal("could not seal the request".into()))?;

    let cfg = &st.config;
    let url = format!(
        "https://discord.com/oauth2/authorize?client_id={}&response_type=code&redirect_uri={}&scope={}&state={}{}",
        cfg.client_id,
        urlencode(&cfg.oauth_redirect_url),
        urlencode("identify guilds"),
        format_args!("{STATE_PREFIX}{sealed}"),
        // The user must see what they are authorizing at least once; `consent`
        // is Discord's own screen naming DWEEB and the scopes. Repeat
        // connections after that are one click.
        "&prompt=consent",
    );
    Ok(Redirect::to(&url).into_response())
}

/// Finish the flow after Discord calls `/auth/callback` back with an `mcp_`
/// state. Called from `auth::callback`, which owns the code exchange.
///
/// Returns the redirect that hands the connector its authorization code.
pub async fn complete_authorization(st: &AppState, state: &str, discord_code: &str) -> Response {
    let Some(store) = st.mcp.as_ref() else {
        return error_page(
            "This server isn't accepting connections",
            "The MCP endpoint is disabled on this deployment.",
        );
    };
    let sealed = state.strip_prefix(STATE_PREFIX).unwrap_or_default();
    let Some(payload) = seal::open_mcp_state(&st.key, sealed) else {
        return error_page(
            "That authorization link has expired",
            "Start the connection again from your MCP client.",
        );
    };
    let Ok(pending) = serde_json::from_str::<PendingAuthorization>(&payload) else {
        return error_page(
            "That authorization link is unreadable",
            "Start the connection again from your MCP client.",
        );
    };
    if now() >= pending.exp {
        return error_page(
            "That authorization link has expired",
            "Start the connection again from your MCP client.",
        );
    }

    // Exchange Discord's code for the user token this grant will act with.
    let cfg = &st.config;
    let token = match st
        .discord
        .exchange_code(
            &cfg.client_id,
            &cfg.client_secret,
            discord_code,
            &cfg.oauth_redirect_url,
        )
        .await
    {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(target: "mcp_oauth", error = %e, "discord code exchange failed");
            return redirect_error(
                &pending.redirect_uri,
                "access_denied",
                "Discord did not complete the sign-in.",
                pending.client_state.as_deref(),
            );
        }
    };
    let user = match st.discord.current_user(&token.access_token).await {
        Ok(u) => u,
        Err(e) => {
            tracing::warn!(target: "mcp_oauth", error = %e, "could not read the Discord user");
            return redirect_error(
                &pending.redirect_uri,
                "access_denied",
                "Could not read your Discord account.",
                pending.client_state.as_deref(),
            );
        }
    };

    // Discord's `expires_in` is the ceiling on everything downstream.
    let discord_exp = now() + token.expires_in.max(0);
    let code = match store.create_code(
        &pending.client_id,
        &pending.redirect_uri,
        &pending.challenge,
        &token.access_token,
        &user.id,
        discord_exp,
    ) {
        Ok(code) => code,
        Err(e) => {
            tracing::error!(target: "mcp_oauth", error = %e, "could not store the authorization code");
            return redirect_error(
                &pending.redirect_uri,
                "server_error",
                "Could not complete the authorization.",
                pending.client_state.as_deref(),
            );
        }
    };

    tracing::info!(
        target: "mcp_oauth",
        client_id = %pending.client_id,
        user = %user.id,
        "authorized an MCP client"
    );

    let mut url = format!("{}?code={}", pending.redirect_uri, urlencode(&code));
    if let Some(client_state) = &pending.client_state {
        url.push_str(&format!("&state={}", urlencode(client_state)));
    }
    Redirect::to(&url).into_response()
}

/// The page a user lands on when they decline Discord's consent screen (or
/// Discord reports an error) part-way through connecting. Called from
/// `auth::callback`, which cannot know what a cancelled MCP flow should look
/// like. There is nothing to redirect to — the connector's redirect URI lives
/// inside the sealed state, which a cancel does not reliably echo back.
pub fn cancelled_page() -> Response {
    error_page(
        "Nothing was connected",
        "The authorization was cancelled. You can close this tab and try connecting again from your MCP client.",
    )
}

/* ── Token ───────────────────────────────────────────────────────────── */

#[derive(Deserialize)]
pub struct TokenRequest {
    #[serde(default)]
    grant_type: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    redirect_uri: String,
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    code_verifier: String,
}

/// `POST /oauth/token` — exchange an authorization code for an access token.
pub async fn token(
    State(st): State<AppState>,
    Form(body): Form<TokenRequest>,
) -> Result<Response, AppError> {
    let store = require_store(&st)?;

    if body.grant_type.trim() != "authorization_code" {
        return Ok(token_error(
            "unsupported_grant_type",
            "Only authorization_code is supported. This server issues no refresh tokens: an expired token means authorizing again.",
        ));
    }
    let client_id = body.client_id.trim();
    if !store.client_secret_matches(client_id, body.client_secret.as_deref()) {
        return Ok(token_error(
            "invalid_client",
            "The client could not be authenticated.",
        ));
    }

    let redeemed = match store.redeem_code(body.code.trim(), client_id, body.redirect_uri.trim()) {
        Ok(r) => r,
        Err(CodeError::Storage) => {
            return Err(AppError::Internal(
                "could not open a stored authorization code".into(),
            ))
        }
        Err(_) => {
            // Unknown / expired / wrong client / wrong redirect are one answer:
            // telling a caller *which* helps only someone probing.
            return Ok(token_error(
                "invalid_grant",
                "That authorization code is not valid.",
            ));
        }
    };

    // PKCE: the verifier must hash to the challenge recorded at authorize time.
    if !verify_pkce(&redeemed.code_challenge, body.code_verifier.trim()) {
        return Ok(token_error(
            "invalid_grant",
            "The PKCE code_verifier does not match.",
        ));
    }

    let (token, expires_at) = store
        .create_token(
            client_id,
            &redeemed.discord_token,
            &redeemed.discord_user,
            redeemed.discord_exp,
        )
        .map_err(|e| AppError::Internal(format!("could not issue a token: {e}")))?;

    Ok(Json(json!({
        "access_token": token,
        "token_type": "Bearer",
        "expires_in": (expires_at - now()).max(0),
        "scope": SCOPE,
    }))
    .into_response())
}

fn token_error(code: &str, description: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": code, "error_description": description })),
    )
        .into_response()
}

/// RFC 7636 S256: `BASE64URL(SHA256(verifier)) == challenge`.
fn verify_pkce(challenge: &str, verifier: &str) -> bool {
    // The verifier's length is specified, and checking it first keeps a trivial
    // input from being hashed at all.
    if !(43..=128).contains(&verifier.len()) {
        return false;
    }
    let digest = Sha256::digest(verifier.as_bytes());
    let computed = URL_SAFE_NO_PAD.encode(digest);
    computed.len() == challenge.len()
        && computed
            .bytes()
            .zip(challenge.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/* ── Bearer authentication ───────────────────────────────────────────── */

/// Resolve the bearer token on an MCP request.
///
/// A failure is a 401 carrying `WWW-Authenticate` with the protected-resource
/// metadata URL, which is the whole discovery bootstrap: a client that knows
/// only the MCP URL learns from this header where to authorize.
pub fn authenticate(st: &AppState, headers: &HeaderMap) -> Result<TokenIdentity, Box<Response>> {
    let store =
        match st.mcp.as_ref() {
            Some(store) => store,
            None => return Err(Box::new(
                (
                    StatusCode::NOT_IMPLEMENTED,
                    Json(json!({ "error": "The MCP endpoint is not enabled on this deployment." })),
                )
                    .into_response(),
            )),
        };
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty());

    let Some(token) = token else {
        return Err(Box::new(unauthorized(st, "Authorization required.")));
    };
    store
        .resolve_token(token)
        .ok_or_else(|| Box::new(unauthorized(st, "That access token is expired or unknown.")))
}

fn unauthorized(st: &AppState, message: &str) -> Response {
    let base = public_base(st);
    let challenge = format!(
        "Bearer realm=\"dweeb-mcp\", error=\"invalid_token\", resource_metadata=\"{base}/.well-known/oauth-protected-resource\""
    );
    let mut response =
        (StatusCode::UNAUTHORIZED, Json(json!({ "error": message }))).into_response();
    if let Ok(value) = header::HeaderValue::from_str(&challenge) {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    response
}

/* ── Shared ──────────────────────────────────────────────────────────── */

/// What every MCP surface answers when the feature is switched off. 501 rather
/// than 404: the route exists in this build, it is simply not enabled here, and
/// that is the more useful thing for an operator to see.
fn not_enabled() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "error": "The MCP endpoint is not enabled on this deployment." })),
    )
        .into_response()
}

fn require_store(st: &AppState) -> Result<&McpStore, AppError> {
    st.mcp.as_deref().ok_or_else(|| AppError::Status {
        status: StatusCode::NOT_IMPLEMENTED,
        message: "The MCP endpoint is not enabled on this deployment.".into(),
        retry_after: None,
    })
}

/// The public origin this server is reached at, which every metadata document
/// and the `WWW-Authenticate` header must agree on. Derived from the registered
/// OAuth redirect URL — the one value that is already, necessarily, the public
/// address of this service — unless overridden.
pub fn public_base(st: &AppState) -> String {
    if let Some(explicit) = &st.config.mcp_public_url {
        return explicit.clone();
    }
    url::Url::parse(&st.config.oauth_redirect_url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| (u.scheme().to_string(), h.to_string(), u.port()))
        })
        .map(|(scheme, host, port)| match port {
            Some(p) => format!("{scheme}://{host}:{p}"),
            None => format!("{scheme}://{host}"),
        })
        .unwrap_or_default()
}

fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A dead end the user sees in their browser, for the failures that must not be
/// redirected anywhere.
fn error_page(title: &str, detail: &str) -> Response {
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <style>body{{background:#1a1a1e;color:#dbdee1;font:16px/1.5 system-ui,sans-serif;\
         display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}}\
         main{{max-width:32rem;text-align:center}}h1{{font-size:1.25rem;margin:0 0 .5rem}}\
         p{{margin:0;color:#b5bac1}}</style>\
         <main><h1>{title}</h1><p>{detail}</p></main>"
    );
    (StatusCode::BAD_REQUEST, Html(html)).into_response()
}

/// An OAuth error handed back to the client at its (already validated) redirect
/// URI, per RFC 6749 §4.1.2.1.
fn redirect_error(
    redirect_uri: &str,
    code: &str,
    description: &str,
    client_state: Option<&str>,
) -> Response {
    let mut url = format!(
        "{redirect_uri}?error={}&error_description={}",
        urlencode(code),
        urlencode(description)
    );
    if let Some(state) = client_state {
        url.push_str(&format!("&state={}", urlencode(state)));
    }
    Redirect::to(&url).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_accepts_the_matching_verifier_and_nothing_else() {
        // RFC 7636 appendix B's worked example.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert!(verify_pkce(challenge, verifier));
        assert!(!verify_pkce(
            challenge,
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXx"
        ));
        assert!(!verify_pkce(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cX",
            verifier
        ));
    }

    #[test]
    fn pkce_refuses_a_verifier_outside_the_specified_length() {
        // Too short to carry the required entropy; RFC 7636 §4.1 sets 43..=128.
        assert!(!verify_pkce("anything", "short"));
        assert!(!verify_pkce("anything", &"a".repeat(129)));
    }

    #[test]
    fn only_https_and_loopback_may_receive_an_authorization_code() {
        assert!(is_acceptable_redirect(
            "https://claude.ai/api/mcp/auth_callback"
        ));
        assert!(is_acceptable_redirect(
            "http://localhost:6274/oauth/callback"
        ));
        assert!(is_acceptable_redirect("http://127.0.0.1:8080/cb"));
        // Plain http to anywhere else would put the code on the wire.
        assert!(!is_acceptable_redirect("http://example.test/cb"));
        // A fragment can't be delivered to a server and hides the real target.
        assert!(!is_acceptable_redirect("https://example.test/cb#frag"));
        assert!(!is_acceptable_redirect("javascript:alert(1)"));
        assert!(!is_acceptable_redirect("not a url"));
    }

    #[test]
    fn urlencode_escapes_everything_outside_the_unreserved_set() {
        assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(urlencode("identify guilds"), "identify%20guilds");
        assert_eq!(
            urlencode("https://api.example.com/auth/callback"),
            "https%3A%2F%2Fapi.example.com%2Fauth%2Fcallback"
        );
    }
}
