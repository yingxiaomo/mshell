use protocol::ConnectionProtocol;
use protocol::SessionOpenResult;
use ssh_core::{CoreError, KnownHostsPolicy, SessionCmd};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::state::{AppState, map_core_err};

/// Send a `SessionCmd` via the command sender without holding `AppState::sessions`
/// for more than the instant needed to clone the sender.  Callers can then block
/// on the reply channel without freezing other session operations.
pub(super) fn session_cmd<R>(
    state: &AppState,
    session_id: Uuid,
    build: impl FnOnce(flume::Sender<Result<R, ssh_core::CoreError>>) -> SessionCmd,
) -> Result<R, String>
where
    R: Send + 'static,
{
    let cmd_tx = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .sender(session_id)
        .map_err(|e| e.to_string())?;
    // Lock released — sender is cloned, we can wait without contention.
    let (reply_tx, reply_rx) = flume::bounded(1);
    cmd_tx
        .send(build(reply_tx))
        .map_err(|_| String::from("session worker channel closed"))?;
    reply_rx
        .recv()
        .map_err(|_| String::from("reply channel closed"))?
        .map_err(|e| e.to_string())
}

/// Connect on a background OS thread so neither the Tauri IPC thread nor the
/// main WebView thread is blocked during TCP+SSH handshake.
#[tauri::command]
pub async fn session_open(
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

    // Use a flume channel so the bg thread can send the result and we await it
    // without blocking the async runtime thread (flume::Receiver::recv_async
    // yields to the runtime instead of blocking the OS thread).
    let (tx, rx) = flume::bounded(1);
    let app2 = app.clone();
    let conn2 = conn.clone();
    std::thread::spawn(move || {
        let result = do_connect(app2, connection_id, &conn2, jump_chain, cols, rows, name);
        let _ = tx.send(result);
    });

    rx.recv_async()
        .await
        .map_err(|_| "connect thread died".to_string())?
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
    let is_ssh = conn.protocol == ConnectionProtocol::Ssh;

    // ── Phase 1: spawn session & wait for SSH handshake (lock-free) ──
    let session_id = if is_ssh {
        let (sid, ready_rx, ssh_thread) = {
            let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
            // Strict: an unknown host surfaces HostKeyUnknown so the UI prompts the
            // user to verify the fingerprint (via host_key_trust) before trusting —
            // no silent first-use trust. Changed keys surface HostKeyChanged.
            sessions.spawn_ssh(conn, KnownHostsPolicy::Strict, Some(jump_chain))
                .map_err(map_core_err)?
        };
        // Lock released — wait for handshake without blocking other ops.
        match ready_rx.recv() {
            Ok(Ok(())) => {
                // Store the thread handle so disconnect can join it.
                let _ = state.sessions.lock()
                    .map(|mut s| s.attach_thread(sid, ssh_thread));
                sid
            }
            Ok(Err(e)) => {
                let _ = state.sessions.lock().map(|mut s| s.disconnect(sid));
                return Err(map_core_err(e));
            }
            Err(_) => {
                let _ = state.sessions.lock().map(|mut s| s.disconnect(sid));
                return Err(map_core_err(CoreError::Other("ready channel closed".into())));
            }
        }
    } else {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .connect_with_chain(conn, KnownHostsPolicy::StoreAndCompare, Some(jump_chain))
            .map_err(map_core_err)?
    };

    let is_telnet = conn.protocol == ConnectionProtocol::Telnet;
    let is_local = conn.protocol == ConnectionProtocol::Local;
    let is_serial = conn.protocol == ConnectionProtocol::Serial;

    // ── Phase 2: open shell (brief lock) ──
    let channel_id = if is_telnet || is_local || is_serial {
        session_id
    } else {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        match sessions.open_shell(session_id, cols, rows) {
            Ok(id) => id,
            Err(e) => {
                let _ = sessions.disconnect(session_id);
                return Err(map_core_err(e));
            }
        }
    };

    // Auto-run per-connection login command in the interactive shell.
    if let Some(script) = conn.on_connect.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let line = format!("{script}\n").into_bytes();
        if let Ok(sessions) = state.sessions.lock() {
            let _ = sessions.write(session_id, channel_id, line);
        }
    }

    if !is_telnet && !is_local && !is_serial {
        // SFTP is opened lazily on first file-browser access.
        // Skipping it here avoids blocking the session worker thread
        // during init (the remote SFTP subsystem can be slow to
        // negotiate on some servers, which stalls both the Tauri
        // command handler and the worker's I/O poll loop).

        for t in conn.tunnels.iter().filter(|t| t.auto_start) {
            let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
            if let Err(e) = sessions.tunnel_start(session_id, t.clone()) {
                eprintln!("auto-start tunnel '{}' ({}) failed: {e}", t.name, t.id);
            }
        }
    }

    // Best-effort: stamp last_connected for "recent connections" UI. Updates the
    // record in place (no get→clone→upsert read-modify-write race).
    if let Ok(mut store) = state.connections.lock() {
        let _ = store.touch_last_connected(connection_id, chrono::Utc::now());
    }

    Ok(SessionOpenResult {
        session_id,
        connection_id,
        terminal_channel_id: channel_id,
        name,
    })
}

