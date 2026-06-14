# Monitoring

A lightweight, self-hosted monitoring stack for the production host, shipped as
part of `compose.yml`. Three pillars, ~65 MB RAM total:

| Tool       | Covers                                   | URL                              | Auth                |
| ---------- | ---------------------------------------- | -------------------------------- | ------------------- |
| **Beszel** | host + per-container CPU/mem/disk/net     | `https://beszel.$PLUGINS_DOMAIN` | its own login       |
| **Gatus**  | uptime of the public endpoints + alerts   | `https://status.$PLUGINS_DOMAIN` | public status page  |
| **Dozzle** | live container logs                       | localhost only (SSH tunnel)      | not exposed         |

Everything reaches Discord for alerts. It's all optional — leave the `.env`
values blank and the core stack runs unchanged; the monitoring containers just
idle. Nothing here can take the proxy/dispatcher down (Caddy only gains plain
`reverse_proxy` blocks, and Dozzle never touches the edge).

## Deploy

The monitoring services live in the same `compose.yml`, so they roll out with
the normal flow. On the host (`/opt/dweeb`), once the new `compose.yml`,
`Caddyfile`, and `gatus/` are in place:

```bash
docker compose pull          # grabs beszel / gatus / dozzle images
docker compose up -d         # starts them; Caddy issues the two new certs
```

Caddy gets `beszel.$PLUGINS_DOMAIN` and `status.$PLUGINS_DOMAIN` certs
automatically — the `*.$PLUGINS_DOMAIN` wildcard DNS already covers them, so
there is **no DNS work**. The stack comes up healthy even before the steps
below; you just won't have Beszel metrics or Discord alerts until you finish.

## 1. Discord alerts (Gatus) — 1 min

1. Discord → **Server Settings → Integrations → Webhooks → New Webhook**, pick a
   channel, **Copy Webhook URL**.
2. Put it in `/opt/dweeb/.env`:
   ```
   MONITORING_DISCORD_WEBHOOK=https://discord.com/api/webhooks/XXXX/YYYY
   ```
3. `docker compose up -d gatus`

Gatus now posts to that channel after 3 consecutive failures of any endpoint
(and again on recovery). Tune thresholds/endpoints in
[`gatus/config.yaml`](gatus/config.yaml).

## 2. Beszel agent ↔ hub — 3 min

The agent needs two values that the hub only generates on first run, so this is
a one-time copy-paste:

1. Open `https://beszel.$PLUGINS_DOMAIN` and **create the admin user**.
2. Click **Add System** → choose **Docker**. The dialog shows a public **KEY**
   (`ssh-ed25519 …`) and a **TOKEN**. (The token also lives under
   **Settings → Tokens** as a reusable universal token.)
3. Paste both into `/opt/dweeb/.env`:
   ```
   BESZEL_KEY=ssh-ed25519 AAAA...
   BESZEL_TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```
4. `docker compose up -d beszel-agent`

Within ~15s the system appears in the hub with live CPU/mem/disk/network plus a
row per running container.

### Beszel → Discord alerts

Beszel sends its own alerts (e.g. CPU > 80% for 10 min, low disk, a container
going down) via [shoutrrr](https://containrrr.dev/shoutrrr/):

1. Beszel → **Settings → Notifications → Add**.
2. Use a Discord shoutrrr URL built from the same webhook
   `https://discord.com/api/webhooks/<ID>/<TOKEN>`:
   ```
   discord://<TOKEN>@<ID>
   ```
3. Then set per-metric alert rules on each system (the bell icon).

## 3. Logs (Dozzle) — via SSH tunnel

Dozzle is bound to `127.0.0.1:8081` on the host on purpose — raw container logs
should not be public. Reach it from your laptop with a tunnel:

```bash
ssh -L 8080:localhost:8081 contabo    # leave running
# then open http://localhost:8080
```

Live, searchable, multi-container logs with no extra exposure. (If you'd rather
have it on a subdomain, add a Caddy block with `basic_auth` and publish a real
port — but keep it behind auth.)

## Off-host dead-man's switch (recommended)

Gatus and Beszel run **on** the VPS, so if the whole box (or its network) drops,
they go silent instead of alerting. Close that gap with one free external
pinger — e.g. [UptimeRobot](https://uptimerobot.com) or
[Better Stack](https://betterstack.com) — checking
`https://interactions.$PLUGINS_DOMAIN/health` every minute with alerts to the
same Discord channel. That's the one piece worth having off-host.

## Footprint & security notes

- **RAM:** Beszel hub ~30 MB, agent ~15 MB, Gatus ~15 MB, Dozzle ~10 MB.
- **Docker socket** is mounted **read-only** into the Beszel agent and Dozzle
  (they only read container state/logs). That access is still powerful — it's
  why Dozzle is not exposed publicly.
- **Beszel hub** is published only on `127.0.0.1:8090` (for the agent); the
  public entrypoint is Caddy + the hub's own login.
- Updates ride the normal `docker compose pull && up -d`, so the monitoring
  images stay current with every deploy.
