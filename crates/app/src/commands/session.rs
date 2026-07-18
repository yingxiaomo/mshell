use std::sync::mpsc;

use protocol::ConnectionProtocol;
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
        // Telnet: no jump chain needed; pass empty.
        let chain = if conn.protocol == ConnectionProtocol::Telnet || conn.protocol == ConnectionProtocol::Local || conn.protocol == ConnectionProtocol::Serial {
            vec![conn.clone()]
        } else {
            ssh_core::resolve_jump_chain(&conn, |id| store.get(id))
                .map_err(|e| e.to_string())?
        };
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

    let is_telnet = conn.protocol == ConnectionProtocol::Telnet;
    let is_local = conn.protocol == ConnectionProtocol::Local;
    let is_serial = conn.protocol == ConnectionProtocol::Serial;

    // Telnet/Local/Serial: session_id is the virtual channel id; no SFTP/tunnels.
    let channel_id = if is_telnet || is_local || is_serial {
        session_id
    } else {
        match sessions.open_shell(session_id, cols, rows) {
            Ok(id) => id,
            Err(e) => {
                let _ = sessions.disconnect(session_id);
                return Err(map_core_err(e));
            }
        }
    };

    if !is_telnet && !is_local && !is_serial {
        if let Err(e) = sessions.open_sftp(session_id) {
            let _ = sessions.disconnect(session_id);
            return Err(map_core_err(e));
        }

        for t in conn.tunnels.iter().filter(|t| t.auto_start) {
            if let Err(e) = sessions.tunnel_start(session_id, t.clone()) {
                eprintln!("auto-start tunnel '{}' ({}) failed: {e}", t.name, t.id);
            }
        }
    }

    // Best-effort: stamp last_connected for "recent connections" UI.
    // Drop the sessions lock first — ConnectionStore uses a separate mutex.
    drop(sessions);
    if let Ok(mut store) = state.connections.lock() {
        if let Some(mut c) = store.get(connection_id) {
            c.last_connected = Some(chrono::Utc::now());
            let _ = store.upsert(c);
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
pub fn session_open_local(
    app: AppHandle,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<SessionOpenResult, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    // Build a virtual connection record with Local protocol so it flows through
    // the same SessionManager path as SSH/Telnet/Serial.
    let conn = protocol::Connection {
        id: uuid::Uuid::new_v4(),
        name: "本地终端".into(),
        host: String::new(),
        port: 0,
        protocol: protocol::ConnectionProtocol::Local,
        username: String::new(),
        auth: protocol::AuthMethod::Agent,
        group: None,
        tags: vec![],
        jump_host: None,
        tunnels: vec![],
        source: protocol::ConnectionSource::Manual,
        last_connected: None,
        notes: None,
        serial_config: None,
    };
    let name = conn.name.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let result = do_connect(app_clone, conn.id, &conn, vec![], cols, rows, name);
        let _ = tx.send(result);
    });
    rx.recv().map_err(|_| "connect thread died".to_string())?
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
