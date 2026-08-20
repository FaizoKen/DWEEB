//! First-party product ratings — the source of the `aggregateRating` DWEEB
//! publishes in its own structured data.
//!
//! ## Why this exists rather than a link to a review site
//!
//! Every third-party review platform (Top.gg, Product Hunt, G2, AlternativeTo,
//! Reddit) marks its outbound links `nofollow`/`ugc`, so a review left there
//! passes no ranking signal to dweeb.faizo.net at all. What *does* change our
//! own search result is an `aggregateRating` on the `WebApplication` entity:
//! Google's review-snippet rich result supports software types, and the
//! self-serving-review restriction it applies to `LocalBusiness`/`Organization`
//! does not extend to them. Stars render beside the result for the head term
//! `/discord-message-builder/` targets.
//!
//! That only works if the number is true, which drives every decision below.
//!
//! ## Integrity, because this number is published as a factual claim
//!
//! - **One row per Discord user id, enforced by the primary key.** Re-rating
//!   overwrites; it never appends. An anonymous endpoint with a per-IP limit
//!   would have been trivially inflatable, and a rating snippet Google later
//!   judges fabricated is a structured-data manual action — the downside is
//!   losing every rich result on the domain, not merely this one.
//! - **Writes are identity-gated** through `resolve_identity`, the same gate
//!   `avatar.rs` uses to stop that endpoint becoming a free image host.
//! - **Reads are anonymous and cacheable.** The aggregate is public by
//!   definition — the whole point is to print it on a page — and the build
//!   fetches it over the open internet with no credential.
//! - Nothing here stores review *text*. A score and a user id is the entire
//!   record, so there is no user-authored content to moderate, escape, or leak
//!   into a generated page.
//!
//! ## What is deliberately NOT here
//!
//! No deletion sweep and no decay. A rating is a statement someone made about
//! the product; ageing it out would quietly change a published average with no
//! one having changed their mind. The table holds one row per rater, so its
//! size is bounded by the user base rather than by traffic.

use std::path::Path;

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use axum_extra::extract::PrivateCookieJar;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::json;

use crate::error::AppError;
use crate::routes::AppState;
use crate::sqlite_pool::SqlitePool;

/// Lowest and highest score a caller may submit. A five-point scale is what
/// `aggregateRating` consumers assume by default, and what every review UI a
/// visitor has ever seen presents.
pub const MIN_SCORE: i64 = 1;
pub const MAX_SCORE: i64 = 5;

/// Rating counts by score, `distribution[n]` holding the number of ratings of
/// score `n + 1`.
pub type Distribution = [i64; 5];

/// The published aggregate.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Aggregate {
    /// Mean score, unrounded. Callers round for display.
    pub average: f64,
    /// How many people have rated.
    pub count: i64,
    pub distribution: Distribution,
}

impl Aggregate {
    /// Mean rounded to one decimal — the precision Google renders, and the only
    /// precision a mean of a 1..=5 integer scale can honestly claim.
    pub fn rounded_average(&self) -> f64 {
        (self.average * 10.0).round() / 10.0
    }

    fn to_json(self) -> serde_json::Value {
        json!({
            "average": self.rounded_average(),
            "count": self.count,
            "best": MAX_SCORE,
            "worst": MIN_SCORE,
            "distribution": self.distribution,
        })
    }
}

pub struct RatingStore {
    pool: SqlitePool,
}

