# dweeb-alerts — error-log → Discord alerting (prod VPS)

Canonical copies of the VPS-side log alerter. **Not deployed by CD** — installed by hand
on contabo (like `dweeb-maintenance.timer`). The webhook URL lives only in
`/opt/dweeb/.env` (`MONITORING_DISCORD_WEBHOOK`, shared with Gatus); nothing here is secret.

## Pieces

- `dweeb-log-alerts.py` → `/usr/local/sbin/dweeb-log-alerts.py`
  Tails `docker compose logs -f` for the app services (proxy, dispatcher, 7 plugins, caddy;
  gatus/dozzle/beszel excluded). Alerts on tracing `ERROR` lines, Rust panics, `web_crash`
  warns, and Caddy JSON error entries. Dedupes by normalized signature, batches into one
  embed per 45 s window, mutes a repeating signature for 15 min (then posts
  "still occurring ×N"), honors 429 Retry-After, drops on persistent failure (no queue).
  Exits 0 when monitored container ids change (deploys) so systemd reattaches it.
- `dweeb-alerts.service` → `/etc/systemd/system/` — Restart=always; if it crash-loops past
  the start limit, `OnFailure=` pings the webhook.
- `dweeb-failure-ping@.service` → `/etc/systemd/system/` + `dweeb-failure-ping.sh` →
  `/usr/local/sbin/` — template oneshot that posts "unit %i failed"; also wired to
  `dweeb-maintenance.service` via a drop-in
  (`/etc/systemd/system/dweeb-maintenance.service.d/onfailure.conf`).

## Deploy / update

```sh
scp server/ops/alerts/dweeb-log-alerts.py server/ops/alerts/dweeb-failure-ping.sh contabo:/usr/local/sbin/
scp server/ops/alerts/dweeb-alerts.service server/ops/alerts/dweeb-failure-ping@.service contabo:/etc/systemd/system/
ssh contabo "systemctl daemon-reload && systemctl restart dweeb-alerts.service"
```

Self-test (posts a ✅ message to the channel):

```sh
ssh contabo "set -a; . /opt/dweeb/.env; set +a; python3 /usr/local/sbin/dweeb-log-alerts.py --selftest"
```

Tuning env (optional, in `/opt/dweeb/.env`): `ALERTS_SERVICES`, `ALERTS_FLUSH_SECS`,
`ALERTS_MUTE_SECS`, `ALERTS_WEBHOOK` (override channel).
