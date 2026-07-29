//! Top.gg listing stats — keeps the public bot page's server count current.
//!
//! Top.gg renders whatever server count a bot last **pushed** to it. There is no
//! pull, and stats are the only part of a listing the API can write (everything
//! else is dashboard-only), so a listing nobody posts to keeps showing the number
//! it had when it was created and quietly turns into a lie. This module is that
//! push: a background task reporting the bot's guild count on a timer.
//!
//! It is entirely optional — `TOPGG_TOKEN` unset ⇒ the task never spawns — which
//! is the right default everywhere but the public deployment. A self-hosted DWEEB
//! has no listing of its own, and posting *our* count under someone else's token
//! is not a mistake worth making easy.
//!
//! **Nothing here may reach the paging channel.** `dweeb-alerts` forwards tracing
//! `ERROR` to Discord, and every failure this task can hit — Top.gg down, a 429,
//! a rotated token — leaves the product working perfectly and makes only a public
//! counter stale. So it never logs `error!`. `warn` is reserved for the one class
//! that needs a human (Top.gg refusing our credentials); their outage is `info`
//! and is simply retried on the next tick.

use std::time::Duration;

use serde::Serialize;
use tokio::time::MissedTickBehavior;

use crate::routes::AppState;

/// Top.gg's API root. Stats go to `POST /bots/{id}/stats`, authenticated by the
/// bare token in `Authorization` — the documented form, verified against the live
/// API on 2026-07-30.
const API_BASE: &str = "https://top.gg/api";

/// How long one post may take before it's abandoned. Generous, since this is off
/// every request path, but bounded so a hung connection can't wedge the task
/// until the next tick.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Delay before the first post, so boot isn't competing with a paginated Discord
/// read that nothing is waiting on.
const FIRST_POST_DELAY: Duration = Duration::from_secs(60);

#[derive(Serialize)]
struct Stats {
    server_count: usize,
}

/// Start the reporter, if this deployment has a listing to report to. A no-op
/// without `TOPGG_TOKEN`.
pub fn spawn(state: AppState) {
    let Some(token) = state.config.topgg_token.clone() else {
        return;
    };
    let bot_id = state.config.topgg_bot_id.clone();
    let url = stats_url(&bot_id);
    let period = Duration::from_secs(state.config.topgg_post_interval_secs);

    // A dedicated client: the shared Discord one carries Discord's auth defaults
    // and its concurrency permits, neither of which belongs on a third party.
    let http = match reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!(
            "dweeb-proxy-topgg/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/FaizoKen/DWEEB)"
        ))
        .build()
    {
        Ok(http) => http,
        Err(e) => {
            tracing::warn!(error = %e, "top.gg stats disabled: could not build HTTP client");
            return;
        }
    };

    tracing::info!(
        bot_id = %bot_id,
        interval_secs = period.as_secs(),
        "top.gg stats reporting enabled"
    );

    tokio::spawn(async move {
        tokio::time::sleep(FIRST_POST_DELAY).await;
        let mut tick = tokio::time::interval(period);
        // Only the *current* count is worth posting, so a tick missed behind a
        // slow upstream is dropped rather than replayed as a catch-up burst.
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            // `interval`'s first tick completes immediately, so this posts once
            // as soon as the startup delay is over.
            tick.tick().await;
            post_once(&state, &http, &url, &token).await;
        }
    });
}

/// One read-and-report cycle. Every exit is best-effort; the next tick retries.
async fn post_once(st: &AppState, http: &reqwest::Client, url: &str, token: &str) {
    // Read the count from Discord directly rather than through the picker's
    // cached `botguilds` helper: that one folds a failed fetch into an empty set,
    // and a failure must never be published as a real number (see
    // `postable_count`). One extra paginated call per half hour is nothing.
    let count = match st.discord.bot_guild_ids().await {
        Ok(ids) => ids.len(),
        Err(e) => {
            tracing::info!(error = %e, "top.gg stats skipped: guild count unavailable");
            return;
        }
    };
    let Some(server_count) = postable_count(count) else {
        tracing::warn!("top.gg stats skipped: the bot reports zero servers");
        return;
    };

    let sent = http
        .post(url)
        .header(reqwest::header::AUTHORIZATION, token)
        .json(&Stats { server_count })
        .send()
        .await;

    match sent {
        Ok(resp) => {
            let status = resp.status().as_u16();
            match outcome_for(status) {
                Outcome::Ok => tracing::info!(server_count, "posted server count to top.gg"),
                Outcome::Transient => tracing::info!(
                    server_count,
                    status,
                    "top.gg stats post failed; retrying next tick"
                ),
                // The listing is now drifting and only a human can fix it — but
                // it is still just a public counter, so this stays below the
                // level that pages.
                Outcome::Rejected => tracing::warn!(
                    status,
                    "top.gg rejected the stats post — check TOPGG_TOKEN and TOPGG_BOT_ID"
                ),
            }
        }
        Err(e) => tracing::info!(error = %e, "top.gg stats post failed; retrying next tick"),
    }
}

/// The stats endpoint for one bot.
fn stats_url(bot_id: &str) -> String {
    format!("{API_BASE}/bots/{bot_id}/stats")
}

/// The count to publish, or `None` to publish nothing.
///
/// Zero is refused. A deployed bot is never actually in zero servers, so a zero
/// here means something upstream is wrong — and unlike a stale count, a published
/// zero is *visibly* wrong on a public page and sorts the listing to the bottom
/// until the next successful post. Skipping leaves the last good number standing,
/// which is the better failure.
fn postable_count(count: usize) -> Option<usize> {
    (count > 0).then_some(count)
}

/// What a response status means for the next tick.
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Ok,
    /// Their side, or a burst of ours — the same request will likely work later.
    Transient,
    /// Our request or credentials are wrong; retrying unchanged won't help.
    Rejected,
}

fn outcome_for(status: u16) -> Outcome {
    match status {
        200..=299 => Outcome::Ok,
        429 | 500..=599 => Outcome::Transient,
        _ => Outcome::Rejected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_url_targets_the_bot() {
        assert_eq!(
            stats_url("1511769679096447016"),
            "https://top.gg/api/bots/1511769679096447016/stats"
        );
    }

    /// A failed guild read must never be published as "zero servers".
    #[test]
    fn zero_is_never_published() {
        assert_eq!(postable_count(0), None);
        assert_eq!(postable_count(1), Some(1));
        assert_eq!(postable_count(8), Some(8));
    }

    #[test]
    fn statuses_split_into_retry_and_fix_me() {
        assert_eq!(outcome_for(200), Outcome::Ok);
        assert_eq!(outcome_for(204), Outcome::Ok);
        // Their outage / our burst: say nothing loud, try again next tick.
        assert_eq!(outcome_for(429), Outcome::Transient);
        assert_eq!(outcome_for(500), Outcome::Transient);
        assert_eq!(outcome_for(502), Outcome::Transient);
        // A rotated token or a wrong bot id — the only case worth a warn.
        assert_eq!(outcome_for(401), Outcome::Rejected);
        assert_eq!(outcome_for(403), Outcome::Rejected);
        assert_eq!(outcome_for(404), Outcome::Rejected);
    }
}
