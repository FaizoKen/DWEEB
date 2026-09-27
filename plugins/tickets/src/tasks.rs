//! Background work a deploy must let finish.
//!
//! Every multi-call flow answers Discord at once and finishes in a spawned
//! task. axum's graceful shutdown waits for in-flight *requests*, not for
//! those tasks — and every deploy restarts this service — so without this a
//! redeploy could cut a lock between muting the members and posting the
//! Reopen/Delete controls. [`Tasks`] counts what's running, and `main` waits
//! for it to drain (bounded, inside Docker's stop timeout) before exiting.
//! Whatever still outlives the deadline is what `Store::recover_interrupted`
//! is for.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

/// How long shutdown waits for running flows. Docker sends SIGKILL 10s after
/// SIGTERM by default; this leaves the process time to exit cleanly.
pub const DRAIN_DEADLINE: Duration = Duration::from_secs(8);

#[derive(Clone, Default)]
pub struct Tasks {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    running: AtomicUsize,
    idle: Notify,
}

/// Counts a task out when dropped — so one that panics still does.
struct Running(Arc<Inner>);

impl Drop for Running {
    fn drop(&mut self) {
        if self.0.running.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.idle.notify_waiters();
        }
    }
}

impl Tasks {
    /// Spawn `work`, counted until it finishes.
    pub fn spawn<F>(&self, work: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.inner.running.fetch_add(1, Ordering::AcqRel);
        let running = Running(self.inner.clone());
        tokio::spawn(async move {
            let _running = running;
            work.await;
        });
    }

    pub fn running(&self) -> usize {
        self.inner.running.load(Ordering::Acquire)
    }

    /// Wait until nothing is running, or `deadline` passes. Returns how many
    /// tasks were still running at the end.
    pub async fn drain(&self, deadline: Duration) -> usize {
        let idle = async {
            loop {
                // Register for the wake-up *before* checking, so a task that
                // finishes in between can't be missed.
                let notified = self.inner.idle.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.running() == 0 {
                    return;
                }
                notified.await;
            }
        };
        let _ = tokio::time::timeout(deadline, idle).await;
        self.running()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn drain_waits_for_running_work() {
        let tasks = Tasks::default();
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = done.clone();
        tasks.spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            flag.store(true, Ordering::SeqCst);
        });
        assert_eq!(tasks.running(), 1);
        assert_eq!(tasks.drain(Duration::from_secs(5)).await, 0);
        assert!(
            done.load(Ordering::SeqCst),
            "drain returned before the work finished"
        );
    }

    #[tokio::test]
    async fn drain_gives_up_at_its_deadline() {
        let tasks = Tasks::default();
        tasks.spawn(async { tokio::time::sleep(Duration::from_secs(30)).await });
        assert_eq!(tasks.drain(Duration::from_millis(50)).await, 1);
    }

    #[tokio::test]
    async fn a_panicking_task_still_counts_itself_out() {
        let tasks = Tasks::default();
        tasks.spawn(async { panic!("boom") });
        assert_eq!(tasks.drain(Duration::from_secs(5)).await, 0);
    }

    #[tokio::test]
    async fn an_idle_tracker_drains_at_once() {
        assert_eq!(Tasks::default().drain(Duration::from_secs(5)).await, 0);
    }
}
