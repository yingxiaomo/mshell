use std::sync::Mutex;
use std::thread;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use protocol::events;
use protocol::{SessionOpenResult, TerminalOutputEvent};
use ssh_core::{KnownHostsPolicy, SessionEvent, SessionManager};
use store::{ConnectionStore, SettingsStore};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// Error mapping lives in error_map so it can be unit-tested without Tauri runtime.
pub use crate::error_map::{map_core_err, map_err_str};

pub struct AppState {
    pub connections: Mutex<ConnectionStore>,
    pub settings: Mutex<SettingsStore>,
    pub sessions: Mutex<SessionManager>,
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

/// Look up a connection, connect + open shell, return open result.
///
/// The actual SSH connect/auth runs on a background thread (`tokio::task::spawn_blocking`)
/// so the command handler does not freeze the UI.
///
/// Thick blocking connect path. Call from a background thread if the UI must
/// stay responsive during TCP+SSH handshake.
#[allow(dead_code)]
pub fn open_session_blocking(
    state: &AppState,
    connection_id: Uuid,
    cols: u32,
    rows: u32,
) -> Result<SessionOpenResult, String> {
    let (conn, jump_chain) = {
        let store = state.connections.lock().map_err(|e| e.to_string())?;
        let conn = store.get(connection_id).ok_or_else(|| {
            format!("connection not found: {connection_id}")
        })?;
        let chain = ssh_core::resolve_jump_chain(&conn, |id| store.get(id))
            .map_err(map_core_err)?;
        (conn, chain)
    };

    let name = conn.name.clone();
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session_id = sessions
        .connect_with_chain(&conn, KnownHostsPolicy::Strict, Some(jump_chain))
        .map_err(map_core_err)?;

    let channel_id = match sessions.open_shell(session_id, cols, rows) {
        Ok(id) => id,
        Err(e) => {
            let _ = sessions.disconnect(session_id);
            return Err(map_core_err(e));
        }
    };

    // Open SFTP alongside PTY so the Files sidebar can list immediately.
    if let Err(e) = sessions.open_sftp(session_id) {
        let _ = sessions.disconnect(session_id);
        return Err(map_core_err(e));
    }

    // Auto-start connection-configured tunnels (failures are non-fatal per-tunnel).
    for t in conn.tunnels.iter().filter(|t| t.auto_start) {
        if let Err(e) = sessions.tunnel_start(session_id, t.clone()) {
            eprintln!(
                "auto-start tunnel '{}' ({}) failed: {e}",
                t.name, t.id
            );
        }
    }

    Ok(SessionOpenResult {
        session_id,
        connection_id,
        terminal_channel_id: channel_id,
        name,
    })
}

/// Best-effort disconnect of `session_id`, then open a new session for the same connection.
#[allow(dead_code)]
pub fn reconnect_session(
    state: &AppState,
    session_id: Uuid,
    cols: u32,
    rows: u32,
) -> Result<SessionOpenResult, String> {
    let connection_id = {
        let sessions = state.sessions.lock().map_err(map_err_str)?;
        sessions.connection_id(session_id).ok_or_else(|| {
            map_err_str(format!("session not found: {session_id}"))
        })?
    };

    {
        let mut sessions = state.sessions.lock().map_err(map_err_str)?;
        let _ = sessions.disconnect(session_id);
    }

    open_session_blocking(state, connection_id, cols, rows)
}
