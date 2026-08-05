use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ssh_core::SessionCmd;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::state::AppState;

/// Clone the worker's command sender under a brief lock, then release it. Writes
/// go over an unbounded channel (send never blocks), so no per-call thread is
/// spawned — the previous design spawned one OS thread per keystroke/resize,
/// which a fast typist or a `terminal_write` flood turned into unbounded threads.
fn session_sender(
    app: &AppHandle,
    session_id: Uuid,
) -> Result<flume::Sender<SessionCmd>, String> {
    let state = app.state::<AppState>();
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.sender(session_id).map_err(|e| e.to_string())
}

/// Write terminal input. `data` is base64-encoded bytes from the frontend.
#[tauri::command]
pub fn terminal_write(
    app: AppHandle,
    session_id: Uuid,
    channel_id: Uuid,
    data: String,
) -> Result<(), String> {
    let bytes = B64
        .decode(data.as_bytes())
        .map_err(|e| format!("invalid base64 data: {e}"))?;
    let cmd_tx = session_sender(&app, session_id)?;
    cmd_tx
        .send(SessionCmd::Write { channel_id, data: bytes })
        .map_err(|_| "session worker channel closed".to_string())
}

#[tauri::command]
pub fn terminal_resize(
    app: AppHandle,
    session_id: Uuid,
    channel_id: Uuid,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("cols and rows must be > 0".into());
    }
    let cmd_tx = session_sender(&app, session_id)?;
    cmd_tx
        .send(SessionCmd::Resize { channel_id, cols, rows })
        .map_err(|_| "session worker channel closed".to_string())
}
