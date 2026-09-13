//! Name resolution for the proxy's calls to Discord: the system resolver, with
//! the last answer it gave kept to dial when it stalls.
//!
//! Every new connection to discord.com starts with a lookup through a chain that
//! remembers nothing past a record's TTL — glibc (no cache) → Docker's embedded
//! DNS (no cache) → the host's systemd-resolved (300 s for discord.com) → the VPS
//! provider's two resolvers. When one query to those is dropped, systemd-resolved
//! re-sends only after a fixed five seconds (systemd 255 spreads its 120 s query
//! budget over 24 attempts) and Docker abandons the forwarded query after four,
//! so the lookup outlives the five-second `CONNECT_TIMEOUT` that bounds DNS, TCP
//! and TLS together. On 2026-09-13 that paged as a 502 reading
//! `client error (Connect): operation timed out` at 5001 ms, one second after
//! dockerd logged the discord.com queries timing out against the host resolver;
//! the journal then held 61 such stalls in eight days.
//!
//! Discord hadn't gone anywhere. The addresses behind discord.com are a CDN's
//! anycast front, the same from one lookup to the next minutes later, so the
//! address the proxy dialled last time is the one it needs now. This resolver
//! keeps that answer and dials it when a fresh lookup stalls or fails — RFC 8767
//! "serve stale", applied at the one place the stall hurts. It is safe because
//! TLS checks the certificate against the *name* on every connection, whichever
//! address DNS produced: a stale address can fail to connect, never connect us to
//! anyone but the host we asked for.
//!
//! A lookup that answers always wins. The remembered address stands in only
//! after [`Timing::fresh_wait`] without an answer, or on an outright failure, and
//! the lookup runs on its own task, so an answer that arrives late still
//! refreshes the memory for the next dial. With nothing remembered (a fresh
//! process) a stall still fails the dial — but at [`Timing::deadline`], inside
//! the connect timeout, as an error naming DNS and the host rather than the bare
//! "operation timed out" that hid it on 2026-09-13.

use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use tokio::time::Instant;

/// Most names remembered at once. The Discord client resolves one or two hosts;
/// the cap only keeps a surprise from growing the map without bound.
const MAX_REMEMBERED: usize = 16;

/// The resolver's deadlines — see the module docs for how they interact.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// How long a lookup may run before the remembered answer is dialled instead.
    pub fresh_wait: Duration,
    /// How long a lookup may run when nothing is remembered before the dial fails.
    pub deadline: Duration,
    /// The oldest remembered answer that may still stand in for a lookup.
    pub max_stale: Duration,
}

pub type LookupFuture = Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send>>;

/// What actually asks DNS: the system resolver in production, a script in tests.
pub type Lookup = Arc<dyn Fn(String) -> LookupFuture + Send + Sync>;

/// A `reqwest` resolver that dials the last good answer when a lookup stalls.
#[derive(Clone)]
pub struct ServeStaleResolver {
    lookup: Lookup,
    timing: Timing,
    memory: Arc<Mutex<HashMap<String, Remembered>>>,
}

struct Remembered {
    addrs: Vec<SocketAddr>,
    at: Instant,
}

impl ServeStaleResolver {
    /// Over the system resolver: `getaddrinfo` on tokio's blocking pool, the same
    /// lookup reqwest makes when left to its default.
    pub fn system(timing: Timing) -> Self {
        Self::with_lookup(
            timing,
            Arc::new(|host: String| -> LookupFuture {
                Box::pin(async move {
                    // Port 0: the connector puts the URL's port on every address.
                    Ok(tokio::net::lookup_host((host.as_str(), 0)).await?.collect())
                })
            }),
        )
    }

