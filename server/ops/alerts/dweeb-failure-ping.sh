#!/bin/sh
# Post "systemd unit $1 failed" to the monitoring Discord webhook.
# Invoked by dweeb-failure-ping@.service (OnFailure= of dweeb units).
set -eu
[ -n "${MONITORING_DISCORD_WEBHOOK:-}" ] || exit 0
UNIT="${1:-unknown}"
payload=$(printf '{"username":"DWEEB ops","embeds":[{"title":"systemd unit failed","description":"**%s** failed on contabo — check journalctl -u %s","color":15158332}]}' "$UNIT" "$UNIT")
curl -sS -m 10 -H "Content-Type: application/json" -d "$payload" "$MONITORING_DISCORD_WEBHOOK" > /dev/null
