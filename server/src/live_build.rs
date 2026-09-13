//! Which web build the public shell is serving **right now**.
//!
//! This exists for exactly one decision. A `stale-chunk-fatal` crash beacon says
//! "the app went down loading a chunk, and the chunk really is gone" — but that
//! is a broken deploy only if the client reporting it is running the build
//! visitors are being served. A tab that outlived a deploy produces the byte-
//! identical shape, and is nobody's problem: the chunks it wants were purged
//! precisely because a newer, working deploy replaced them.
//!
//! The client already asks that question itself (`probeLiveShell` in
//! `core/telemetry/reporter.ts`, shipped 2026-09-12) and answers it with the
//! never-paging `stale-shell` kind. That fixes every client running that code
//! and *no other*, which is the whole difficulty: the app ships from a
//! service-worker cache and `registerType: "prompt"` deliberately never forces
//! an update, so a tab keeps its bundle — and its reporter — for as long as the
//! person keeps it open. The two beacons that paged on 2026-09-13 came from
//! `e699a38eec`, a **24-day-old** bundle whose `chunkFailureKind` took only the
//! chunk probe and had no concept of a live shell. Waiting for such clients to
//! update is not a plan; they are the ones that cannot be fixed.
//!
//! So the proxy asks instead. Same rule as [`crate::telemetry::is_foreign_code_error`],
//! and for the same reason: where a stale client's judgement is the thing at
//! fault, the server has to be the authority.
//!
//! **This is not the beacon-learned classification the 2026-09-11 design record
//! rejected.** That rejection was of learning "newest build" from an
//! unauthenticated POST, which would let one forged beacon silence the paging
//! channel. Nothing here reads the beacon: the proxy fetches its own configured
//! `FRONTEND_URL` and reads the marker the build stamped into that shell. A
//! caller can lie about its own build all it likes — the worst it achieves is
//! claiming to be the live one, which pages, which is the status quo.
//!
//! Failure is always **toward paging**. An unreadable shell, an unreachable
//! host, a shell too old to carry the marker: all answer `None`, and `None`
//! means "don't know", which leaves the beacon exactly as loud as it is today.
//! Nothing here may quieten a page on a guess.

use std::time::{Duration, Instant};

use tokio::sync::Mutex;

/// How long a successful read stands before it is asked again. The question is
/// only ever asked when a fatal-shaped beacon arrives, which is a handful of
/// times a month, so this is about not re-fetching within one incident rather
/// than about freshness — and GitHub Pages caches `index.html` at its edge for
/// about ten minutes anyway, so a shorter TTL would buy no accuracy at all.
const FRESH_FOR: Duration = Duration::from_secs(300);

/// How long a *failed* read stands before it is retried. Short enough that a
/// blip doesn't mute the answer for a whole incident, long enough that a
/// sustained outage costs one request per minute rather than one per beacon.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// How long one read may take. The shell is ~22 KB (7 KB gzipped); a slower
/// answer than this is worth abandoning, because the caller is a fire-and-forget
/// telemetry beacon whose response nobody reads.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);

/// How much of the shell to read before giving up on finding the marker. The
/// tag sits in the first 4 KB of `index.html`; this is generous headroom that
/// still refuses to buffer an unbounded response.
const MAX_SHELL_BYTES: usize = 64 * 1024;

/// The marker `stampBuildMeta` (vite.config.ts) writes into `index.html`.
const BUILD_META_NAME: &str = "dweeb-build";

/// Cached answer to "what build is the public shell?", refreshed on demand.
pub struct LiveBuild {
    http: reqwest::Client,
    shell_url: String,
    /// `Mutex` rather than `RwLock` on purpose: held across the fetch, it makes
    /// concurrent askers single-flight onto one request for free. A beacon storm
    /// therefore costs one outbound read per TTL, not one per beacon — and the
    /// waiters find the answer already there.
    state: Mutex<Cached>,
}

