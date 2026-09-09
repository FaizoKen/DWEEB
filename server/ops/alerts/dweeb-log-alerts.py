#!/usr/bin/env python3
"""DWEEB error-log -> Discord webhook alerter.

Tails `docker compose logs -f` for the app services on the prod VPS and posts
batched, deduplicated error alerts to the Discord webhook in
MONITORING_DISCORD_WEBHOOK (same channel Gatus uses for up/down alerts).

Design constraints (do not regress):
- Stdlib only; runs under the system python3 as a systemd service.
- Never alerts on its own output: this process writes only to its own journal
  stream, which is not a monitored container, so a reporting failure cannot
  feed back into the pipeline.
- Discord-friendly: one post per flush window at most, per-signature mute so a
  crash loop becomes "still occurring xN" instead of a message per minute, and
  429 Retry-After is honored with a single bounded retry (drop, never queue).
- `docker compose logs -f` does not reliably attach to containers recreated by
  a deploy, so a watchdog compares container ids and exits 0 when they change;
  systemd (Restart=always) reattaches us to the fresh containers.
"""

from __future__ import annotations

import collections
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

COMPOSE_DIR = os.environ.get("ALERTS_COMPOSE_DIR", "/opt/dweeb")
WEBHOOK = (
    os.environ.get("ALERTS_WEBHOOK") or os.environ.get("MONITORING_DISCORD_WEBHOOK") or ""
).strip()
# Gatus watches uptime; we watch app-level errors. Third-party dashboards
# (dozzle, beszel, gatus itself) are excluded: their errors are not actionable.
SERVICES = os.environ.get(
    "ALERTS_SERVICES",
    "proxy,dispatcher,ping-pong,tickets,giveaway,quick-replies,self-role,modal-form,picker,"
    "poll,directory,caddy",
).split(",")

FLUSH_SECS = int(os.environ.get("ALERTS_FLUSH_SECS", "45"))
MUTE_SECS = int(os.environ.get("ALERTS_MUTE_SECS", "900"))
# A dependency's failure (Discord timing out or answering 5xx) is logged at WARN
# by the service and never pages by itself. This many of them from one service
# within this window is a sustained outage — Discord's, or of this host's path
# to it — and pages once (see Collector.note_upstream).
UPSTREAM_BURST_COUNT = int(os.environ.get("ALERTS_UPSTREAM_BURST_COUNT", "10"))
UPSTREAM_BURST_SECS = int(os.environ.get("ALERTS_UPSTREAM_BURST_SECS", "300"))
# The one classification that is not an alert: the reader routes it to the
# burst detector instead of the queue.
UPSTREAM = "UPSTREAM"
MAX_LINES_PER_POST = 8
SAMPLE_MAX = 280
WATCHDOG_SECS = 120

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
# `compose logs` prefixes each line with the container name column.
PREFIX_RE = re.compile(r"^(?P<name>\S+)\s+\|\s?(?P<rest>.*)$")

# A tracing_subscriber fmt line is
#   <ts>Z <LEVEL> [<span>{fields}: ]... <target>: <message>
# The span prefix is easy to miss, and missing it was expensive. The proxy's
# request span (added 2026-08-12) renders as `http{method=.. path=.. error=..}:`
# BEFORE the real target, so a parser that assumed `<level> <target>{span}: msg`
# read the target as `http` and discarded the fields. Two things broke silently:
#   • proxy 502 pages named no route and no reason — exactly the fields that span
#     was added to carry — so every one was an un-triageable `latency=… ms`;
#   • `web_crash` warns (whose real target sits AFTER the span) stopped being
#     recognised, so FE crash beacons quietly stopped paging altogether.
# So parse in three parts: the head (ts + level), then zero or more leading span
# segments (keep their fields — path=/error= are what make a 502 actionable),
# then the true target that follows them.
TRACING_HEAD_RE = re.compile(r"^\S+Z\s+(?P<level>ERROR|WARN)\s+(?P<rest>.*)$")
# One leading span segment: `name{fields}: `. `[^{}]*` deliberately refuses a
# field value that itself contains a brace — such a line just isn't stripped and
# its remainder becomes the message, which STILL alerts (far better than dropping
# a real ERROR on a parse miss). In practice our error values never contain
# braces: Discord's `.message` string is extracted, never its raw JSON body.
SPAN_SEG_RE = re.compile(r"^(?P<name>[\w:.\-]+)\{(?P<fields>[^{}]*)\}:\s*")
TARGET_RE = re.compile(r"^(?P<target>[\w:.\-]+):\s?(?P<msg>.*)$", re.DOTALL)
PANIC_RE = re.compile(r"panicked at|thread '.*' panicked", re.IGNORECASE)

