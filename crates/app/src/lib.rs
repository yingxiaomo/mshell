mod commands;
mod error_map;
mod state;

use ssh_core::SessionManager;
use state::AppState;
use store::{connections_path, settings_path, ConnectionStore, SettingsStore};
use tauri::Manager;
#[cfg(desktop)]
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
};

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

            // ── System tray ──────────────────────────────────────
            #[cfg(desktop)]
            {
                let show_item =
                    MenuItemBuilder::with_id("show", "显示").build(app)?;
                let quit_item =
                    MenuItemBuilder::with_id("quit", "退出").build(app)?;
                let menu = MenuBuilder::new(app)
                    .item(&show_item)
                    .item(&quit_item)
                    .build()?;

                TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(win) =
                                app.get_webview_window("main")
                            {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Minimize to tray instead of closing.
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_connections,
            commands::connection::save_connection,
            commands::connection::delete_connection,
            commands::connection::import_ssh_config,
            commands::connection::duplicate_ssh_config_connection,
            commands::connection::export_connections,
            commands::connection::import_connections,
            commands::connection::import_putty_sessions,
            commands::serial::list_serial_ports,
            commands::host_key::host_key_trust,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::clear_all_credentials,
            commands::session::session_open,
            commands::session::session_open_local,
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
            commands::sftp::sftp_read_text,
            commands::sftp::sftp_write_text,
            commands::sftp::sftp_chmod,
            commands::tunnel::tunnel_start,
            commands::tunnel::tunnel_stop,
            commands::tunnel::tunnel_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running momoshell");
}
