use protocol::{AuthMethod, AppSettings};
use tauri::State;

use crate::state::AppState;
use crate::commands::middleware::OrErr;

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let store = state.settings.lock().or_err()?;
    Ok(store.load())
}

#[tauri::command]
pub fn save_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let mut store = state.settings.lock().or_err()?;
    store.save(settings.clone()).or_err()?;
    Ok(settings)
}

/// Delete all known keyring secrets referenced by saved connections.
///
/// Walks password `credential_id`s and key/cert passphrase ids, plus the
/// conventional `mshell/{id}/password` and `mshell/{id}/passphrase` ids.
#[tauri::command]
pub fn clear_all_credentials(state: State<'_, AppState>) -> Result<(), String> {
    let store = state.connections.lock().or_err()?;
    let conns = store.list().or_err()?;

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
        let _ = ssh_core::creds::delete_secret(&format!("mshell/{}/passphrase", conn.id));
    }

    Ok(())
}