# Caddy logs a connection that ended early at ERROR — and ERROR is the paging
# channel. These are network reality, not a backend fault, so they are dropped:
# a client hangs up mid-upload, or an upstream answers 4xx and closes without
# draining the request body, at which point Caddy — still copying that body —
# reports `write: broken pipe`, discards the real status and synthesises a 502.
# That is what a passing vulnerability scanner's `POST /lib/vendor/phpunit/…`
# did on 2026-07-21. Every service now drains the body on an unroutable path
# (see each router's `not_found`), but the residue is legitimate and stays:
# a 413 on an oversized upload, a 429 under abuse, a browser closing a tab.
#
# An upstream genuinely going down does NOT hide behind this. It announces
# itself three other ways that all still page: a Rust panic / tracing ERROR in
# the service's own logs, Caddy's `dial tcp … connection refused` and DNS
# failures (no connection-abort wording, so they pass the filter below), and
# Gatus's /ready check.
CONN_ABORT_RE = re.compile(
    r"broken pipe|connection reset by peer|context canceled|client disconnected",
    re.IGNORECASE,
)

# Over HTTP/3 the same "client hung up" event wears a different name, and gets a
# guard of its own. When a browser closes its QUIC *connection* mid-request —
# navigated away, closed the tab, a flaky mobile / 0-RTT connection dropped —
# quic-go cancels the connection context with the peer's close as the context
# *cause*, the request context inherits it, and Go's net/http (1.23+) returns it
# bare from RoundTrip: `Application error 0x100 (remote)` (0x100 = HTTP/3's
# H3_NO_ERROR, "closed, nothing wrong") or, when the close arrived before the
# handshake completed (RFC 9000 §10.2.3 discards the application code),
# `APPLICATION_ERROR (remote)` — so that second spelling also covers an early
# close with any code, and nothing in it can tell them apart. Caddy (v2.11.4 on
# quic-go v0.59.1 and Go 1.25 — the behaviour is a property of that stack, and
# quic-go ≥0.60 turns it into a scheduling race) recognises a cancel only as
# context.Canceled / "operation was canceled", so it treats this as an upstream
# failure: it re-tries the GET (its default for non-dial errors) against nothing
# for the whole `lb_try_duration`, then logs a synthesised 502 at ERROR — eleven
# pages 2026-08-20 → 09-03, all HTTP/3.0 GETs of ordinary app routes, all
# ~2.0 s, all `(remote)`. A per-stream cancel (STOP_SENDING) is a plain cancel
# and was always silent, so these two spellings are the complete set. The
# `(remote)` anchor is load-bearing: Caddy is never a QUIC client here, so
# `(remote)` can only be the browser, and a `(local)` application error is OUR
# side aborting, and still pages.
#
# The duration gate is what keeps this from hiding a stalled backend: a pure
# hang-up's fingerprint is `duration` ≈ the 2 s retry window (a close inside it
# burns the window; a close after it ends the request at once), so a client
# that gave up on a request our upstream had left unanswered for far longer is
# NOT muted — it pages, with the method, the path, and the duration in the
# sample. The bound covers the retry window plus the longest Discord-bounded
# read the proxy will wait on (a 10 s deadline after a ≤4 s rate-limit wait).
H3_CLIENT_CLOSE_RE = re.compile(
    r"application error 0x100 \(remote\)|application_error \(remote\)", re.IGNORECASE
)
H3_ABANDON_MAX_SECS = float(os.environ.get("ALERTS_H3_ABANDON_MAX_SECS", "15"))

# Normalization for dedup signatures: volatile tokens -> placeholders.
NORM_PATTERNS = [
    (re.compile(r"\b[0-9a-f]{8,}\b", re.IGNORECASE), "<hex>"),
    (re.compile(r"\b\d{6,}\b"), "<id>"),
    (re.compile(r"\b\d+(\.\d+)?(ms|s)\b"), "<dur>"),
    (re.compile(r"\b\d+\b"), "<n>"),
    (re.compile(r"https?://\S+"), "<url>"),
]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def normalize(msg: str) -> str:
    out = msg
    for pat, repl in NORM_PATTERNS:
        out = pat.sub(repl, out)
    return out[:400]