#[derive(Default)]
struct Cached {
    /// `Some(build)` = the shell declared this. `None` = it declared nothing we
    /// could read, which callers must treat as "don't know", never as "no".
    build: Option<String>,
    /// When `build` was last settled. `None` = never asked.
    at: Option<Instant>,
}

impl LiveBuild {
    /// Build the reader for `frontend_url` — the builder's own URL, which is
    /// the shell every visitor loads. Never reads anything a caller supplied,
    /// so there is no request-driven fetch target here to abuse.
    ///
    /// Returns `None` if a client cannot be constructed, which leaves the
    /// caller on the fail-open path rather than failing the boot: this is a
    /// noise filter, not a feature anyone depends on.
    pub fn new(frontend_url: &str) -> Option<Self> {
        let shell_url = frontend_url.trim().to_string();
        if shell_url.is_empty() {
            return None;
        }
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            // A dial that never answers must not eat the whole deadline.
            .connect_timeout(Duration::from_secs(2))
            // Never follow a redirect. The fetch target is operator-configured
            // and never caller-influenced, so there is no first-order SSRF here
            // — but reqwest's default follows up to ten hops, which would hand
            // an origin that has been hijacked (or a domain that lapsed and was
            // re-registered) a blind GET from *inside* the compose network, on a
            // path any anonymous POST can trigger. `image_client` in activity.rs
            // guards the same way for the same reason. Pages serves `/` at 200
            // for a custom domain, so a redirect here is a misconfiguration and
            // failing open on it is the right answer.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("dweeb-proxy/", env!("CARGO_PKG_VERSION")))
            // One connection, parked between the rare reads.
            .pool_max_idle_per_host(1)
            .build()
            .ok()?;
        Some(Self {
            http,
            shell_url,
            state: Mutex::new(Cached::default()),
        })
    }

    /// The build the live shell declares, or `None` when we could not find out.
    ///
    /// Callers must treat `None` as "unknown" and fail toward whatever they
    /// would have done without this module at all.
    pub async fn current(&self) -> Option<String> {
        let mut state = self.state.lock().await;
        let ttl = if state.build.is_some() {
            FRESH_FOR
        } else {
            RETRY_AFTER
        };
        if let Some(at) = state.at {
            if at.elapsed() < ttl {
                return state.build.clone();
            }
        }
        let fetched = self.read_shell().await;
        // Say what we read, the first time and whenever it changes — realistically
        // once per deploy, so it costs nothing. Without it a *successful* read is
        // completely silent, and this feature's likeliest misconfiguration is
        // silent in the same direction: `FRONTEND_URL` is documented as a
        // post-login redirect target, so a value carrying a path or a query is a
        // plausible hand-edit, and every way of getting it wrong ends at the
        // fail-open path, i.e. at exactly the pages this was meant to stop. An
        // operator would then have no way to tell a broken config from a design
        // that does not work. Naming the URL as well as the build makes that one
        // grep (`journalctl … | grep live_build`).
        if fetched.is_some() && fetched != state.build {
            tracing::info!(
                target: "web_crash",
                live_build = %fetched.as_deref().unwrap_or_default(),
                shell = %self.shell_url,
                "live shell build observed",
            );
        }
        state.build = fetched.clone();
        state.at = Some(Instant::now());
        fetched
    }

