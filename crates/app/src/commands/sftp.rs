use std::path::PathBuf;

use base64::Engine;
use protocol::RemoteEntry;
use ssh_core::SessionCmd;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::state::{run_blocking, AppState};
use crate::commands::middleware::OrErr;

use super::session::session_cmd;

#[tauri::command]
pub async fn sftp_list(app: AppHandle, session_id: Uuid, path: String) -> Result<Vec<RemoteEntry>, String> {
    run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::SftpList { path, reply })).await
}

#[tauri::command]
pub async fn sftp_mkdir(app: AppHandle, session_id: Uuid, path: String) -> Result<(), String> {
    run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::SftpMkdir { path, reply })).await
}

#[tauri::command]
pub async fn sftp_rm(app: AppHandle, session_id: Uuid, path: String) -> Result<(), String> {
    run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::SftpRm { path, reply })).await
}

#[tauri::command]
pub async fn sftp_rename(app: AppHandle, session_id: Uuid, from: String, to: String) -> Result<(), String> {
    run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::SftpRename { from, to, reply })).await
}

#[tauri::command]
pub async fn sftp_realpath(app: AppHandle, session_id: Uuid, path: String) -> Result<String, String> {
    run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::SftpRealpath { path, reply })).await
}

#[tauri::command]
pub async fn sftp_upload(app: AppHandle, session_id: Uuid, local_path: String, remote_path: String) -> Result<Uuid, String> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let sessions = state.sessions.lock().or_err()?;
        sessions.sftp_upload(session_id, PathBuf::from(local_path), remote_path).or_err()
    }).await
}

#[tauri::command]
pub async fn sftp_download(app: AppHandle, session_id: Uuid, remote_path: String, local_path: String) -> Result<Uuid, String> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let sessions = state.sessions.lock().or_err()?;
        sessions.sftp_download(session_id, remote_path, PathBuf::from(local_path)).or_err()
    }).await
}

#[tauri::command]
pub async fn transfer_cancel(app: AppHandle, transfer_id: Uuid) -> Result<(), String> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let sessions = state.sessions.lock().or_err()?;
        sessions.transfer_cancel(transfer_id).or_err()
    }).await
}

#[tauri::command]
pub async fn sftp_read_text(app: AppHandle, session_id: Uuid, remote_path: String) -> Result<String, String> {
    let bytes: Vec<u8> = run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::SftpRead { remote_path, reply })).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub async fn sftp_write_text(app: AppHandle, session_id: Uuid, remote_path: String, content_b64: String) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD.decode(&content_b64).map_err(|e| e.to_string())?;
    run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::SftpWrite { remote_path, data, reply })).await
}

#[tauri::command]
pub async fn sftp_chmod(app: AppHandle, session_id: Uuid, path: String, mode: u32) -> Result<(), String> {
    run_blocking(move || session_cmd(&app.state::<AppState>(), session_id, |reply| SessionCmd::SftpChmod { path, mode, reply })).await
}