#[tauri::command]
pub async fn session_open_local(
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
        on_connect: None,
    color: None,
    };
    let name = conn.name.clone();
    let (tx, rx) = flume::bounded(1);
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let result = do_connect(app_clone, conn.id, &conn, vec![], cols, rows, name);
        let _ = tx.send(result);
    });
    rx.recv_async().await.map_err(|_| "connect thread died".to_string())?
}

/// Open an ad-hoc (quick-connect) SSH session that is NOT saved to the store.
/// `auth_type` is "password" | "agent" | "key". For password auth the secret is
/// stored transiently in the keyring and removed when the session closes.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn session_open_adhoc(
    app: AppHandle,
    host: String,
    port: Option<u16>,
    username: String,
    auth_type: String,
    password: Option<String>,
    key_path: Option<String>,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<SessionOpenResult, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("主机不能为空".into());
    }
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err("用户名不能为空".into());
    }
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    let id = Uuid::new_v4();

    let adhoc_cid = format!("momoshell/adhoc-{id}/password");
    let auth = match auth_type.as_str() {
        "agent" => protocol::AuthMethod::Agent,
        "key" => protocol::AuthMethod::PrivateKey {
            path: key_path.unwrap_or_default(),
            passphrase_credential_id: None,
        },
        _ => {
            ssh_core::creds::set_secret(&adhoc_cid, password.as_deref().unwrap_or(""))
                .map_err(map_core_err)?;
            protocol::AuthMethod::Password { credential_id: adhoc_cid.clone() }
        }
    };
    let is_password = matches!(auth, protocol::AuthMethod::Password { .. });

    let name = format!("{username}@{host}");
    let conn = protocol::Connection {
        id,
        name: name.clone(),
        host,
        port: port.unwrap_or(22),
        protocol: ConnectionProtocol::Ssh,
        username,
        auth,
        group: None,
        tags: vec!["quick".into()],
        jump_host: None,
        tunnels: vec![],
        source: protocol::ConnectionSource::Manual,
        last_connected: None,
        notes: None,
        serial_config: None,
        on_connect: None,
    color: None,
    };

    let (tx, rx) = flume::bounded(1);
    let app2 = app.clone();
    let conn2 = conn.clone();
    std::thread::spawn(move || {
        let result = do_connect(app2, id, &conn2, vec![conn2.clone()], cols, rows, name);
        let _ = tx.send(result);
    });
    let result = rx.recv_async().await.map_err(|_| "connect thread died".to_string())?;

    // Track the transient secret for cleanup on session close; drop it now if
    // the connect failed (no session will ever close).
    if is_password {
        match result.as_ref() {
            Ok(open) => {
                let sid = open.session_id;
                if let Ok(mut m) = app.state::<AppState>().adhoc_creds.lock() {
                    m.insert(sid, adhoc_cid);
                }
            }
            Err(_) => {
                let _ = ssh_core::creds::delete_secret(&adhoc_cid);
            }
        }
    }
    result
}