    /// Fetch the shell and read its marker. Never logs at `error!` — tracing
    /// ERROR is the paging channel, and every failure here leaves the product
    /// working and merely returns this decision to its old, louder behaviour.
    async fn read_shell(&self) -> Option<String> {
        let res = self
            .http
            .get(&self.shell_url)
            // Belt to the CDN's braces. Pages keys its edge cache on the path
            // and will serve a copy up to ~10 minutes old whatever we ask, but
            // nothing between us and it should add more staleness than that.
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .send()
            .await;
        let mut res = match res {
            Ok(res) if res.status().is_success() => res,
            Ok(res) => {
                tracing::info!(
                    target: "web_crash",
                    status = res.status().as_u16(),
                    "live shell read: unexpected status",
                );
                return None;
            }
            Err(err) => {
                tracing::info!(target: "web_crash", %err, "live shell read failed");
                return None;
            }
        };

        // Read a bounded prefix rather than the whole body: the marker is in the
        // head, and a telemetry side-quest must not be able to buffer an
        // arbitrary amount of memory if the origin ever misbehaves.
        let mut body = Vec::with_capacity(8 * 1024);
        loop {
            match res.chunk().await {
                Ok(Some(chunk)) => {
                    let room = MAX_SHELL_BYTES.saturating_sub(body.len());
                    body.extend_from_slice(&chunk[..chunk.len().min(room)]);
                    if body.len() >= MAX_SHELL_BYTES {
                        break;
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    tracing::info!(target: "web_crash", %err, "live shell read cut short");
                    // A truncated head may still carry the marker; if it
                    // doesn't, the parse below answers `None` on its own.
                    break;
                }
            }
        }

        let html = String::from_utf8_lossy(&body);
        match build_meta_from_html(&html) {
            Some(build) => Some(build.to_string()),
            None => {
                // A shell older than the marker, or markup that drifted. Both
                // land on the same fail-open path; the build-time SEO audit is
                // where drift is supposed to fail, loudly.
                tracing::info!(target: "web_crash", "live shell declares no build marker");
                None
            }
        }
    }
}

/// The `content` of `<meta name="dweeb-build" …>` in an HTML shell.
///
/// A plain string scan, mirroring `buildMetaFromHtml` in
/// `src/core/telemetry/crashReport.ts` — the two read the same tag, and the
/// post-build SEO audit runs the TypeScript one over the real `dist/index.html`
/// so markup drift fails the build instead of silently un-gating this. Attribute
/// order is not assumed (`stampBuildMeta` writes `name` then `content`, but
/// nothing guarantees a formatter leaves it that way) and the name is matched
/// whole, so a longer `name` cannot be taken for this one.
fn build_meta_from_html(html: &str) -> Option<&str> {
    let mut rest = html;
    while let Some(start) = find_ci(rest, "<meta") {
        rest = &rest[start + "<meta".len()..];
        let Some(end) = rest.find('>') else { break };
        let (attributes, after) = rest.split_at(end);
        rest = after;
        if attribute(attributes, "name") == Some(BUILD_META_NAME) {
            if let Some(content) = attribute(attributes, "content") {
                if is_plausible_build(content) {
                    return Some(content);
                }
            }
        }
    }
    None
}

/// Whether `value` could be a build id at all.
///
/// This parser is the one part of the module a **hostile origin drives**: if
/// `FRONTEND_URL`'s host is ever hijacked, whatever it puts in the marker is
/// what we compare and log. Everything a build id can be is covered by
/// `vite.config.ts`'s `buildId()` — a short sha, optionally `-dirty`, or a
/// `t<base36>` timestamp fallback — so anything with whitespace (a newline would
/// forge a log line), a quote, or more characters than the beacon's own `build`
/// field survives clamping to, is not one. Rejecting it answers `None`, which is
/// the module's fail-open-to-paging path, so a hostile marker makes the channel
/// louder rather than quieter.
fn is_plausible_build(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_BUILD_LEN
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Longest marker worth believing. Mirrors `BUILD_MAX` in `telemetry.rs`, which
/// clamps the beacon's own `build`: a longer live build could never compare
/// equal to one, so believing it would only ever demote nothing.
const MAX_BUILD_LEN: usize = 32;

/// The value of `key` in an HTML start tag's attribute soup, in any quoting.
/// `None` when the attribute is absent or valueless.
fn attribute<'a>(attributes: &'a str, key: &str) -> Option<&'a str> {
    let mut rest = attributes;
    loop {
        let at = find_ci(rest, key)?;
        let before_ok = rest[..at]
            .chars()
            .next_back()
            .is_none_or(|c| c.is_whitespace() || c == '/');
        let after = &rest[at + key.len()..];
        rest = after;
        if !before_ok {
            continue;
        }
        let value = after.trim_start();
        let Some(value) = value.strip_prefix('=') else {
            // A bare attribute (`crossorigin`) or a longer name that merely
            // starts with `key` (`name-space=`): not the one asked for.
            continue;
        };
        let value = value.trim_start();
        return Some(match value.as_bytes().first() {
            Some(b'"') => value[1..].split('"').next().unwrap_or(""),
            Some(b'\'') => value[1..].split('\'').next().unwrap_or(""),
            _ => value
                .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
                .next()
                .unwrap_or(""),
        });
    }
}

