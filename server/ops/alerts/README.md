# dweeb-alerts — error-log → Discord alerting (prod VPS)

Canonical copies of the VPS-side log alerter. **Not deployed by CD** — installed by hand
on contabo (like `dweeb-maintenance.timer`). The webhook URL lives only in
`/opt/dweeb/.env` (`MONITORING_DISCORD_WEBHOOK`, shared with Gatus); nothing here is secret.

## Pieces

- `dweeb-log-alerts.py` → `/usr/local/sbin/dweeb-log-alerts.py`
  Tails `docker compose logs -f` for the app services (proxy, dispatcher, 9 plugins, caddy;
  gatus/dozzle/beszel excluded). Alerts on tracing `ERROR` lines, Rust panics, `web_crash`
  warns, and Caddy JSON error entries — **except** Caddy connection aborts (`broken pipe`,
  `connection reset by peer`, `context canceled`, `client disconnected`, and their HTTP/3
  spellings `Application error 0x100 (remote)` / `APPLICATION_ERROR (remote)`), which are
  network reality rather than a backend fault and must not page; see `CONN_ABORT_RE` for why
  an upstream actually going down still does. A tracing line is parsed *past* its request
  span (`ERROR http{method=… path=… error=…}: target: msg`) so the alert names the route and
  reason and a `web_crash` warn behind the span is still recognised — see the regex comments
  for the 2026-08-12 → 09-09 regression that motivated it. Dedupes by normalized signature,
  batches into one embed per 45 s window, mutes a repeating signature for 15 min (then posts
  "still occurring ×N"), honors 429 Retry-After, drops on persistent failure (no queue).
  Exits 0 when monitored container ids change (deploys) so systemd reattaches it.
  The HTTP/3 mute is duration-gated (`ALERTS_H3_ABANDON_MAX_SECS`, 15 s): a pure hang-up lasts
  ≈ Caddy's 2 s retry window, so a client that gave up on a request our upstream never answered
  still pages. A service's own `upstream failed` warns (a dependency — Discord — timing out or
  answering 5xx) never page alone, but `ALERTS_UPSTREAM_BURST_COUNT` (10) of them within
  `ALERTS_UPSTREAM_BURST_SECS` (300) post one `UPSTREAM STORM` alert, muted like any other.
  `--parse-test` runs the classifier, the reader path and the burst rule over a built-in corpus
  of real production lines, offline.
- `dweeb-alerts.service` → `/etc/systemd/system/` — Restart=always; if it crash-loops past
  the start limit, `OnFailure=` pings the webhook.
- `dweeb-failure-ping@.service` → `/etc/systemd/system/` + `dweeb-failure-ping.sh` →
  `/usr/local/sbin/` — template oneshot that posts "unit %i failed"; also wired to
  `dweeb-maintenance.service` via a drop-in
  (`/etc/systemd/system/dweeb-maintenance.service.d/onfailure.conf`).

## Deploy / update

```sh
ssh contabo "cp /usr/local/sbin/dweeb-log-alerts.py /usr/local/sbin/dweeb-log-alerts.py.bak-$(date +%Y%m%d)"
scp server/ops/alerts/dweeb-log-alerts.py server/ops/alerts/dweeb-failure-ping.sh contabo:/usr/local/sbin/
scp server/ops/alerts/dweeb-alerts.service server/ops/alerts/dweeb-failure-ping@.service contabo:/etc/systemd/system/
# Offline classifier check against real prod lines — must print N/N passed before the restart.
ssh contabo "python3 /usr/local/sbin/dweeb-log-alerts.py --parse-test"
ssh contabo "systemctl daemon-reload && systemctl restart dweeb-alerts.service && sleep 3 && systemctl is-active dweeb-alerts.service && journalctl -u dweeb-alerts -n 3 --no-pager"
```

Self-test (posts a ✅ message to the channel):

```sh
ssh contabo "set -a; . /opt/dweeb/.env; set +a; python3 /usr/local/sbin/dweeb-log-alerts.py --selftest"
```

Tuning env (optional, in `/opt/dweeb/.env`): `ALERTS_SERVICES`, `ALERTS_FLUSH_SECS`,
`ALERTS_MUTE_SECS`, `ALERTS_WEBHOOK` (override channel).