def service_of(container_name: str) -> str:
    # `dweeb-proxy-1` / `proxy-1` -> `proxy`
    name = re.sub(r"-\d+$", "", container_name)
    for svc in SERVICES:
        if name == svc or name.endswith("-" + svc):
            return svc
    return ""


def classify(rest: str) -> tuple[str, str] | None:
    """Return (label, message) when the line should alert, else None.

    One label is special: `UPSTREAM` is a dependency's failure the service
    itself logged at WARN. It never pages on its own — the reader hands it to
    `Collector.note_upstream`, which pages once when they come in a burst.
    """
    if PANIC_RE.search(rest):
        return ("PANIC", rest.strip())
    head = TRACING_HEAD_RE.match(rest)
    if head:
        level, body = head.group("level"), head.group("rest")
        # Peel off leading span segments, keeping their fields: `path=…` and
        # `error=…` are what turn a bare 502 into a five-second triage.
        span_fields: list[str] = []
        while True:
            seg = SPAN_SEG_RE.match(body)
            if not seg:
                break
            if seg.group("fields"):
                span_fields.append(seg.group("fields"))
            body = body[seg.end() :]
        tm = TARGET_RE.match(body)
        target, msg = (tm.group("target"), tm.group("msg")) if tm else ("", body)
        if level == "ERROR":
            # Fields first: they survive the SAMPLE_MAX clamp, and the trailing
            # `classification=… latency=…` is the most expendable part.
            detail = "  ".join(span_fields + [msg]) if span_fields else msg
            return ("ERROR " + target if target else "ERROR", detail)
        if level == "WARN":
            if target.startswith("web_crash"):
                return ("WEB CRASH", msg)
            # A span with no fields renders as a bare `name:` (tracing omits the
            # braces), indistinguishable from a target, so the real target lands
            # at the head of `msg`. Nothing emits such a span today —
            # `request_span` always carries method+path — this keeps a future
            # one from silently swallowing crash beacons again.
            if msg.startswith("web_crash:"):
                return ("WEB CRASH", msg[len("web_crash:") :].strip())
            # A dependency's failure, logged by the service at WARN under target
            # `upstream` (the proxy's trace.rs and each plugin's). Never a page
            # on its own; the reader feeds it to the burst detector.
            if target == "upstream":
                return (UPSTREAM, msg)
        return None
    # Caddy logs JSON (zap): alert on error-level entries only, minus the
    # connection aborts that are not ours to fix (see CONN_ABORT_RE).
    if rest.startswith("{") and '"level":"error"' in rest:
        entry: dict = {}
        try:
            entry = json.loads(rest)
            msg, logger = str(entry.get("msg", "")), str(entry.get("logger", "caddy"))
        except ValueError:
            # Unparseable: fall back to matching the raw line, so a mangled
            # entry carrying abort wording is still filtered rather than paged.
            msg, logger = rest.strip(), "caddy"
        if CONN_ABORT_RE.search(msg):
            return None
        if H3_CLIENT_CLOSE_RE.search(msg):
            duration = entry.get("duration")
            if not isinstance(duration, (int, float)) or duration <= H3_ABANDON_MAX_SECS:
                return None
            req = entry.get("request") or {}
            # The path only: Caddy logs the full URI, and a query can carry a
            # live OAuth code (`/auth/callback?code=…`).
            path = str(req.get("uri", "")).split("?", 1)[0]
            return (
                "ERROR " + logger,
                f"{req.get('method', '?')} {path} — an HTTP/3 client hung up after "
                f"{duration:.1f}s with the request still unanswered upstream ({msg[:80]})",
            )
        return ("ERROR " + logger, msg[:200])
    return None


class Poster:
    """Serialized webhook posting with 429 handling."""

    def post(self, description: str) -> None:
        payload = json.dumps(
            {
                "username": "DWEEB logs",
                "embeds": [
                    {
                        "title": "\U0001f6a8 Backend errors",
                        "description": description[:4000],
                        "color": 0xE53935,
                        "footer": {"text": "dweeb-alerts · contabo"},
                    }
                ],
            }
        ).encode()
        for attempt in (1, 2):
            req = urllib.request.Request(
                WEBHOOK,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    # Cloudflare 403s Discord webhook posts with the default
                    # Python-urllib user agent; anything descriptive passes.
                    "User-Agent": "dweeb-alerts/1.0 (+https://github.com/FaizoKen/DWEEB)",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=10):
                    log(f"posted alert ({len(description)} chars)")
                    return
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt == 1:
                    try:
                        retry = float(json.loads(e.read()).get("retry_after", 5))
                    except Exception:
                        retry = 5.0
                    time.sleep(min(retry, 30.0))
                    continue
                log(f"webhook post failed: HTTP {e.code}")
                return
            except Exception as e:  # network errors: drop, never queue
                log(f"webhook post failed: {e}")
                return


