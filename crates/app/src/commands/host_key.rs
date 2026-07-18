//! Host-key trust command (known_hosts.json upsert).

use tauri::State;

use crate::state::{map_core_err, map_err_str, AppState};

/// Persist a trusted host key fingerprint under `host` (`host:port` key).
///
/// After success the user should retry `session_open` for the same connection.
#[tauri::command]
pub fn host_key_trust(
    _state: State<'_, AppState>,
    host: String,
    fingerprint: String,
    key_type: Option<String>,
) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err(map_err_str("host is required (host:port)"));
    }
    if fingerprint.trim().is_empty() {
        return Err(map_err_str("fingerprint is required"));
    }
    if !fingerprint.starts_with("SHA256:") {
        return Err(map_err_str(
            "fingerprint must be OpenSSH-style SHA256:<base64>",
        ));
    }

    let path = ssh_core::default_known_hosts_path();
    let mut file = ssh_core::load_known_hosts(&path).map_err(map_core_err)?;
    ssh_core::upsert_entry(
        &mut file,
        ssh_core::KnownHostEntry {
            host: host.trim().to_string(),
            fingerprint: fingerprint.trim().to_string(),
            key_type: key_type
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "user-trusted".into()),
        },
    );
    ssh_core::save_known_hosts(&path, &file).map_err(map_core_err)?;
    Ok(())
}
