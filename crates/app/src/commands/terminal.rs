use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;

/// Write terminal input. `data` is base64-encoded bytes from the frontend.
#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    session_id: Uuid,
    channel_id: Uuid,
    data: String,
) -> Result<(), String> {
    let bytes = B64
        .decode(data.as_bytes())
        .map_err(|e| format!("invalid base64 data: {e}"))?;
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .write(session_id, channel_id, bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    session_id: Uuid,
    channel_id: Uuid,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("cols and rows must be > 0".into());
    }
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .resize(session_id, channel_id, cols, rows)
        .map_err(|e| e.to_string())
}