class Collector:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        # sig -> {label, svc, sample, count}
        self.pending: dict[str, dict] = {}
        self.first_pending_ts = 0.0
        self.last_posted: dict[str, float] = {}  # sig -> ts of last post
        self.muted_counts: dict[str, dict] = {}  # sig -> {count, label, svc, sample}
        self.upstream_hits: dict[str, collections.deque] = {}  # svc -> warn timestamps

    def add(
        self,
        svc: str,
        label: str,
        msg: str,
        now: float | None = None,
        key: str | None = None,
    ) -> None:
        """Queue one alert. `key` (default: the message) is what the dedup/mute
        signature is built from; a storm passes a constant so it mutes as one."""
        sig = f"{svc}|{label}|{normalize(msg if key is None else key)}"
        with self.lock:
            now = time.time() if now is None else now
            if now - self.last_posted.get(sig, 0.0) < MUTE_SECS:
                rec = self.muted_counts.setdefault(
                    sig, {"count": 0, "label": label, "svc": svc, "sample": msg}
                )
                rec["count"] += 1
                return
            if not self.pending:
                self.first_pending_ts = now
            rec = self.pending.setdefault(
                sig, {"label": label, "svc": svc, "sample": msg, "count": 0}
            )
            rec["count"] += 1

    def note_upstream(self, svc: str, msg: str, now: float | None = None) -> bool:
        """A dependency's failure the service logged at WARN — never a page on
        its own. Enough of them in a short window is a sustained outage
        (Discord's, or of this host's path to it), which IS worth one page: the
        burst becomes an ordinary alert whose signature then mutes for
        MUTE_SECS like any other, so a long outage reads as one page plus
        "still occurring ×N", never a storm of its own. True when one fired."""
        now = time.time() if now is None else now
        with self.lock:
            hits = self.upstream_hits.setdefault(svc, collections.deque())
            hits.append(now)
            while hits and now - hits[0] > UPSTREAM_BURST_SECS:
                hits.popleft()
            if len(hits) < UPSTREAM_BURST_COUNT:
                return False
            hits.clear()
        self.add(
            svc,
            "UPSTREAM STORM",
            f"{UPSTREAM_BURST_COUNT}+ upstream failures within {UPSTREAM_BURST_SECS}s"
            f" — last: {msg}",
            now=now,
            key="",
        )
        return True

    def flush_due(self, now: float | None = None) -> str | None:
        """Build the next post body, or None if nothing is due yet."""
        with self.lock:
            now = time.time() if now is None else now
            # Un-mute expired signatures that kept firing while muted.
            expired = [s for s, ts in self.last_posted.items() if now - ts >= MUTE_SECS]
            resurfaced = []
            for sig in expired:
                rec = self.muted_counts.pop(sig, None)
                del self.last_posted[sig]
                if rec and rec["count"] > 0:
                    resurfaced.append((sig, rec, True))
            fresh_due = self.pending and now - self.first_pending_ts >= FLUSH_SECS
            if not fresh_due and not resurfaced:
                return None
            items = []
            if fresh_due:
                items += [(sig, rec, False) for sig, rec in self.pending.items()]
                self.pending = {}
            items += resurfaced
            for sig, _rec, _ in items:
                self.last_posted[sig] = now
            lines = []
            for _sig, rec, was_muted in items[:MAX_LINES_PER_POST]:
                sample = ANSI_RE.sub("", rec["sample"]).strip()[:SAMPLE_MAX]
                count = f" ×{rec['count']}" if rec["count"] > 1 else ""
                still = " (still occurring)" if was_muted else ""
                lines.append(f"**{rec['svc']}** — {rec['label']}{count}{still}\n`{sample}`")
            if len(items) > MAX_LINES_PER_POST:
                lines.append(f"… +{len(items) - MAX_LINES_PER_POST} more distinct errors")
            return "\n\n".join(lines)


