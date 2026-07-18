use std::path::PathBuf;

use base64::Engine;
use protocol::RemoteEntry;
use tauri::State;
use uuid::Uuid;

use crate::state::AppState;

#[tauri::command]
pub fn sftp_list(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
) -> Result<Vec<RemoteEntry>, String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .sftp_list(session_id, path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .sftp_mkdir(session_id, path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sftp_rm(state: State<'_, AppState>, session_id: Uuid, path: String) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .sftp_rm(session_id, path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sftp_rename(
    state: State<'_, AppState>,
    session_id: Uuid,
    from: String,
    to: String,
) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .sftp_rename(session_id, from, to)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sftp_realpath(
    state: State<'_, AppState>,
    session_id: Uuid,
    path: String,
) -> Result<String, String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .sftp_realpath(session_id, path)
        .map_err(|e| e.to_string())
}

/// Enqueue local → remote upload. Returns `transfer_id`; progress via `transfer-progress`.
#[tauri::command]
pub fn sftp_upload(
    state: State<'_, AppState>,
    session_id: Uuid,
    local_path: String,
    remote_path: String,
) -> Result<Uuid, String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .sftp_upload(session_id, PathBuf::from(local_path), remote_path)
        .map_err(|e| e.to_string())
}

/// Enqueue remote → local download. Returns `transfer_id`; progress via `transfer-progress`.
#[tauri::command]
pub fn sftp_download(
    state: State<'_, AppState>,
    session_id: Uuid,
    remote_path: String,
    local_path: String,
) -> Result<Uuid, String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .sftp_download(session_id, remote_path, PathBuf::from(local_path))
        .map_err(|e| e.to_string())
}

/// Cooperative cancel for an in-flight transfer.
#[tauri::command]
pub fn transfer_cancel(state: State<'_, AppState>, transfer_id: Uuid) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .transfer_cancel(transfer_id)
        .map_err(|e| e.to_string())
}

/// Read a remote file into memory (base64-encoded). For the built-in editor.
#[tauri::command]
pub fn sftp_read_text(
    state: State<'_, AppState>,
    session_id: Uuid,
    remote_path: String,
) -> Result<String, String> {
    let bytes = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .sftp_read(session_id, remote_path)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Write base64-decoded content to a remote file. For the built-in editor.
#[tauri::command]
pub fn sftp_write_text(
    state: State<'_, AppState>,
    session_id: Uuid,
    remote_path: String,
    content_b64: String,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(&content_b64)
        .map_err(|e| e.to_string())?;
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .sftp_write(session_id, remote_path, data)
        .map_err(|e| e.to_string())
}
