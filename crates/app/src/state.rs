use std::collections::HashMap;
use std::fs::File;
use std::sync::Mutex;
use std::thread;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use protocol::events;
use protocol::TerminalOutputEvent;
use ssh_core::{SessionEvent, SessionManager};
use store::{ConnectionStore, SettingsStore};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

// Error mapping lives in error_map so it can be unit-tested without Tauri runtime.
pub use crate::error_map::{map_core_err, map_err_str};

/// Run a closure on a background OS thread and await the result.
/// This prevents Tauri sync commands from blocking the main thread on Windows.
pub async fn run_blocking<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce() -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    let (tx, rx) = flume::bounded(1);
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_async().await.map_err(|_| "background thread failed".to_string())?
}

pub struct AppState {
    pub connections: Mutex<ConnectionStore>,
    pub settings: Mutex<SettingsStore>,
    pub sessions: Mutex<SessionManager>,
    /// Open log files for sessions currently recording terminal output.
    pub session_logs: Mutex<HashMap<Uuid, File>>,
    /// Transient keyring credential ids for quick-connect (ad-hoc) sessions,
    /// keyed by session_id, deleted when the session closes.
    pub adhoc_creds: Mutex<HashMap<Uuid, String>>,
}

impl AppState {
    pub fn build(
        connections: ConnectionStore,
        settings: SettingsStore,
        sessions: SessionManager,
    ) -> Self {
        Self {
            connections: Mutex::new(connections),
            settings: Mutex::new(settings),
            sessions: Mutex::new(sessions),
            session_logs: Mutex::new(HashMap::new()),
            adhoc_creds: Mutex::new(HashMap::new()),
        }
    }
}

/// Spawn a background bridge that maps [`SessionEvent`] → Tauri events.
pub fn install_event_bridge(app: AppHandle, event_rx: flume::Receiver<SessionEvent>) {
    thread::Builder::new()
        .name("session-event-bridge".into())
        .spawn(move || {
            while let Ok(ev) = event_rx.recv() {
                match ev {
                    SessionEvent::Output {
                        session_id,
                        channel_id,
                        data,
                    } => {
                        // Append raw output to the session log file if recording.
                        if let Ok(mut logs) = app.state::<AppState>().session_logs.lock() {
                            if let Some(file) = logs.get_mut(&session_id) {
                                use std::io::Write;
                                let _ = file.write_all(&data);
                            }
                        }
                        let payload = TerminalOutputEvent {
                            session_id,
                            channel_id,
                            data_b64: B64.encode(&data),
                        };
                        let _ = app.emit(events::TERMINAL_OUTPUT, payload);
                    }
                    SessionEvent::Disconnected { session_id, reason } => {
                        #[derive(serde::Serialize, Clone)]
                        #[serde(rename_all = "camelCase")]
                        struct Disc {
                            session_id: Uuid,
                            reason: String,
                        }
                        let _ = app.emit(
                            events::SESSION_DISCONNECTED,
                            Disc {
                                session_id,
                                reason,
                            },
                        );
                    }
                    SessionEvent::TransferProgress {
                        transfer_id,
                        session_id,
                        bytes,
                        total,
                        status,
                        error,
                    } => {
                        let payload = protocol::TransferProgressEvent {
                            transfer_id,
                            session_id: Some(session_id),
                            bytes,
                            total,
                            status,
                            error,
                        };
                        let _ = app.emit(events::TRANSFER_PROGRESS, payload);
                    }
                    SessionEvent::TunnelStatus(status) => {
                        let _ = app.emit(events::TUNNEL_STATUS, status);
                    }
                }
            }
        })
        .expect("spawn session event bridge");
}
