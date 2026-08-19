//! Shared transfer queue: cancel flags + concurrency gating for SFTP upload/download.
//!
//! Actual byte copy runs on the session worker. This module tracks job ids,
//! cooperative cancel flags, and enforces a maximum concurrent transfer count.
//!
//! # Concurrency
//!
//! [`TransferQueue::register`] uses a [`Condvar`] instead of a spin-wait to
//! block when [`MAX_CONCURRENT`] transfers are already in flight. This avoids
//! wasting CPU cycles during queue contention.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use uuid::Uuid;

/// Progress report cadence (bytes between intermediate events). Kept coarse so
/// a fast transfer doesn't flood the UI with thousands of progress events.
pub const PROGRESS_INTERVAL: u64 = 1024 * 1024;

/// Read/write chunk size for SFTP transfers.
pub const CHUNK_SIZE: usize = 32 * 1024;

/// Advisory only (no longer enforced by blocking): SFTP transfers already run
/// serially on a session's dedicated worker, so there is nothing to gate.
pub const MAX_CONCURRENT: usize = 3;

/// In-process map of transfer cancel flags + concurrency counter.
#[derive(Default)]
pub struct TransferQueue {
    cancels: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
    /// `in_flight` count lives *inside* the same mutex the condvar waits on so
    /// register/finish never race (no lost wakeups).
    in_flight: (Mutex<usize>, Condvar),
}

/// Recover the guarded value even if a previous holder panicked. The counter is
/// a plain integer whose invariant survives a poisoned lock, so poison here must
/// not brick every future transfer.
fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl TransferQueue {
    pub fn new() -> Self {
        Self {
            cancels: Mutex::new(HashMap::new()),
            in_flight: (Mutex::new(0), Condvar::new()),
        }
    }

    /// Register a new transfer. Returns its cancel flag (false = running).
    ///
    /// Non-blocking: transfers already run serially on a session's dedicated SFTP
    /// worker, so there is nothing to gate here. The previous version blocked on a
    /// Condvar until under `MAX_CONCURRENT` — and because callers hold the sessions
    /// mutex across `register`, that block froze the whole app (terminal, monitor,
    /// listing) until a transfer slot freed. Just track the job and return.
    pub fn register(&self, transfer_id: Uuid) -> Arc<AtomicBool> {
        {
            let (lock, _cvar) = &self.in_flight;
            *lock_recover(lock) += 1;
        }
        let flag = Arc::new(AtomicBool::new(false));
        lock_recover(&self.cancels).insert(transfer_id, Arc::clone(&flag));
        flag
    }

    /// Request cancel. Returns true if the job was still tracked.
    pub fn cancel(&self, transfer_id: Uuid) -> bool {
        let map = lock_recover(&self.cancels);
        if let Some(flag) = map.get(&transfer_id) {
            flag.store(true, Ordering::SeqCst);
            return true;
        }
        false
    }

    /// Request cancel on **every** tracked transfer. Used on session shutdown so
    /// a blocking copy loop yields promptly instead of stalling disconnect.
    pub fn cancel_all(&self) {
        let map = lock_recover(&self.cancels);
        for flag in map.values() {
            flag.store(true, Ordering::SeqCst);
        }
    }

    /// Drop tracking entry (call when job finishes).
    pub fn finish(&self, transfer_id: Uuid) {
        lock_recover(&self.cancels).remove(&transfer_id);
        // Mutate the counter and notify *while holding* the mutex so a waiting
        // register() cannot miss the wakeup.
        let (lock, cvar) = &self.in_flight;
        let mut count = lock_recover(lock);
        *count = count.saturating_sub(1);
        cvar.notify_one();
    }

    /// True if a transfer id is still tracked (registered and not finished).
    /// Lets callers prune stale cancel flags without guessing.
    pub fn is_tracked(&self, transfer_id: Uuid) -> bool {
        lock_recover(&self.cancels).contains_key(&transfer_id)
    }

    pub fn is_cancelled(flag: &AtomicBool) -> bool {
        flag.load(Ordering::Relaxed)
    }

    /// Current number of running transfers (for UI / monitoring).
    pub fn running_count(&self) -> usize {
        *lock_recover(&self.in_flight.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_finish_track_in_flight() {
        let q = TransferQueue::new();
        let id = Uuid::new_v4();
        let flag = q.register(id);
        assert_eq!(q.running_count(), 1);
        assert!(!TransferQueue::is_cancelled(&flag));
        q.finish(id);
        assert_eq!(q.running_count(), 0);
    }

    #[test]
    fn cancel_all_sets_every_flag() {
        let q = TransferQueue::new();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let fa = q.register(a);
        let fb = q.register(b);
        q.cancel_all();
        assert!(TransferQueue::is_cancelled(&fa));
        assert!(TransferQueue::is_cancelled(&fb));
        q.finish(a);
        q.finish(b);
    }

    #[test]
    fn finish_below_zero_saturates() {
        let q = TransferQueue::new();
        // Extra finish must not underflow the counter.
        q.finish(Uuid::new_v4());
        assert_eq!(q.running_count(), 0);
    }
}