    pub fn with_lookup(timing: Timing, lookup: Lookup) -> Self {
        ServeStaleResolver {
            lookup,
            timing,
            memory: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn resolve_host(&self, host: String) -> Result<Vec<SocketAddr>, DnsError> {
        // What was remembered when this dial began — read before the lookup
        // starts, so an instant answer can't pose as the fallback.
        let remembered = self.recall(&host);

        // The lookup runs on its own task: when it answers after the dial has
        // stopped waiting, the answer still lands in memory for the next one.
        let mut lookup = tokio::spawn({
            let this = self.clone();
            let host = host.clone();
            async move {
                let addrs = (this.lookup)(host.clone()).await?;
                if !addrs.is_empty() {
                    this.remember(&host, &addrs);
                }
                Ok::<_, io::Error>(addrs)
            }
        });

        let Some((stand_in, age)) = remembered else {
            // Nothing to fall back on: wait for this lookup, but only until the
            // deadline, so a stall fails as the DNS failure it is.
            let cause = match tokio::time::timeout(self.timing.deadline, lookup).await {
                Ok(Ok(Ok(addrs))) if !addrs.is_empty() => return Ok(addrs),
                Ok(Ok(Ok(_))) => Cause::NoAddresses,
                Ok(Ok(Err(e))) => Cause::Failed(e),
                Ok(Err(_)) => Cause::Failed(io::Error::other("the lookup task was lost")),
                Err(_) => Cause::NoAnswer(self.timing.deadline),
            };
            return Err(DnsError { host, cause });
        };

        let outcome = match tokio::time::timeout(self.timing.fresh_wait, &mut lookup).await {
            Ok(Ok(Ok(addrs))) if !addrs.is_empty() => return Ok(addrs),
            Ok(Ok(Ok(_))) => "returned no addresses".to_string(),
            Ok(Ok(Err(e))) => format!("failed: {e}"),
            Ok(Err(_)) => "was lost".to_string(),
            Err(_) => format!("had no answer within {:?}", self.timing.fresh_wait),
        };
        // Info, not warn: nothing failed. Same stance as the dispatcher's
        // recovered dial — greppable under the `dns` target, never a page.
        tracing::info!(
            target: "dns",
            %host,
            lookup = %outcome,
            answer_age_secs = age.as_secs(),
            "DNS lookup gave no usable answer; dialling the address from the last good one"
        );
        Ok(stand_in)
    }

    /// The remembered answer for `host` and its age, unless it's past `max_stale`.
    fn recall(&self, host: &str) -> Option<(Vec<SocketAddr>, Duration)> {
        let memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        let entry = memory.get(host)?;
        let age = entry.at.elapsed();
        (age <= self.timing.max_stale).then(|| (entry.addrs.clone(), age))
    }

    fn remember(&self, host: &str, addrs: &[SocketAddr]) {
        // Fail open on a poisoned lock, as `SingleFlight` does: one bad scope
        // must never wedge every future dial.
        let mut memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        if memory.len() >= MAX_REMEMBERED && !memory.contains_key(host) {
            let oldest = memory
                .iter()
                .min_by_key(|(_, r)| r.at)
                .map(|(h, _)| h.clone());
            if let Some(oldest) = oldest {
                memory.remove(&oldest);
            }
        }
        memory.insert(
            host.to_owned(),
            Remembered {
                addrs: addrs.to_vec(),
                at: Instant::now(),
            },
        );
    }
}

impl Resolve for ServeStaleResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let this = self.clone();
        let host = name.as_str().to_ascii_lowercase();
        Box::pin(async move {
            let addrs = this.resolve_host(host).await?;
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/// A lookup that failed with nothing remembered to fall back on. It reaches the
/// 502's `error` field — and the page — as
/// `…client error (Connect): dns error: <this>`.
#[derive(Debug)]
pub struct DnsError {
    host: String,
    cause: Cause,
}

#[derive(Debug)]
enum Cause {
    NoAnswer(Duration),
    Failed(io::Error),
    NoAddresses,
}

impl fmt::Display for DnsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let host = &self.host;
        match &self.cause {
            Cause::NoAnswer(after) => write!(
                f,
                "no answer for {host} within {after:?}, and no earlier answer to fall back on"
            ),
            Cause::Failed(_) => write!(
                f,
                "{host} did not resolve, and no earlier answer to fall back on"
            ),
            Cause::NoAddresses => write!(f, "{host} resolved to no addresses"),
        }
    }
}

impl Error for DnsError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match &self.cause {
            Cause::Failed(e) => Some(e),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The production values (see `discord.rs`), on a paused clock.
    const TIMING: Timing = Timing {
        fresh_wait: Duration::from_secs(1),
        deadline: Duration::from_secs(4),
        max_stale: Duration::from_secs(24 * 60 * 60),
    };

    fn addr(last: u8) -> SocketAddr {
        SocketAddr::from(([162, 159, 128, last], 0))
    }

    /// What the next lookup does.
    #[derive(Clone)]
    enum Next {
        Answer(Vec<SocketAddr>),
        AnswerAfter(Duration, Vec<SocketAddr>),
        Fail,
        /// Longer than any deadline here: the 2026-09-13 stall.
        Stall,
    }

    struct Script {
        next: Mutex<Next>,
        calls: AtomicUsize,
    }

    impl Script {
        fn then(&self, next: Next) {
            *self.next.lock().unwrap() = next;
        }
    }

    fn scripted(first: Next) -> (ServeStaleResolver, Arc<Script>) {
        let script = Arc::new(Script {
            next: Mutex::new(first),
            calls: AtomicUsize::new(0),
        });
        let s = Arc::clone(&script);
        let lookup: Lookup = Arc::new(move |_host| -> LookupFuture {
            s.calls.fetch_add(1, Ordering::SeqCst);
            let next = s.next.lock().unwrap().clone();
            Box::pin(async move {
                match next {
                    Next::Answer(addrs) => Ok(addrs),
                    Next::AnswerAfter(wait, addrs) => {
                        tokio::time::sleep(wait).await;
                        Ok(addrs)
                    }
                    Next::Fail => Err(io::Error::other(
                        "failed to lookup address information: Temporary failure in name resolution",
                    )),
                    Next::Stall => {
                        tokio::time::sleep(Duration::from_secs(3600)).await;
                        Ok(vec![addr(99)])
                    }
                }
            })
        });
        (ServeStaleResolver::with_lookup(TIMING, lookup), script)
    }

    async fn resolve(resolver: &ServeStaleResolver) -> Result<Vec<SocketAddr>, DnsError> {
        resolver.resolve_host("discord.com".into()).await
    }

    /// Within a millisecond of `want` — tokio's timer rounds deadlines up to one.
    fn about(took: Duration, want: Duration) -> bool {
        took >= want && took <= want + Duration::from_millis(1)
    }

    #[tokio::test(start_paused = true)]
    async fn an_answer_is_used_and_remembered_and_a_newer_one_replaces_it() {
        let (resolver, script) = scripted(Next::Answer(vec![addr(1)]));
        assert_eq!(resolve(&resolver).await.unwrap(), vec![addr(1)]);
        assert_eq!(resolver.recall("discord.com").unwrap().0, vec![addr(1)]);

        script.then(Next::Answer(vec![addr(2)]));
        assert_eq!(resolve(&resolver).await.unwrap(), vec![addr(2)]);
        assert_eq!(resolver.recall("discord.com").unwrap().0, vec![addr(2)]);
        assert_eq!(
            script.calls.load(Ordering::SeqCst),
            2,
            "every dial asks DNS afresh"
        );
    }

    /// The 2026-09-13 page, with a lookup behind it that had answered before:
    /// the dial goes ahead on that answer after the fresh wait instead of dying
    /// at the connect timeout.
    #[tokio::test(start_paused = true)]
    async fn a_stalled_lookup_dials_the_last_good_answer_after_the_fresh_wait() {
        let (resolver, script) = scripted(Next::Answer(vec![addr(1)]));
        resolve(&resolver).await.unwrap();

        script.then(Next::Stall);
        let started = Instant::now();
        assert_eq!(resolve(&resolver).await.unwrap(), vec![addr(1)]);
        assert!(about(started.elapsed(), TIMING.fresh_wait));
    }

    /// Falling back doesn't abandon the lookup: its late answer is what the next
    /// dial falls back to.
    #[tokio::test(start_paused = true)]
    async fn a_late_answer_still_refreshes_the_memory() {
        let (resolver, script) = scripted(Next::Answer(vec![addr(1)]));
        resolve(&resolver).await.unwrap();

        script.then(Next::AnswerAfter(Duration::from_secs(3), vec![addr(2)]));
        assert_eq!(resolve(&resolver).await.unwrap(), vec![addr(1)]);
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(resolver.recall("discord.com").unwrap().0, vec![addr(2)]);
    }

    /// A lookup that fails outright (SERVFAIL, EAI_AGAIN) has nothing to wait for.
    #[tokio::test(start_paused = true)]
    async fn a_failed_lookup_dials_the_last_good_answer_at_once() {
        let (resolver, script) = scripted(Next::Answer(vec![addr(1)]));
        resolve(&resolver).await.unwrap();

        script.then(Next::Fail);
        let started = Instant::now();
        assert_eq!(resolve(&resolver).await.unwrap(), vec![addr(1)]);
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    /// A fresh process has nothing to fall back on, so the stall still fails the
    /// dial — at the deadline, which sits inside the connect timeout, with a
    /// message that says what failed.
    #[tokio::test(start_paused = true)]
    async fn with_nothing_remembered_a_stall_fails_at_the_deadline_naming_dns() {
        let (resolver, _script) = scripted(Next::Stall);
        let started = Instant::now();
        let err = resolve(&resolver).await.unwrap_err();
        assert!(about(started.elapsed(), TIMING.deadline));
        let msg = err.to_string();
        assert!(msg.contains("no answer for discord.com within 4s"), "{msg}");
        assert!(msg.contains("no earlier answer"), "{msg}");
    }

    #[tokio::test(start_paused = true)]
    async fn with_nothing_remembered_a_failure_keeps_its_cause() {
        let (resolver, _script) = scripted(Next::Fail);
        let err = resolve(&resolver).await.unwrap_err();
        assert!(
            err.to_string().contains("discord.com did not resolve"),
            "{err}"
        );
        let cause = err.source().expect("the lookup's own error").to_string();
        assert!(
            cause.contains("Temporary failure in name resolution"),
            "{cause}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_answer_past_max_stale_is_not_dialled() {
        let (resolver, script) = scripted(Next::Answer(vec![addr(1)]));
        resolve(&resolver).await.unwrap();

        tokio::time::advance(TIMING.max_stale + Duration::from_secs(1)).await;
        script.then(Next::Stall);
        assert!(resolve(&resolver).await.is_err());
    }

    /// Memory is per name — one host's answer never stands in for another's —
    /// and bounded, oldest out first.
    #[tokio::test(start_paused = true)]
    async fn memory_is_per_host_and_bounded() {
        let (resolver, script) = scripted(Next::Answer(vec![addr(1)]));
        for i in 0..=MAX_REMEMBERED {
            resolver
                .resolve_host(format!("h{i}.example"))
                .await
                .unwrap();
            tokio::time::advance(Duration::from_millis(1)).await;
        }
        {
            let memory = resolver.memory.lock().unwrap();
            assert_eq!(memory.len(), MAX_REMEMBERED);
            assert!(!memory.contains_key("h0.example"), "the oldest goes first");
            assert!(memory.contains_key(&format!("h{MAX_REMEMBERED}.example")));
        }

        script.then(Next::Stall);
        assert!(resolver.resolve_host("other.example".into()).await.is_err());
    }

    /// The path reqwest takes: a `Name` in, addresses out, one memory whatever
    /// the case of the name.
    #[tokio::test(start_paused = true)]
    async fn resolves_through_the_reqwest_trait_case_insensitively() {
        let (resolver, script) = scripted(Next::Answer(vec![addr(1)]));
        let name: Name = "Discord.COM".parse().unwrap();
        let addrs: Vec<_> = Resolve::resolve(&resolver, name).await.unwrap().collect();
        assert_eq!(addrs, vec![addr(1)]);

        script.then(Next::Stall);
        let name: Name = "discord.com".parse().unwrap();
        let addrs: Vec<_> = Resolve::resolve(&resolver, name).await.unwrap().collect();
        assert_eq!(addrs, vec![addr(1)]);
    }
}
