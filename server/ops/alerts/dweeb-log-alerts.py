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
    "proxy,dispatcher,ping-pong,tickets,giveaway,quick-replies,self-role,modal-form,picker,caddy",
).split(",")

FLUSH_SECS = int(os.environ.get("ALERTS_FLUSH_SECS", "45"))
MUTE_SECS = int(os.environ.get("ALERTS_MUTE_SECS", "900"))
MAX_LINES_PER_POST = 8
SAMPLE_MAX = 280
WATCHDOG_SECS = 120

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
# `compose logs` prefixes each line with the container name column.
PREFIX_RE = re.compile(r"^(?P<name>\S+)\s+\|\s?(?P<rest>.*)$")
# tracing_subscriber default fmt: `2026-07-12T00:00:00.000000Z ERROR target{span}: msg`
TRACING_RE = re.compile(
    r"^\S+Z\s+(?P<level>ERROR|WARN)\s+(?P<target>[\w:_.-]+)(?:\{[^}]*\})?:\s?(?P<msg>.*)$"
)
PANIC_RE = re.compile(r"panicked at|thread '.*' panicked", re.IGNORECASE)

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
    """Return (label, message) when the line should alert, else None."""
    if PANIC_RE.search(rest):
        return ("PANIC", rest.strip())
    m = TRACING_RE.match(rest)
    if m:
        level, target, msg = m.group("level"), m.group("target"), m.group("msg")
        if level == "ERROR":
            return ("ERROR " + target, msg)
        if level == "WARN" and target.startswith("web_crash"):
            return ("WEB CRASH", msg)
        return None
    # Caddy logs JSON (zap): alert on error-level entries only.
    if rest.startswith("{") and '"level":"error"' in rest:
        try:
            j = json.loads(rest)
            return ("ERROR " + str(j.get("logger", "caddy")), str(j.get("msg", ""))[:200])
        except ValueError:
            return ("ERROR caddy", rest.strip()[:200])
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

    def add(self, svc: str, label: str, msg: str) -> None:
        sig = f"{svc}|{label}|{normalize(msg)}"
        with self.lock:
            now = time.time()
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

    def flush_due(self) -> str | None:
        """Build the next post body, or None if nothing is due yet."""
        with self.lock:
            now = time.time()
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


def reader(proc: subprocess.Popen, collector: Collector) -> None:
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = ANSI_RE.sub("", raw.rstrip("\n"))
        m = PREFIX_RE.match(line)
        if not m:
            continue
        svc = service_of(m.group("name"))
        if not svc:
            continue
        hit = classify(m.group("rest"))
        if hit:
            collector.add(svc, hit[0], hit[1])


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


def main() -> int:
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
