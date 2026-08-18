#!/usr/bin/env bash
#
# End-to-end smoke test for the remote MCP endpoint.
#
# The unit suite covers the protocol dispatch, the validator, the tools, and the
# OAuth store as pure logic. What it cannot cover is the *wiring*: that the
# routes are mounted, that discovery answers with the right documents, that an
# unauthenticated call carries the header a client bootstraps from, and that the
# authorization endpoint refuses what it must. Those are exactly the mistakes
# that pass every test and then fail the first real connector.
#
# Constructing an `AppState` in a Rust test would need an eighty-field fixture
# and process-global environment mutation, which this codebase deliberately
# avoids (see the note on `parse_value` in config.rs). So this drives the real
# binary over real HTTP instead.
#
# Usage: server/ops/mcp-smoke.sh [path-to-binary]
#   Defaults to ./target/debug/dweeb-proxy, so `cargo build` first.
#
# Nothing here talks to Discord: the flow is exercised up to the point where the
# browser would be handed to Discord's OAuth, which is where this server's own
# logic ends.

set -euo pipefail

BIN="${1:-./target/debug/dweeb-proxy}"
PORT="${MCP_SMOKE_PORT:-8477}"
BASE="http://127.0.0.1:${PORT}"
# The last phase boots a second server with the feature switched off. It gets
# its own port: a just-killed process can hold the socket briefly after exit, and
# a failed bind there would leave the *first* (MCP-enabled) server answering the
# checks, which would pass them for entirely the wrong reason.
PORT_OFF=$((PORT + 1))
BASE_OFF="http://127.0.0.1:${PORT_OFF}"
WORK="$(mktemp -d)"
PUBLIC="https://api.example.test"

cleanup() {
  for pid in "${SERVER_PID:-}" "${SERVER_OFF_PID:-}"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- server log ---" >&2
  cat "$WORK/server.log" >&2 || true
  exit 1
}

pass() { echo "  ok — $*"; }

[[ -x "$BIN" ]] || fail "no binary at $BIN (run \`cargo build\` first)"

# Credentials are deliberately fake. Nothing in this script reaches Discord.
DISCORD_BOT_TOKEN=smoke-not-a-real-token \
DISCORD_CLIENT_ID=000000000000000000 \
DISCORD_CLIENT_SECRET=smoke-secret \
OAUTH_REDIRECT_URL="${PUBLIC}/auth/callback" \
FRONTEND_URL=https://dweeb.example.test \
SESSION_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
ALLOWED_ORIGINS=https://dweeb.example.test \
BIND_ADDR="127.0.0.1:${PORT}" \
MCP_ENABLED=true \
MCP_DB_PATH="$WORK/mcp.db" \
SHORTLINK_DB_PATH="$WORK/short.db" \
AI_DB_PATH="$WORK/ai.db" \
LIBRARY_ENABLED=false \
SCHEDULES_ENABLED=false \
ACTIVITIES_ENABLED=false \
AVATAR_UPLOADS_ENABLED=false \
RUST_LOG=warn \
  "$BIN" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "${BASE}/health" 2>/dev/null; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || fail "the server exited during boot"
  sleep 0.2
done
curl -fsS -o /dev/null "${BASE}/health" || fail "the server never became healthy"
echo "MCP smoke test against ${BASE}"

# ── Discovery ───────────────────────────────────────────────────────────────
# A client that knows only the /mcp URL has to be able to find everything else.

PR=$(curl -fsS "${BASE}/.well-known/oauth-protected-resource")
grep -q "\"resource\":\"${PUBLIC}/mcp\"" <<<"$PR" || fail "protected-resource names the wrong resource: $PR"
grep -q "\"authorization_servers\":\[\"${PUBLIC}\"\]" <<<"$PR" || fail "protected-resource names the wrong AS: $PR"
pass "protected-resource metadata"

AS=$(curl -fsS "${BASE}/.well-known/oauth-authorization-server")
grep -q "\"issuer\":\"${PUBLIC}\"" <<<"$AS" || fail "AS metadata has the wrong issuer: $AS"
grep -q '"code_challenge_methods_supported":\["S256"\]' <<<"$AS" || fail "AS metadata must require S256: $AS"
grep -q "\"registration_endpoint\":\"${PUBLIC}/oauth/register\"" <<<"$AS" || fail "AS metadata: no registration endpoint"
# `plain` PKCE is forbidden by OAuth 2.1 and protects nothing.
grep -q '"plain"' <<<"$AS" && fail "AS metadata offers plain PKCE"
pass "authorization-server metadata"

# ── The 401 that bootstraps discovery ───────────────────────────────────────

HEADERS=$(curl -sS -D - -o /dev/null -X POST "${BASE}/mcp" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}')
grep -qi '^HTTP/1.1 401' <<<"$HEADERS" || fail "an unauthenticated /mcp call must be 401"
grep -qi "resource_metadata=\"${PUBLIC}/.well-known/oauth-protected-resource\"" <<<"$HEADERS" \
  || fail "the 401 must point at the protected-resource document: $HEADERS"
pass "unauthenticated /mcp answers 401 with WWW-Authenticate"

STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/mcp" \
  -H 'Authorization: Bearer definitely-not-a-token' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}')
[[ "$STATUS" == "401" ]] || fail "an unknown bearer must be 401, got $STATUS"
pass "an unknown bearer is refused"

