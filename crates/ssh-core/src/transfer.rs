//! Shared transfer queue: cancel flags for in-flight SFTP upload/download jobs.
//!
//! Actual byte copy runs on the session worker (owns `ssh2::Sftp`). This module
//! only tracks job ids and cooperative cancel flags.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use uuid::Uuid;

/// Progress report cadence (bytes between intermediate events).
pub const PROGRESS_INTERVAL: u64 = 64 * 1024;

/// Read/write chunk size for SFTP transfers.
pub const CHUNK_SIZE: usize = 32 * 1024;

/// In-process map of transfer cancel flags.
#[derive(Default)]
pub struct TransferQueue {
    cancels: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
}

impl TransferQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new transfer and return its cancel flag (false = running).
    pub fn register(&self, transfer_id: Uuid) -> Arc<AtomicBool> {
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
        if let Ok(mut map) = self.cancels.lock() {
            map.remove(&transfer_id);
        }
    }

    pub fn is_cancelled(flag: &AtomicBool) -> bool {
        flag.load(Ordering::Relaxed)
    }
}
