use std::sync::mpsc;

use protocol::SessionOpenResult;
use ssh_core::KnownHostsPolicy;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::state::{AppState, map_core_err};

/// Connect on a background thread so the UI stays responsive during TCP+SSH handshake.
/// The command blocks on a channel (the Tauri command thread pool keeps other commands alive).
#[tauri::command]
pub fn session_open(
    app: AppHandle,
    connection_id: Uuid,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<SessionOpenResult, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);

    // Pre-resolve connection and jump chain (quick Mutex lock).
    let (conn, jump_chain) = {
        let state = app.state::<AppState>();
        let store = state.connections.lock().map_err(|e| e.to_string())?;
        let conn = store.get(connection_id).ok_or_else(|| {
            format!("connection not found: {connection_id}")
        })?;
        let chain = ssh_core::resolve_jump_chain(&conn, |id| store.get(id))
            .map_err(|e| e.to_string())?;
        (conn, chain)
    };

    let name = conn.name.clone();
    let (tx, rx) = mpsc::channel();

    // Spawn the blocking connect on a fresh OS thread.
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let result = do_connect(app_clone, connection_id, &conn, jump_chain, cols, rows, name);
        let _ = tx.send(result);
    });

    rx.recv().map_err(|_| "connect thread died".to_string())?
}

fn do_connect(
    app: AppHandle,
    connection_id: Uuid,
    conn: &protocol::Connection,
    jump_chain: Vec<protocol::Connection>,
    cols: u32,
    rows: u32,
    name: String,
) -> Result<SessionOpenResult, String> {
    let state = app.state::<AppState>();
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;

    let session_id = sessions
        .connect_with_chain(conn, KnownHostsPolicy::Strict, Some(jump_chain))
        .map_err(map_core_err)?;

    let channel_id = match sessions.open_shell(session_id, cols, rows) {
        Ok(id) => id,
        Err(e) => {
            let _ = sessions.disconnect(session_id);
            return Err(map_core_err(e));
        }
    };

    if let Err(e) = sessions.open_sftp(session_id) {
        let _ = sessions.disconnect(session_id);
        return Err(map_core_err(e));
    }

    for t in conn.tunnels.iter().filter(|t| t.auto_start) {
        if let Err(e) = sessions.tunnel_start(session_id, t.clone()) {
            eprintln!("auto-start tunnel '{}' ({}) failed: {e}", t.name, t.id);
        }
    }

    Ok(SessionOpenResult {
        session_id,
        connection_id,
        terminal_channel_id: channel_id,
        name,
    })
}

#[tauri::command]
pub fn session_close(state: State<'_, AppState>, session_id: Uuid) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .disconnect(session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_reconnect(
    app: AppHandle,
    session_id: Uuid,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<SessionOpenResult, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);

    let connection_id = {
        let state = app.state::<AppState>();
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.connection_id(session_id).ok_or_else(|| {
            format!("session not found: {session_id}")
        })?
    };

    {
        let state = app.state::<AppState>();
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let _ = sessions.disconnect(session_id);
    }

    session_open(app, connection_id, Some(cols), Some(rows))
}