# GET and DELETE are honestly unsupported: this endpoint is stateless.
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/mcp")
[[ "$STATUS" == "405" ]] || fail "GET /mcp should be 405, got $STATUS"
pass "GET /mcp is 405 (no event stream, no session)"

# ── Dynamic client registration ─────────────────────────────────────────────

REG=$(curl -fsS -X POST "${BASE}/oauth/register" -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"client_name":"Smoke","token_endpoint_auth_method":"none"}')
CLIENT_ID=$(sed -n 's/.*"client_id":"\([^"]*\)".*/\1/p' <<<"$REG")
[[ -n "$CLIENT_ID" ]] || fail "registration returned no client_id: $REG"
# A public client must not be handed a secret it has nowhere to keep.
grep -q '"client_secret"' <<<"$REG" && fail "a public client was given a secret: $REG"
pass "dynamic client registration"

STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/oauth/register" \
  -H 'Content-Type: application/json' -d '{"redirect_uris":["http://evil.test/cb"]}')
[[ "$STATUS" == "400" ]] || fail "plain-http redirect URIs must be refused, got $STATUS"
pass "a non-https redirect URI is refused at registration"

# ── Authorization ───────────────────────────────────────────────────────────

CHALLENGE=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
REDIRECT=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback
LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' \
  "${BASE}/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=xyz")
grep -q '^https://discord.com/oauth2/authorize' <<<"$LOCATION" || fail "authorize should hand off to Discord: $LOCATION"
grep -q 'state=mcp_' <<<"$LOCATION" || fail "the Discord hand-off must carry the sealed MCP state: $LOCATION"
grep -q 'scope=identify%20guilds' <<<"$LOCATION" || fail "the hand-off must ask for identify+guilds: $LOCATION"
pass "authorize hands off to Discord with sealed state"

# An unregistered redirect URI must NOT be redirected to — that is how an open
# redirector gets built.
BODY=$(curl -sS -w '\n%{http_code} %{redirect_url}' \
  "${BASE}/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=https%3A%2F%2Fevil.test%2Fcb&code_challenge=${CHALLENGE}&code_challenge_method=S256")
grep -q '400 $' <<<"$BODY" || fail "an unregistered redirect_uri must render an error, not redirect: $BODY"
pass "an unregistered redirect_uri is refused without redirecting"

# Once the redirect URI is known-good, errors travel back to the client.
LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' \
  "${BASE}/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT}&state=xyz")
grep -q 'error=invalid_request' <<<"$LOCATION" || fail "a missing PKCE challenge must be refused: $LOCATION"
grep -q 'state=xyz' <<<"$LOCATION" || fail "the client's state must be returned with the error: $LOCATION"
pass "a request without PKCE is refused back to the client"

# ── Token ───────────────────────────────────────────────────────────────────

TOKEN_ERR=$(curl -sS -X POST "${BASE}/oauth/token" \
  -d "grant_type=authorization_code&code=nope&redirect_uri=https://claude.ai/api/mcp/auth_callback&client_id=${CLIENT_ID}&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
grep -q '"error":"invalid_grant"' <<<"$TOKEN_ERR" || fail "an unknown code must be invalid_grant: $TOKEN_ERR"
pass "an unknown authorization code is refused"

TOKEN_ERR=$(curl -sS -X POST "${BASE}/oauth/token" -d "grant_type=refresh_token&client_id=${CLIENT_ID}")
grep -q '"error":"unsupported_grant_type"' <<<"$TOKEN_ERR" || fail "refresh_token should be unsupported: $TOKEN_ERR"
pass "refresh tokens are honestly unsupported"

# ── Feature gate ────────────────────────────────────────────────────────────
# The endpoint is off by default; prove the switch actually gates it.

DISCORD_BOT_TOKEN=smoke-not-a-real-token \
DISCORD_CLIENT_ID=000000000000000000 \
DISCORD_CLIENT_SECRET=smoke-secret \
OAUTH_REDIRECT_URL="${PUBLIC}/auth/callback" \
FRONTEND_URL=https://dweeb.example.test \
SESSION_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
ALLOWED_ORIGINS=https://dweeb.example.test \
BIND_ADDR="127.0.0.1:${PORT_OFF}" \
SHORTLINK_DB_PATH="$WORK/short2.db" \
AI_DB_PATH="$WORK/ai2.db" \
LIBRARY_ENABLED=false SCHEDULES_ENABLED=false ACTIVITIES_ENABLED=false \
AVATAR_UPLOADS_ENABLED=false RUST_LOG=warn \
  "$BIN" > "$WORK/server-off.log" 2>&1 &
SERVER_OFF_PID=$!
for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null "${BASE_OFF}/health" 2>/dev/null; then break; fi
  kill -0 "$SERVER_OFF_PID" 2>/dev/null || fail "the MCP-disabled server exited during boot"
  sleep 0.2
done
curl -fsS -o /dev/null "${BASE_OFF}/health" || fail "the MCP-disabled server never became healthy"
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE_OFF}/oauth/register" \
  -H 'Content-Type: application/json' -d '{"redirect_uris":["https://claude.ai/cb"]}')
[[ "$STATUS" == "501" ]] || fail "with MCP_ENABLED off, registration should be 501, got $STATUS"
CAPS=$(curl -fsS "${BASE_OFF}/api/capabilities")
grep -q '"mcp":false' <<<"$CAPS" || fail "capabilities should report mcp:false when off: $CAPS"
pass "MCP_ENABLED=false leaves the endpoint switched off"

echo "MCP smoke test passed."
