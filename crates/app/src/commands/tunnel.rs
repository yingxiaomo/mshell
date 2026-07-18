use protocol::{TunnelConfig, TunnelStatus};
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;

#[tauri::command]
pub fn tunnel_start(
    state: State<'_, AppState>,
    session_id: Uuid,
    config: TunnelConfig,
) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .tunnel_start(session_id, config)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tunnel_stop(
    state: State<'_, AppState>,
    session_id: Uuid,
    tunnel_id: Uuid,
) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .tunnel_stop(session_id, tunnel_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tunnel_list(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<Vec<TunnelStatus>, String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .tunnel_list(session_id)
        .map_err(|e| e.to_string())
}
