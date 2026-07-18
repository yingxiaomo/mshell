use protocol::{AuthMethod, AppSettings};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let store = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(store.load())
}

#[tauri::command]
pub fn save_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let mut store = state.settings.lock().map_err(|e| e.to_string())?;
    store.save(settings.clone()).map_err(|e| e.to_string())?;
    Ok(settings)
}

/// Delete all known keyring secrets referenced by saved connections.
///
/// Walks password `credential_id`s and key/cert passphrase ids, plus the
/// conventional `momoshell/{id}/password` and `momoshell/{id}/passphrase` ids.
#[tauri::command]
pub fn clear_all_credentials(state: State<'_, AppState>) -> Result<(), String> {
    let store = state.connections.lock().map_err(|e| e.to_string())?;
    let conns = store.list().map_err(|e| e.to_string())?;

    for conn in conns {
        match &conn.auth {
            AuthMethod::Password { credential_id } => {
                let _ = ssh_core::creds::delete_secret(credential_id);
            }
            AuthMethod::PrivateKey {
                passphrase_credential_id: Some(cid),
                ..
            }
            | AuthMethod::Certificate {
                passphrase_credential_id: Some(cid),
                ..
            } => {
                let _ = ssh_core::creds::delete_secret(cid);
            }
            _ => {}
        }
        let _ = ssh_core::creds::delete_secret(&ssh_core::creds::password_credential_id(conn.id));
        let _ = ssh_core::creds::delete_secret(&format!("momoshell/{}/passphrase", conn.id));
    }

    Ok(())
}
