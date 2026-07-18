mod commands;
mod state;

use ssh_core::SessionManager;
use state::AppState;
use store::{connections_path, settings_path, ConnectionStore, SettingsStore};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let connections = ConnectionStore::open(&connections_path())
                .map_err(|e| format!("open connections store: {e}"))?;
            let settings = SettingsStore::open(&settings_path())
                .map_err(|e| format!("open settings store: {e}"))?;

            let (sessions, event_rx) = SessionManager::create();
            app.manage(AppState::build(connections, settings, sessions));
            state::install_event_bridge(app.handle().clone(), event_rx);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_connections,
            commands::connection::save_connection,
            commands::connection::delete_connection,
            commands::connection::import_ssh_config,
            commands::connection::duplicate_ssh_config_connection,
            commands::connection::export_connections,
            commands::connection::import_connections,
            commands::host_key::host_key_trust,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::clear_all_credentials,
            commands::session::session_open,
            commands::session::session_close,
            commands::session::session_reconnect,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::sftp::sftp_list,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rm,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_realpath,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_download,
            commands::sftp::transfer_cancel,
            commands::tunnel::tunnel_start,
            commands::tunnel::tunnel_stop,
            commands::tunnel::tunnel_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running momoshell");
}
