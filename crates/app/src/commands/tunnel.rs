use protocol::{TunnelConfig, TunnelStatus};
use ssh_core::SessionCmd;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::state::{run_blocking, AppState};

use super::session::session_cmd;

#[tauri::command]
pub async fn tunnel_start(app: AppHandle, session_id: Uuid, config: TunnelConfig) -> Result<(), String> {
    run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::TunnelStart { config, reply })).await
}

#[tauri::command]
pub async fn tunnel_stop(app: AppHandle, session_id: Uuid, tunnel_id: Uuid) -> Result<(), String> {
    run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::TunnelStop { tunnel_id, reply })).await
}

#[tauri::command]
pub async fn tunnel_list(app: AppHandle, session_id: Uuid) -> Result<Vec<TunnelStatus>, String> {
    run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::TunnelList { reply })).await
}