impl RatingStore {
    /// Open (creating if needed) the ratings table.
    pub fn open(path: &str) -> Result<Self, String> {
        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
            }
        }
        let pool = SqlitePool::open_default(path, |c: &Connection| {
            c.pragma_update(None, "journal_mode", "WAL")
                .map_err(|e| format!("journal_mode: {e}"))?;
            c.pragma_update(None, "synchronous", "NORMAL")
                .map_err(|e| format!("synchronous: {e}"))?;
            c.pragma_update(None, "busy_timeout", 5_000)
                .map_err(|e| format!("busy_timeout: {e}"))?;
            Ok(())
        })?;
        {
            let conn = pool.get();
            // `uid` is the PRIMARY KEY, not an indexed column: that is the
            // one-person-one-rating guarantee, enforced by the database rather
            // than by handler code a later refactor could drop.
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS ratings (
                     uid        TEXT PRIMARY KEY,
                     score      INTEGER NOT NULL,
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL
                 );",
            )
            .map_err(|e| format!("schema: {e}"))?;
        }
        Ok(RatingStore { pool })
    }

    /// Cheap connectivity probe for the readiness endpoint.
    pub fn ping(&self) -> Result<(), String> {
        self.pool.ping()
    }

    /// Record (or replace) one person's rating. Returns the fresh aggregate, so
    /// the caller needs no second round-trip to show the result.
    pub fn put(&self, uid: &str, score: i64, now: i64) -> Result<Aggregate, String> {
        if !(MIN_SCORE..=MAX_SCORE).contains(&score) {
            return Err(format!("score {score} out of range"));
        }
        let conn = self.pool.get();
        // ON CONFLICT keeps the original `created_at`: re-rating is a change of
        // mind, not a new rater, and the aggregate must not double-count it.
        conn.prepare_cached(
            "INSERT INTO ratings (uid, score, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(uid) DO UPDATE SET score = ?2, updated_at = ?3",
        )
        .map_err(|e| format!("prepare: {e}"))?
        .execute(rusqlite::params![uid, score, now])
        .map_err(|e| format!("insert: {e}"))?;
        read_aggregate(&conn)
    }

    /// One person's own score, if they have rated.
    pub fn mine(&self, uid: &str) -> Result<Option<i64>, String> {
        let conn = self.pool.get();
        let mut stmt = conn
            .prepare_cached("SELECT score FROM ratings WHERE uid = ?1")
            .map_err(|e| format!("prepare: {e}"))?;
        let mut rows = stmt
            .query(rusqlite::params![uid])
            .map_err(|e| format!("query: {e}"))?;
        match rows.next().map_err(|e| format!("row: {e}"))? {
            Some(row) => Ok(Some(row.get(0).map_err(|e| format!("col: {e}"))?)),
            None => Ok(None),
        }
    }

    /// The public aggregate.
    pub fn aggregate(&self) -> Result<Aggregate, String> {
        let conn = self.pool.get();
        read_aggregate(&conn)
    }
}

/// Count and mean in one pass over the score histogram. The table holds one row
/// per rater, so this scans at most the user base — small enough that a
/// materialised rollup would be more moving parts than it saves.
fn read_aggregate(conn: &Connection) -> Result<Aggregate, String> {
    let mut stmt = conn
        .prepare_cached("SELECT score, COUNT(*) FROM ratings GROUP BY score")
        .map_err(|e| format!("prepare: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("query: {e}"))?;
    let mut distribution: Distribution = [0; 5];
    let mut total: i64 = 0;
    let mut sum: i64 = 0;
    while let Some(row) = rows.next().map_err(|e| format!("row: {e}"))? {
        let score: i64 = row.get(0).map_err(|e| format!("col: {e}"))?;
        let n: i64 = row.get(1).map_err(|e| format!("col: {e}"))?;
        // A score outside the scale cannot be written through `put`, but the
        // file on disk is not a trusted input — skip rather than index blindly,
        // so a hand-edited row can neither panic the endpoint nor silently
        // distort a published average.
        if let Some(slot) = usize::try_from(score - MIN_SCORE)
            .ok()
            .and_then(|i| distribution.get_mut(i))
        {
            *slot = n;
            total += n;
            sum += score * n;
        }
    }
    Ok(Aggregate {
        average: if total > 0 {
            sum as f64 / total as f64
        } else {
            0.0
        },
        count: total,
        distribution,
    })
}

fn store(st: &AppState) -> Result<&std::sync::Arc<RatingStore>, AppError> {
    st.ratings.as_ref().ok_or_else(|| AppError::Status {
        status: StatusCode::NOT_IMPLEMENTED,
        message: "Ratings are not enabled on this deployment.".into(),
        retry_after: None,
    })
}

#[derive(Deserialize)]
pub struct RatingBody {
    score: i64,
}

/// `POST /api/rating` — record the signed-in user's score.
///
/// Identity-gated: the published average is a factual claim about the product,
/// and an anonymous write would make it a claim about whoever found the
/// endpoint. An out-of-range score is the caller's mistake, so it is a 400 —
/// 5xx is the paging channel (see AGENTS.md), and nothing a client can type
/// should wake anyone up.
pub async fn rating_put(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Json(body): Json<RatingBody>,
) -> Result<Response, AppError> {
    let store = std::sync::Arc::clone(store(&st)?);
    let session = crate::activity::resolve_identity(&st, &jar, &headers).await?;

    if !(MIN_SCORE..=MAX_SCORE).contains(&body.score) {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: format!("Rating must be between {MIN_SCORE} and {MAX_SCORE}."),
            retry_after: None,
        });
    }

    let uid = session.uid.clone();
    let score = body.score;
    let aggregate =
        tokio::task::spawn_blocking(move || store.put(&uid, score, crate::schedule::unix_now()))
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?
            .map_err(AppError::Internal)?;

    // Content-free: a score and a count, never a user id. This answers "is the
    // published average moving?" without recording who moved it.
    tracing::info!(
        target: "rating",
        score,
        count = aggregate.count,
        average = aggregate.rounded_average(),
        "rating recorded"
    );

    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "mine": score, "aggregate": aggregate.to_json() })),
    )
        .into_response())
}

