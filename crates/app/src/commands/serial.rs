use tauri::State;

use crate::state::AppState;

/// List available serial (COM) ports on this machine.
#[tauri::command]
pub fn list_serial_ports(_state: State<'_, AppState>) -> Result<Vec<String>, String> {
    ssh_core::serial::list_ports().map_err(|e| e.to_string())
}