def route_line(raw: str) -> tuple[str, tuple[str, str]] | None:
    """One raw `compose logs` line → (service, classification), or None. The
    reader's whole per-line path, kept separate so the offline test can drive
    it with a line exactly as compose emits it (ANSI colour and all)."""
    line = ANSI_RE.sub("", raw.rstrip("\n"))
    m = PREFIX_RE.match(line)
    if not m:
        return None
    svc = service_of(m.group("name"))
    if not svc:
        return None
    hit = classify(m.group("rest"))
    return (svc, hit) if hit else None


def reader(proc: subprocess.Popen, collector: Collector) -> None:
    assert proc.stdout is not None
    for raw in proc.stdout:
        routed = route_line(raw)
        if not routed:
            continue
        svc, (label, msg) = routed
        if label == UPSTREAM:
            collector.note_upstream(svc, msg)
        else:
            collector.add(svc, label, msg)


def container_ids() -> str:
    try:
        out = subprocess.run(
            ["docker", "compose", "--project-directory", COMPOSE_DIR, "ps", "-q"] + SERVICES,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return out.stdout
    except Exception:
        return ""


# Offline check of the classifier against lines lifted from the production logs
# (`--parse-test`, no network, no webhook needed). Run it on the host before
# restarting the service. Each entry: (line as `compose logs` hands it to
# `classify` — i.e. after the container-name prefix — expected label or None
# for "must not page", and substrings the alert body must carry).
PARSE_CASES: list[tuple[str, str | None, tuple[str, ...]]] = [
    # Proxy 5xx inside the request span: the page must name route + reason.
    (
        "2026-09-02T05:23:00.000000Z ERROR http{method=GET path=/api/guilds/815923207122452490/webhooks "
        "error=couldn't reach the dispatcher: error sending request: tcp connect error}: "
        "tower_http::trace::on_failure: response failed classification=Status code: 502 Bad Gateway "
        "latency=10002 ms",
        "ERROR tower_http::trace::on_failure",
        ("path=/api/guilds/815923207122452490/webhooks", "error=couldn't reach the dispatcher", "502"),
    ),
    # A dependency's failure the proxy now logs at WARN (trace.rs): not a page —
    # the burst detector's input.
    (
        "2026-09-02T05:23:00.000000Z  WARN http{method=GET path=/api/guilds/1/webhooks "
        "error=could not reach Discord: error sending request: operation timed out}: upstream: "
        "upstream failed classification=Status code: 502 Bad Gateway latency=10002 ms",
        UPSTREAM,
        ("upstream failed",),
    ),
    # …and a plugin's (no request span; a 504 is its Discord-timeout verdict).
    (
        "2026-09-02T05:23:00.000000Z  WARN upstream: upstream failed "
        "classification=Status code: 504 Gateway Timeout latency=2277 ms",
        UPSTREAM,
        ("504",),
    ),
    # Historical plugin 5xx shape (the 2026-08-20 self-role page); a plugin's
    # 500/502 still emits exactly this and must still page.
    (
        "2026-08-20T05:36:15.256921Z ERROR tower_http::trace::on_failure: response failed "
        "classification=Status code: 502 Bad Gateway latency=2277 ms",
        "ERROR tower_http::trace::on_failure",
        ("latency=2277 ms",),
    ),
    # Nested spans peel in order; the target is still found behind them.
    (
        "2026-09-02T05:23:00.000000Z  WARN http{method=POST path=/api/telemetry/crash}:inner{k=v}: "
        "web_crash: web app crash kind=boundary",
        "WEB CRASH",
        ("kind=boundary",),
    ),
    # A fieldless span renders as a bare `name:` — the target then heads `msg`.
    ("2026-09-02T05:23:00.000000Z  WARN http: web_crash: web app crash kind=error", "WEB CRASH", ("kind=error",)),
    # A service's own ERROR inside the span keeps its real target.
    (
        "2026-09-02T05:23:00.000000Z ERROR http{method=POST path=/api/x}: dweeb_proxy::routes: it broke",
        "ERROR dweeb_proxy::routes",
        ("path=/api/x", "it broke"),
    ),
    # FE crash beacon behind the request span — the shape that silently stopped
    # paging on 2026-08-12.
    (
        "2026-09-02T05:23:00.000000Z  WARN http{method=POST path=/api/telemetry/crash}: web_crash: "
        "web app crash kind=boundary message=x",
        "WEB CRASH",
        ("kind=boundary",),
    ),
    # …and the pre-span shape SW-stale clients never sent through (still valid).
    ("2026-07-12T00:00:00.000000Z  WARN web_crash: web app crash kind=error", "WEB CRASH", ("kind=error",)),
    # Demoted crash shapes are INFO and must stay silent.
    ("2026-09-02T05:23:00.000000Z  INFO http{method=POST path=/api/telemetry/crash}: web_crash: foreign", None, ()),
    # Any other WARN is not an alert.
    ("2026-09-02T05:23:00.000000Z  WARN http{method=GET path=/api/guilds}: dweeb_proxy::discord: rate limited", None, ()),
    # Panics page whatever else the line says.
    ("thread 'main' panicked at src/main.rs:1:1: boom", "PANIC", ("boom",)),
    # Caddy: the HTTP/3 client hang-ups that paged eleven times (2026-08-20 → 09-03):
    # a ~2 s duration is the retry-window fingerprint of a pure hang-up.
    (
        '{"level":"error","ts":1788212990.16,"logger":"http.log.error","msg":"Application error 0x100 (remote)",'
        '"request":{"proto":"HTTP/3.0","method":"GET","uri":"/api/capabilities"},"duration":2.018978892,"status":502}',
        None,
        (),
    ),
    (
        '{"level":"error","ts":1787235882.65,"logger":"http.log.error","msg":"APPLICATION_ERROR (remote)",'
        '"request":{"proto":"HTTP/3.0","method":"GET","uri":"/api/guilds/1/permanent"},"duration":2.063243052,"status":502}',
        None,
        (),
    ),
    # …but the same spelling after a long wait means our upstream never answered:
    # that pages, naming method + path (never the query) and the duration.
    (
        '{"level":"error","logger":"http.log.error","msg":"Application error 0x100 (remote)",'
        '"request":{"proto":"HTTP/3.0","method":"GET","uri":"/auth/callback?code=live-oauth-code"},'
        '"duration":31.2,"status":502}',
        "ERROR http.log.error",
        ("GET /auth/callback", "31.2s", "hung up"),
    ),
    # Caddy: HTTP/1.1 client hang-up (scanner POSTs), already muted.
    (
        '{"level":"error","logger":"http.log.error","msg":"readfrom tcp 172.18.0.14:49552->172.18.0.15:8080: '
        'write tcp 172.18.0.14:49552->172.18.0.15:8080: write: broken pipe","status":502}',
        None,
        (),
    ),
    # Caddy: OUR side aborting a QUIC stream is not a client hang-up — still pages.
    ('{"level":"error","logger":"http.log.error","msg":"Application error 0x100 (local)","status":502}',
     "ERROR http.log.error", ("0x100 (local)",)),
    # Caddy: a dead or unresolvable upstream must keep paging.
    ('{"level":"error","logger":"http.log.error","msg":"dial tcp 172.18.0.15:8080: connect: connection refused"}',
     "ERROR http.log.error", ("connection refused",)),
    ('{"level":"error","logger":"http.log.error","msg":"dial tcp: lookup proxy on 127.0.0.11:53: server misbehaving"}',
     "ERROR http.log.error", ("server misbehaving",)),
    # Caddy: a plain upstream timeout is not abort wording either.
    ('{"level":"error","logger":"http.log.error","msg":"context deadline exceeded"}',
     "ERROR http.log.error", ("deadline",)),
]


def parse_test() -> int:
    failures = 0
    for line, expect_label, needles in PARSE_CASES:
        got = classify(line)
        label = got[0] if got else None
        body = got[1] if got else ""
        ok = label == expect_label and all(n in body for n in needles)
        if not ok:
            failures += 1
            log(f"FAIL: expected {expect_label!r} with {needles}\n      got {got!r}\n      for {line[:160]}")

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
            log(f"FAIL: {name} {detail}")

    # A paged HTTP/3 hang-up must never carry the query string.
    late = next(c[0] for c in PARSE_CASES if '"duration":31.2' in c[0])
    check("h3 late close strips the query", "code=" not in (classify(late) or ("", ""))[1])

    # The reader path with a line as compose actually emits it: ANSI colour
    # around the level, the braces and the colons, the container column in front.
    ansi = (
        "dweeb-proxy-1  | \x1b[2m2026-09-02T05:23:00.000000Z\x1b[0m \x1b[33m WARN\x1b[0m "
        "\x1b[1mhttp\x1b[0m\x1b[1m{\x1b[0m\x1b[3mmethod\x1b[0m\x1b[2m=\x1b[0mPOST "
        "\x1b[3mpath\x1b[0m\x1b[2m=\x1b[0m/api/telemetry/crash\x1b[1m}\x1b[0m\x1b[2m:\x1b[0m "
        "\x1b[2mweb_crash\x1b[0m\x1b[2m:\x1b[0m web app crash kind=boundary message=x\n"
    )
    routed = route_line(ansi)
    check(
        "reader path (ANSI + prefix + span + web_crash)",
        routed == ("proxy", ("WEB CRASH", "web app crash kind=boundary message=x")),
        repr(routed),
    )

    # The burst rule: nine upstream warns are nothing, the tenth within the
    # window pages once, a burst spread past the window does not fire, and a
    # second burst inside the mute is counted rather than posted again.
    t0 = 1_000_000.0
    c = Collector()
    fired = [
        c.note_upstream("proxy", f"upstream failed #{i}", now=t0 + i)
        for i in range(UPSTREAM_BURST_COUNT)
    ]
    check("burst fires on the Nth hit only", fired == [False] * (UPSTREAM_BURST_COUNT - 1) + [True], repr(fired))
    check(
        "burst queues one UPSTREAM STORM alert",
        [(r["svc"], r["label"]) for r in c.pending.values()] == [("proxy", "UPSTREAM STORM")],
        repr(c.pending),
    )
    # The storm was queued on the Nth hit (t0 + N - 1); it is due FLUSH_SECS later.
    body = c.flush_due(now=t0 + UPSTREAM_BURST_COUNT + FLUSH_SECS) or ""
    check("burst alert posts", "UPSTREAM STORM" in body and "upstream failed #9" in body, body[:200])
    again = [
        c.note_upstream("proxy", "upstream failed later", now=t0 + 100 + i)
        for i in range(UPSTREAM_BURST_COUNT)
    ]
    check("a second burst inside the mute is detected", again[-1] is True, repr(again))
    check("…but counted, not re-posted", not c.pending and any(
        r["label"] == "UPSTREAM STORM" and r["count"] == 1 for r in c.muted_counts.values()
    ), f"pending={c.pending!r} muted={c.muted_counts!r}")
    spread = Collector()
    slow = [
        spread.note_upstream("proxy", "x", now=t0 + i * (UPSTREAM_BURST_SECS // (UPSTREAM_BURST_COUNT - 2)))
        for i in range(UPSTREAM_BURST_COUNT)
    ]
    check("hits spread past the window never fire", not any(slow), repr(slow))

    total = len(PARSE_CASES) + 7
    log(f"parse-test: {total - failures}/{total} passed")
    return 1 if failures else 0


def main() -> int:
    if "--parse-test" in sys.argv:
        return parse_test()
    if not WEBHOOK.startswith("https://discord.com/api/webhooks/"):
        log("no usable webhook in ALERTS_WEBHOOK/MONITORING_DISCORD_WEBHOOK; exiting")
        return 1
    poster = Poster()
    if "--selftest" in sys.argv:
        poster.post(
            "✅ dweeb-alerts self-test: error-log alerting is wired up "
            "(watching: " + ", ".join(SERVICES) + ")"
        )
        return 0

    baseline_ids = container_ids()
    proc = subprocess.Popen(
        ["docker", "compose", "--project-directory", COMPOSE_DIR, "logs", "-f", "--no-color", "--tail=0"]
        + SERVICES,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        errors="replace",
    )
    collector = Collector()
    t = threading.Thread(target=reader, args=(proc, collector), daemon=True)
    t.start()
    log(f"attached to compose logs for: {', '.join(SERVICES)}")

    last_watchdog = time.time()
    try:
        while True:
            time.sleep(5)
            if proc.poll() is not None:
                log("compose logs stream ended; exiting for systemd restart")
                return 0
            body = collector.flush_due()
            if body:
                poster.post(body)
            if time.time() - last_watchdog >= WATCHDOG_SECS:
                last_watchdog = time.time()
                ids = container_ids()
                if ids and baseline_ids and ids != baseline_ids:
                    log("monitored containers changed (deploy?); exiting to reattach")
                    return 0
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
