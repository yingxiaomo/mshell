mod commands;
mod state;

use state::AppState;
use store::{connections_path, settings_path, ConnectionStore, SettingsStore};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let connections = ConnectionStore::open(&connections_path())
                .map_err(|e| format!("open connections store: {e}"))?;
            let settings = SettingsStore::open(&settings_path())
                .map_err(|e| format!("open settings store: {e}"))?;
            app.manage(AppState::new(connections, settings));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_connections,
            commands::connection::save_connection,
            commands::connection::delete_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running momoshell");
}
