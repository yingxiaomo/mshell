use protocol::SessionOpenResult;
use tauri::State;
use uuid::Uuid;

use crate::state::{self, AppState};

#[tauri::command]
pub fn session_open(
    state: State<'_, AppState>,
    connection_id: Uuid,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<SessionOpenResult, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    state::open_session(&state, connection_id, cols, rows)
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

/// Disconnect (best-effort) and open a fresh session for the same connection.
#[tauri::command]
pub fn session_reconnect(
    state: State<'_, AppState>,
    session_id: Uuid,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<SessionOpenResult, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    state::reconnect_session(&state, session_id, cols, rows)
}