/// `GET /api/rating` — the public aggregate.
///
/// Anonymous and cacheable: the build fetches this over the open internet to
/// bake the number into the static pages, and it is printed on one of them, so
/// there is nothing here to protect. The short max-age keeps a burst of build
/// or crawler traffic off SQLite without letting the published figure go stale
/// between deploys.
pub async fn rating_summary(State(st): State<AppState>) -> Result<Response, AppError> {
    let store = std::sync::Arc::clone(store(&st)?);
    let aggregate = tokio::task::spawn_blocking(move || store.aggregate())
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    Ok((
        [(header::CACHE_CONTROL, "public, max-age=300")],
        Json(aggregate.to_json()),
    )
        .into_response())
}

/// `GET /api/rating/me` — the caller's own score, or null.
///
/// The toast asks once. Remembering that only locally would re-ask the same
/// person on every other device they open DWEEB on, which is exactly the
/// nagging this feature has to avoid, so the answer comes from the server.
pub async fn rating_mine(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let store = std::sync::Arc::clone(store(&st)?);
    let session = crate::activity::resolve_identity(&st, &jar, &headers).await?;
    let uid = session.uid.clone();
    let mine = tokio::task::spawn_blocking(move || store.mine(&uid))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "mine": mine })),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pooled `:memory:` would give every connection in the pool its own
    /// empty database, so tests use a temp file like the other stores do.
    fn temp_store(tag: &str) -> (RatingStore, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("dweeb-rating-test-{}-{tag}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let store = RatingStore::open(path.to_str().unwrap()).unwrap();
        (store, path)
    }

    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_empty_table_reports_no_rating_rather_than_a_zero_average() {
        let (store, path) = temp_store("empty");
        let agg = store.aggregate().expect("aggregate");
        assert_eq!(agg.count, 0);
        // The pair (0.0, 0) is the signal "nothing to publish". A caller that
        // printed this as a score would be claiming the product rates zero, so
        // the count is what every consumer must branch on.
        assert_eq!(agg.average, 0.0);
        cleanup(&path);
    }

    #[test]
    fn one_person_holds_exactly_one_rating_however_often_they_change_it() {
        let (s, path) = temp_store("one-per-user");
        s.put("user-a", 5, 100).expect("put");
        s.put("user-a", 3, 200).expect("re-put");
        s.put("user-a", 4, 300).expect("re-put");
        let agg = s.aggregate().expect("aggregate");
        assert_eq!(agg.count, 1, "re-rating must replace, never append");
        assert_eq!(agg.average, 4.0);
        assert_eq!(s.mine("user-a").expect("mine"), Some(4));
        cleanup(&path);
    }

    #[test]
    fn the_average_and_distribution_describe_the_same_rows() {
        let (s, path) = temp_store("distribution");
        for (i, score) in [5, 5, 5, 4, 2].into_iter().enumerate() {
            s.put(&format!("user-{i}"), score, 100).expect("put");
        }
        let agg = s.aggregate().expect("aggregate");
        assert_eq!(agg.count, 5);
        assert_eq!(agg.distribution, [0, 1, 0, 1, 3]);
        assert_eq!(agg.distribution.iter().sum::<i64>(), agg.count);
        assert_eq!(agg.average, 21.0 / 5.0);
        assert_eq!(agg.rounded_average(), 4.2);
        cleanup(&path);
    }

    #[test]
    fn a_score_outside_the_scale_is_refused_at_the_store_not_only_the_handler() {
        let (s, path) = temp_store("range");
        assert!(s.put("user-a", 0, 100).is_err());
        assert!(s.put("user-a", 6, 100).is_err());
        assert!(s.put("user-a", -1, 100).is_err());
        assert_eq!(s.aggregate().expect("aggregate").count, 0);
        cleanup(&path);
    }

    #[test]
    fn a_hand_edited_out_of_scale_row_is_skipped_rather_than_panicking() {
        // The file on disk is not a trusted input. Someone poking at sqlite3
        // must not be able to turn every read into a 500 or an index panic.
        let (s, path) = temp_store("bogus-row");
        s.put("user-a", 5, 100).expect("put");
        {
            let conn = s.pool.get();
            conn.execute(
                "INSERT INTO ratings (uid, score, created_at, updated_at)
                 VALUES ('bogus', 99, 1, 1)",
                [],
            )
            .expect("hand-edit");
        }
        let agg = s.aggregate().expect("aggregate");
        assert_eq!(agg.count, 1, "the bogus row is excluded from the claim");
        assert_eq!(agg.average, 5.0);
        cleanup(&path);
    }

    #[test]
    fn rounding_never_invents_precision_the_scale_cannot_carry() {
        let agg = Aggregate {
            average: 4.266_66,
            count: 15,
            distribution: [0, 0, 0, 0, 0],
        };
        assert_eq!(agg.rounded_average(), 4.3);
    }
}
