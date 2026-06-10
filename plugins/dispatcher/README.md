# Interactions dispatcher

Not a plugin — the **front door for all of them**. A Discord application has
exactly **one** Interactions Endpoint URL, but every DWEEB plugin that puts
interactive components on a message receives its clicks through that URL. This
service is that endpoint: it verifies the signature, answers PINGs, and routes
everything else to the right plugin by `custom_id` prefix — the same
`customIdPrefix` every plugin manifest already declares.

```
Discord ──POST /──▶ dispatcher ── verifies Ed25519, answers PING
                                    │
                       custom_id "modalform:…" ──▶ http://modal-form:8090/interactions
                       custom_id "pingpong:…"  ──▶ http://ping-pong:8090/interactions
                       no match                ──▶ ephemeral "not wired" reply
```

The raw body and signature headers are forwarded untouched, so each plugin
re-verifies the exact bytes Discord signed — adding the dispatcher requires
**zero changes** to a plugin.

## Adding a plugin route

One entry in the `ROUTES` env var (see `server/compose.yml`):

```json
{ "modalform:": "http://modal-form:8090", "pingpong:": "http://ping-pong:8090" }
```

Longest prefix wins. Nothing else here changes; the public endpoint URL
(`https://interactions.dweeb.faizo.net`) is stable forever.

## Env

| Var | Meaning |
|---|---|
| `DISCORD_PUBLIC_KEY` | App public key (64 hex chars), verifies signatures. Required. |
| `ROUTES` | JSON map of `custom_id` prefix → upstream base URL. Required. |
| `PORT` | Bind port, default `8095`. |

## Latency

The forward hop runs over the compose network with a warm connection pool —
sub-millisecond. Upstream calls time out at 2.5s so the dispatcher can still
answer Discord inside its 3s window (an ephemeral error instead of
"This interaction failed").