#[tauri::command]
pub async fn session_exec(
    app: AppHandle,
    session_id: Uuid,
    command: String,
) -> Result<String, String> {
    let (tx, rx) = flume::bounded(1);
    let cmd_display = command.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let cmd_tx = match state.sessions.lock() {
            Ok(sessions) => match sessions.sender(session_id) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[exec] sender() failed: {e}");
                    let _ = tx.send(Err(e.to_string()));
                    return;
                }
            },
            Err(e) => {
                eprintln!("[exec] lock failed: {e}");
                let _ = tx.send(Err(e.to_string()));
                return;
            }
        };
        /* state released */
        let (reply_tx, reply_rx) = flume::bounded(1);
        if cmd_tx.send(SessionCmd::Exec { command, reply: reply_tx }).is_err() {
            eprintln!("[exec] send failed (worker gone)");
            let _ = tx.send(Err("session worker channel closed".into()));
            return;
        }
        let result = match reply_rx.recv() {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(e)) => {
                eprintln!("[exec] worker error for {cmd_display:?}: {e}");
                Err(e.to_string())
            }
            Err(_) => {
                eprintln!("[exec] reply channel closed");
                Err("session worker reply channel closed".into())
            }
        };
        let _ = tx.send(result);
    });
    rx.recv_async()
        .await
        .map_err(|_| "exec thread died".to_string())?
}

#[tauri::command]
pub async fn session_close(app: AppHandle, session_id: Uuid) -> Result<(), String> {
    let (tx, rx) = flume::bounded(1);
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        // Close any active log recording for this session.
        if let Ok(mut logs) = state.session_logs.lock() {
            logs.remove(&session_id);
        }
        // Remove the transient quick-connect credential, if any.
        let adhoc_cid = state
            .adhoc_creds
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&session_id));
        if let Some(cid) = adhoc_cid {
            let _ = ssh_core::creds::delete_secret(&cid);
        }
        let result = match state.sessions.lock() {
            Ok(mut sessions) => sessions.disconnect(session_id).map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        let _ = tx.send(result);
    });
    rx.recv_async()
        .await
        .map_err(|_| "close thread died".to_string())?
}

/// Begin recording a session's terminal output. With no `path`, a file is
/// auto-created under `<Documents>/momoshell-logs/`. Returns the log file path.
#[tauri::command]
pub fn session_log_start(
    app: AppHandle,
    session_id: Uuid,
    path: Option<String>,
) -> Result<String, String> {
    let log_path = match path {
        Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p.trim()),
        _ => default_log_path(&app, session_id)?,
    };
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建日志目录失败：{e}"))?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("无法打开日志文件：{e}"))?;
    let state = app.state::<AppState>();
    state
        .session_logs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, file);
    Ok(log_path.to_string_lossy().into_owned())
}

/// Default log path: `<Documents>/momoshell-logs/session-<short>-<timestamp>.log`.
fn default_log_path(app: &AppHandle, session_id: Uuid) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("找不到默认目录：{e}"))?;
    let short = &session_id.simple().to_string()[..8];
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    Ok(base.join("momoshell-logs").join(format!("session-{short}-{ts}.log")))
}

/// Stop recording a session's terminal output (closes the file).
#[tauri::command]
pub fn session_log_stop(app: AppHandle, session_id: Uuid) -> Result<(), String> {
    let state = app.state::<AppState>();
    state
        .session_logs
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn session_reconnect(
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

    session_open(app, connection_id, Some(cols), Some(rows)).await
}
