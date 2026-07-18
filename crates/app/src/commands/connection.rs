use protocol::{AuthMethod, Connection};
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Result<Vec<Connection>, String> {
    state
        .connections
        .lock()
        .map_err(|e| e.to_string())?
        .list()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_connection(
    state: State<'_, AppState>,
    mut conn: Connection,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<Connection, String> {
    if let Some(pw) = password {
        let id = ssh_core::creds::password_credential_id(conn.id);
        ssh_core::creds::set_secret(&id, &pw).map_err(|e| e.to_string())?;
        conn.auth = AuthMethod::Password {
            credential_id: id,
        };
    }

    if let Some(pp) = passphrase {
        let id = format!("momoshell/{}/passphrase", conn.id);
        ssh_core::creds::set_secret(&id, &pp).map_err(|e| e.to_string())?;
        match &mut conn.auth {
            AuthMethod::PrivateKey {
                passphrase_credential_id,
                ..
            }
            | AuthMethod::Certificate {
                passphrase_credential_id,
                ..
            } => {
                *passphrase_credential_id = Some(id);
            }
            AuthMethod::Password { .. } | AuthMethod::Agent => {
                // Passphrase only applies to key/cert auth; ignore for other variants.
            }
        }
    }

    state
        .connections
        .lock()
        .map_err(|e| e.to_string())?
        .upsert(conn.clone())
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, id: Uuid) -> Result<(), String> {
    let mut store = state.connections.lock().map_err(|e| e.to_string())?;

    // Best-effort: remove secrets referenced by this connection, plus standard ids.
    if let Some(conn) = store.get(id) {
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
    }
    let _ = ssh_core::creds::delete_secret(&ssh_core::creds::password_credential_id(id));
    let _ = ssh_core::creds::delete_secret(&format!("momoshell/{id}/passphrase"));

    store.delete(id).map_err(|e| e.to_string())?;
    Ok(())
}
