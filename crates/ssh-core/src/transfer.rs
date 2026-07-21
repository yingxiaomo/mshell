//! Shared transfer queue: cancel flags + concurrency gating for SFTP upload/download.
//!
//! Actual byte copy runs on the session worker. This module tracks job ids,
//! cooperative cancel flags, and enforces a maximum concurrent transfer count.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use uuid::Uuid;

/// Progress report cadence (bytes between intermediate events).
pub const PROGRESS_INTERVAL: u64 = 64 * 1024;

/// Read/write chunk size for SFTP transfers.
pub const CHUNK_SIZE: usize = 32 * 1024;

/// Default max concurrent transfers (SSH SFTP is single-threaded per session;
/// multiple sessions can run in parallel, but per-session we limit to 3 to
/// avoid starving the PTY poll loop).
pub const MAX_CONCURRENT: usize = 3;

/// In-process map of transfer cancel flags + concurrency counter.
#[derive(Default)]
pub struct TransferQueue {
    cancels: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
    in_flight: AtomicUsize,
}

impl TransferQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new transfer. Returns its cancel flag (false = running).
    /// May block (spin-wait) if MAX_CONCURRENT already in flight on this queue.
    pub fn register(&self, transfer_id: Uuid) -> Arc<AtomicBool> {
        // Spin-wait until under the limit. The session worker loop is polling
        // at ~15ms so this doesn't deadlock — transfers finish and call finish().
        while self.in_flight.load(Ordering::Relaxed) >= MAX_CONCURRENT {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        self.in_flight.fetch_add(1, Ordering::Release);

        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.cancels.lock() {
            map.insert(transfer_id, Arc::clone(&flag));
        }
        flag
    }

    /// Request cancel. Returns true if the job was still tracked.
    pub fn cancel(&self, transfer_id: Uuid) -> bool {
        if let Ok(map) = self.cancels.lock() {
            if let Some(flag) = map.get(&transfer_id) {
                flag.store(true, Ordering::SeqCst);
                return true;
            }
        }
        false
    }

    /// Drop tracking entry (call when job finishes).
    pub fn finish(&self, transfer_id: Uuid) {
        self.in_flight.fetch_sub(1, Ordering::Release);
        if let Ok(mut map) = self.cancels.lock() {
            map.remove(&transfer_id);
        }
    }

    pub fn is_cancelled(flag: &AtomicBool) -> bool {
        flag.load(Ordering::Relaxed)
    }

    /// Current number of running transfers (for UI / monitoring).
    pub fn running_count(&self) -> usize {
        self.in_flight.load(Ordering::Acquire)
    }
}