/// Case-insensitive `str::find`, without allocating a lowercased copy of the
/// whole shell for every probe. ASCII is enough: both the tag and the attribute
/// names we look for are ASCII by definition.
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let needle = needle.as_bytes();
    haystack
        .as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The head exactly as `index.html` carries it once `stampBuildMeta` has
    /// run, with the neighbours that must not be mistaken for the marker.
    const SHELL: &str = r#"<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<meta name="dweeb-build" content="619d058a00" />
<meta property="og:updated_time" content="2026-08-20T00:00:00Z" />
<script type="module" crossorigin src="/assets/index-BqPBSPr8.js"></script>
</head><body></body></html>"#;

    #[test]
    fn reads_the_build_the_shell_declares() {
        assert_eq!(build_meta_from_html(SHELL), Some("619d058a00"));
    }

    #[test]
    fn does_not_care_about_attribute_order_or_quoting() {
        assert_eq!(
            build_meta_from_html(r#"<meta content="a1" name="dweeb-build">"#),
            Some("a1")
        );
        assert_eq!(
            build_meta_from_html(r#"<meta name='dweeb-build' content='b2'>"#),
            Some("b2")
        );
        assert_eq!(
            build_meta_from_html("<meta name=dweeb-build content=c3>"),
            Some("c3")
        );
        assert_eq!(
            build_meta_from_html(r#"<META NAME="dweeb-build" CONTENT="d4" />"#),
            Some("d4")
        );
        assert_eq!(
            build_meta_from_html("<meta\n  name=\"dweeb-build\"\n  content=\"e5\"\n/>"),
            Some("e5")
        );
    }

    /// A hand-deployed shell must compare equal to beacons from the bundle it
    /// shipped, `-dirty` and all — both come from the same `BUILD_ID`.
    #[test]
    fn carries_a_local_builds_dirty_marker_through_verbatim() {
        assert_eq!(
            build_meta_from_html(r#"<meta name="dweeb-build" content="619d058a00-dirty">"#),
            Some("619d058a00-dirty")
        );
    }

    #[test]
    fn matches_the_name_whole_and_tolerates_a_shell_without_one() {
        for html in [
            r#"<meta name="dweeb-build-id" content="x">"#,
            r#"<meta name="x-dweeb-build" content="x">"#,
            r#"<meta name="dweeb" content="x">"#,
            r#"<meta property="dweeb-build" content="x">"#,
            r#"<meta name="dweeb-build">"#,
            r#"<meta name="dweeb-build" content="">"#,
            "",
            "<html><body>Not a shell at all</body></html>",
        ] {
            assert_eq!(build_meta_from_html(html), None, "{html}");
        }
    }

    /// The parser must agree with the TypeScript one on the real shell shape,
    /// and must not be thrown by an unterminated tag at the truncation boundary
    /// — `read_shell` stops at a byte cap, so the last tag it sees may be cut.
    #[test]
    fn a_truncated_shell_never_panics_and_never_invents_a_build() {
        for cut in 0..SHELL.len() {
            if !SHELL.is_char_boundary(cut) {
                continue;
            }
            let head = &SHELL[..cut];
            match build_meta_from_html(head) {
                None => {}
                Some(found) => assert_eq!(found, "619d058a00", "cut at {cut}"),
            }
        }
    }

    /// Attribute soup that contains the marker's name only as a *value* must not
    /// be read as the marker — the scan looks at attribute names.
    /// The marker is the one input a hijacked `FRONTEND_URL` host controls, and
    /// it is compared *and logged*. Anything that is not shaped like a build id
    /// must read as absent — which is the fail-open path, so a hostile origin
    /// makes the paging channel louder, never quieter.
    #[test]
    fn a_marker_a_hostile_origin_could_forge_a_log_line_with_is_refused() {
        for hostile in [
            // A newline would forge a whole extra log line on the proxy.
            "a\n2026-09-13T10:00:00.000000Z ERROR dweeb_proxy::forged: on fire",
            "a\r\nERROR forged",
            "a\tb",
            "has spaces",
            // Longer than the beacon's own clamped `build`, so it could never
            // compare equal to one anyway.
            "0123456789012345678901234567890123456789",
            "<script>",
            "a;b",
        ] {
            let html = format!("<meta name=\"dweeb-build\" content=\"{hostile}\">");
            assert_eq!(build_meta_from_html(&html), None, "{hostile:?}");
        }
        // …while everything `buildId()` can actually produce still reads.
        for real in ["619d058a00", "619d058a00-dirty", "tm1k2j3h", "a_b.c-d"] {
            let html = format!("<meta name=\"dweeb-build\" content=\"{real}\">");
            assert_eq!(build_meta_from_html(&html), Some(real), "{real}");
        }
        assert_eq!(MAX_BUILD_LEN, 32, "must track telemetry.rs's BUILD_MAX");
    }

    #[test]
    fn a_name_that_only_appears_as_a_value_is_not_the_marker() {
        assert_eq!(
            build_meta_from_html(r#"<meta name="description" content="dweeb-build">"#),
            None
        );
    }

    #[test]
    fn an_empty_frontend_url_yields_no_reader() {
        assert!(LiveBuild::new("   ").is_none());
        assert!(LiveBuild::new("https://dweeb.faizo.net").is_some());
    }

    // ── Real sockets ──────────────────────────────────────────────────────
    //
    // The end-to-end behaviour is a property of reqwest and of a real HTTP
    // exchange, not of our reading of either — and the whole point of this
    // module is that it never quietens a page on a guess, which is exactly the
    // kind of claim a mocked client would happily let rot.

    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn read_request(sock: &mut std::net::TcpStream) {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        while !buf.ends_with(b"\r\n\r\n") {
            if sock.read(&mut byte).unwrap() == 0 {
                break;
            }
            buf.push(byte[0]);
        }
    }

    /// Serve `body` with `status` to each of `serves` requests, counting them.
    fn serve(status: &'static str, body: String, serves: usize) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for _ in 0..serves {
                let Ok((mut sock, _)) = listener.accept() else {
                    return;
                };
                read_request(&mut sock);
                counter.fetch_add(1, Ordering::SeqCst);
                let _ = sock.write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len(),
                    )
                    .as_bytes(),
                );
                sock.shutdown(std::net::Shutdown::Both).ok();
            }
        });
        (format!("http://{addr}/"), hits)
    }

    #[tokio::test]
    async fn reads_the_marker_off_a_real_shell_and_then_caches_it() {
        let (url, hits) = serve("200 OK", SHELL.to_string(), 4);
        let live = LiveBuild::new(&url).unwrap();

        assert_eq!(live.current().await.as_deref(), Some("619d058a00"));
        // The answer stands for its TTL: a beacon storm costs one read, not one
        // read per beacon.
        assert_eq!(live.current().await.as_deref(), Some("619d058a00"));
        assert_eq!(live.current().await.as_deref(), Some("619d058a00"));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    /// Every way the read can fail must answer `None` — "don't know" — because
    /// the caller's fail-open path is what keeps a real broken deploy audible.
    #[tokio::test]
    async fn every_failure_answers_unknown_rather_than_a_wrong_build() {
        // A shell that predates the marker.
        let (old_shell, _) = serve(
            "200 OK",
            "<!doctype html><html><head><title>DWEEB</title></head></html>".into(),
            1,
        );
        assert_eq!(LiveBuild::new(&old_shell).unwrap().current().await, None);

        // The host answering something other than a shell.
        let (not_found, _) = serve("404 Not Found", SHELL.to_string(), 1);
        assert_eq!(LiveBuild::new(&not_found).unwrap().current().await, None);

        // Nothing listening at all.
        let dead = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/", l.local_addr().unwrap())
        };
        assert_eq!(LiveBuild::new(&dead).unwrap().current().await, None);
    }

    /// A redirect is never followed: an origin that has been hijacked (or a
    /// lapsed domain re-registered) must not be able to aim a GET from inside
    /// the compose network. It reads as `None`, i.e. fail open.
    #[tokio::test]
    async fn a_redirect_is_refused_rather_than_followed_anywhere() {
        let inner = TcpListener::bind("127.0.0.1:0").unwrap();
        let inner_addr = inner.local_addr().unwrap();
        let reached = Arc::new(AtomicUsize::new(0));
        let counter = reached.clone();
        std::thread::spawn(move || {
            if let Ok((mut sock, _)) = inner.accept() {
                read_request(&mut sock);
                counter.fetch_add(1, Ordering::SeqCst);
                let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            }
        });

        let outer = TcpListener::bind("127.0.0.1:0").unwrap();
        let outer_addr = outer.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut sock, _)) = outer.accept() {
                read_request(&mut sock);
                let _ = sock.write_all(
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://{inner_addr}/internal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                );
                sock.shutdown(std::net::Shutdown::Both).ok();
            }
        });

        let live = LiveBuild::new(&format!("http://{outer_addr}/")).unwrap();
        assert_eq!(live.current().await, None);
        assert_eq!(
            reached.load(Ordering::SeqCst),
            0,
            "the redirect target must never be dialled"
        );
    }

    /// A failed read must not mute the question for the length of a whole
    /// incident, so it stands for the shorter `RETRY_AFTER` — but it must still
    /// be cached, or one outage would mean one outbound request per beacon.
    #[tokio::test]
    async fn a_failed_read_is_cached_too_but_briefly() {
        let (url, hits) = serve("500 Internal Server Error", String::new(), 3);
        let live = LiveBuild::new(&url).unwrap();
        assert_eq!(live.current().await, None);
        assert_eq!(live.current().await, None);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert!(RETRY_AFTER < FRESH_FOR, "a failure must be retried sooner");
    }

    /// The bounded read must not truncate a real shell into unreadability, and
    /// must refuse to buffer an origin that keeps talking.
    #[tokio::test]
    async fn the_read_is_bounded_without_losing_a_marker_in_the_head() {
        // The marker sits in the head; megabytes of body after it change nothing.
        let padded = format!("{SHELL}{}", "<!-- pad -->".repeat(40_000));
        assert!(padded.len() > MAX_SHELL_BYTES * 4);
        let (url, _) = serve("200 OK", padded, 1);
        assert_eq!(
            LiveBuild::new(&url).unwrap().current().await.as_deref(),
            Some("619d058a00")
        );

        // A marker pushed past the cap is simply not found — `None`, never a
        // wrong answer.
        let buried = format!("{}{SHELL}", "<!-- pad -->".repeat(10_000));
        assert!(buried.find("dweeb-build").unwrap() > MAX_SHELL_BYTES);
        let (url, _) = serve("200 OK", buried, 1);
        assert_eq!(LiveBuild::new(&url).unwrap().current().await, None);
    }
}
