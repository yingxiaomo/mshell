use protocol::{AuthMethod, Connection, ConnectionSource};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;
use winreg::enums::*;
use winreg::RegKey;

use crate::state::{map_err_str, AppState};

/// On-disk export envelope written by [`export_connections`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsExportFile {
    pub version: u32,
    pub exported_at: String,
    pub include_secrets: bool,
    pub connections: Vec<Connection>,
    /// Present only when `include_secrets` was requested; empty in practice because
    /// Windows Credential Manager secrets are not bulk-exportable by design.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets_note: Option<String>,
}

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Result<Vec<Connection>, String> {
    state
        .connections
        .lock()
        .map_err(|e| e.to_string())?
        .list()
        .map_err(|e| e.to_string())
}

/// Parse `~/.ssh/config` (or settings.sshConfigPath) into Connection rows for UI merge.
/// Does **not** write into connections.json.
#[tauri::command]
pub fn import_ssh_config(state: State<'_, AppState>) -> Result<Vec<Connection>, String> {
    let configured = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.load().ssh_config_path
    };
    ssh_core::import_ssh_config(configured.as_deref()).map_err(|e| e.to_string())
}

/// Persist an imported ssh-config host as a local Manual connection (new id).
#[tauri::command]
pub fn duplicate_ssh_config_connection(
    state: State<'_, AppState>,
    mut conn: Connection,
) -> Result<Connection, String> {
    // Always assign a fresh id and mark as Manual so it becomes editable local data.
    conn.id = Uuid::new_v4();
    conn.source = ConnectionSource::Manual;
    conn.group = conn.group.filter(|g| g != "ssh config");
    conn.tags.retain(|t| t != "ssh-config");
    if !conn.tags.iter().any(|t| t == "from-ssh-config") {
        conn.tags.push("from-ssh-config".into());
    }

    state
        .connections
        .lock()
        .map_err(|e| e.to_string())?
        .upsert(conn.clone())
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Import PuTTY sessions from Windows Registry.
/// Reads `HKCU\Software\SimonTatham\PuTTY\Sessions` and returns Connections.
#[tauri::command]
pub fn import_putty_sessions() -> Result<Vec<Connection>, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let sessions_key = match hkcu.open_subkey_with_flags(
        r"Software\SimonTatham\PuTTY\Sessions",
        KEY_READ,
    ) {
        Ok(k) => k,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    for name in sessions_key.enum_keys() {
        let name = name.map_err(|e| e.to_string())?;
        let key = sessions_key
            .open_subkey_with_flags(&name, KEY_READ)
            .map_err(|e| e.to_string())?;

        let host: String = key.get_value("HostName").unwrap_or_default();
        if host.is_empty() {
            continue;
        }
        let port: u32 = key.get_value("PortNumber").unwrap_or(22);
        let username: String = key.get_value("UserName").unwrap_or_default();
        let key_path: String = key.get_value("PublicKeyFile").unwrap_or_default();

        let auth = if key_path.is_empty() {
            AuthMethod::Password {
                credential_id: String::new(),
            }
        } else {
            AuthMethod::PrivateKey {
                path: key_path,
                passphrase_credential_id: None,
            }
        };

        let display_name = name.replace("%20", " ").replace("%26", "&");

        out.push(Connection {
            id: Uuid::new_v4(),
            name: display_name,
            host,
            port: port as u16,
            username,
            auth,
            group: Some("PuTTY".into()),
            tags: vec!["putty".into()],
            jump_host: None,
            tunnels: vec![],
            protocol: Default::default(),
            source: ConnectionSource::Manual,
            last_connected: None,
            notes: Some("从 PuTTY 导入".into()),
            serial_config: None,
        });
    }
    Ok(out)
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

/// Export local connections as JSON.
///
/// Default `include_secrets = false` (recommended). When `true`, caller must pass
/// `confirm = "EXPORT_SECRETS"`; even then only connection metadata + credential
/// *ids* are written — keyring secret values are never embedded.
#[tauri::command]
pub fn export_connections(
    state: State<'_, AppState>,
    include_secrets: bool,
    confirm: Option<String>,
) -> Result<String, String> {
    if include_secrets && confirm.as_deref() != Some("EXPORT_SECRETS") {
        return Err(map_err_str(
            "exporting with include_secrets requires confirm = \"EXPORT_SECRETS\"",
        ));
    }

    let connections = state
        .connections
        .lock()
        .map_err(|e| e.to_string())?
        .list()
        .map_err(|e| e.to_string())?;

    let file = ConnectionsExportFile {
        version: 1,
        exported_at: chrono::Utc::now().to_rfc3339(),
        include_secrets,
        connections,
        secrets_note: if include_secrets {
            Some(
                "Passwords/passphrases live in Windows Credential Manager and are not \
                 included. Only credentialId references are exported; re-enter secrets after import."
                    .into(),
            )
        } else {
            Some(
                "Secrets omitted. credentialId fields reference the local keyring and may not \
                 resolve on another machine."
                    .into(),
            )
        },
    };

    serde_json::to_string_pretty(&file).map_err(|e| e.to_string())
}

/// Import connections from a JSON export (or a bare array of Connection).
///
/// Existing ids are replaced (upsert). Secrets are never imported from the file —
/// users must re-enter passwords after import when credential ids do not resolve.
#[tauri::command]
pub fn import_connections(
    state: State<'_, AppState>,
    json: String,
) -> Result<usize, String> {
    let connections = parse_import_json(&json)?;
    let mut store = state.connections.lock().map_err(|e| e.to_string())?;
    let count = connections.len();
    for conn in connections {
        store.upsert(conn).map_err(|e| e.to_string())?;
    }
    Ok(count)
}

fn parse_import_json(json: &str) -> Result<Vec<Connection>, String> {
    // Prefer envelope format.
    if let Ok(file) = serde_json::from_str::<ConnectionsExportFile>(json) {
        return Ok(file.connections);
    }
    // Fallback: bare array.
    serde_json::from_str::<Vec<Connection>>(json).map_err(|e| {
        format!("invalid connections export JSON: {e}")
    })
}
