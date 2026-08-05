//! Host-key trust + key/host management commands.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

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

/// Import trusted host keys from an OpenSSH `known_hosts` file (default
/// `~/.ssh/known_hosts`) into the app's store. Returns the number of entries
/// merged. Hashed-hostname lines are skipped (host can't be recovered).
#[tauri::command]
pub fn import_known_hosts(path: Option<String>) -> Result<usize, String> {
    let src = match path {
        Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p.trim()),
        _ => ssh_core::default_openssh_known_hosts_path()
            .ok_or_else(|| map_err_str("找不到用户主目录下的 ~/.ssh/known_hosts"))?,
    };
    let content = std::fs::read_to_string(&src)
        .map_err(|e| map_err_str(format!("读取 {} 失败：{e}", src.display())))?;
    let store = ssh_core::default_known_hosts_path();
    ssh_core::import_openssh_known_hosts(&store, &content).map_err(map_core_err)
}

/// List all trusted host-key entries in the store.
#[tauri::command]
pub fn list_known_hosts() -> Result<Vec<ssh_core::KnownHostEntry>, String> {
    let path = ssh_core::default_known_hosts_path();
    Ok(ssh_core::load_known_hosts(&path).map_err(map_core_err)?.hosts)
}

/// Remove a trusted host entry by its `host:port` key. Returns `true` if removed.
#[tauri::command]
pub fn remove_known_host(host: String) -> Result<bool, String> {
    let key = host.trim();
    if key.is_empty() {
        return Err(map_err_str("host is required"));
    }
    let path = ssh_core::default_known_hosts_path();
    let mut file = ssh_core::load_known_hosts(&path).map_err(map_core_err)?;
    let before = file.hosts.len();
    file.hosts.retain(|e| e.host != key);
    let removed = file.hosts.len() != before;
    if removed {
        ssh_core::save_known_hosts(&path, &file).map_err(map_core_err)?;
    }
    Ok(removed)
}

/// Result of [`generate_keypair`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKey {
    pub private_path: String,
    pub public_path: String,
    pub public_key: String,
}

/// Generate a new ed25519 keypair with `ssh-keygen` (no passphrase). `path` is
/// the private-key path (default `~/.ssh/momoshell_ed25519`); refuses to
/// overwrite an existing file.
#[tauri::command]
pub fn generate_keypair(path: Option<String>, comment: Option<String>) -> Result<GeneratedKey, String> {
    let priv_path = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => home_dir()?.join(".ssh").join("momoshell_ed25519"),
    };
    if priv_path.exists() {
        return Err(map_err_str(format!("密钥已存在：{}", priv_path.display())));
    }
    if let Some(parent) = priv_path.parent() {
        std::fs::create_dir_all(parent).map_err(map_err_str)?;
    }
    let comment = comment.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "momoshell".into());
    let status = std::process::Command::new("ssh-keygen")
        .args(["-t", "ed25519", "-N", "", "-q", "-C", &comment, "-f"])
        .arg(&priv_path)
        .status()
        .map_err(|e| map_err_str(format!("无法执行 ssh-keygen：{e}（请确认系统已安装 OpenSSH 客户端）")))?;
    if !status.success() {
        return Err(map_err_str("ssh-keygen 生成密钥失败"));
    }
    let pub_path = PathBuf::from(format!("{}.pub", priv_path.display()));
    let public_key = std::fs::read_to_string(&pub_path).map_err(map_err_str)?.trim().to_string();
    Ok(GeneratedKey {
        private_path: priv_path.to_string_lossy().into_owned(),
        public_path: pub_path.to_string_lossy().into_owned(),
        public_key,
    })
}

/// Deploy (ssh-copy-id) a public key into a live session's remote
/// `~/.ssh/authorized_keys` (or `target`). Idempotent — an already-present key is
/// left untouched. Returns `true` if the key was newly added.
#[tauri::command]
pub async fn deploy_public_key(
    app: AppHandle,
    session_id: Uuid,
    public_key: Option<String>,
    pub_path: Option<String>,
    target: Option<String>,
) -> Result<bool, String> {
    // Key comes either inline or from a local .pub file the user picked.
    let key = match public_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => {
            let p = pub_path
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .ok_or_else(|| map_err_str("未提供公钥"))?;
            std::fs::read_to_string(&p)
                .map_err(|e| map_err_str(format!("读取公钥文件失败：{e}")))?
                .trim()
                .to_string()
        }
    };
    // Validate: single line, real pubkey, no shell-breaking characters.
    if key.is_empty()
        || key.contains(['\n', '\r', '\'', '`', '"', '\\'])
        || !(key.starts_with("ssh-") || key.starts_with("ecdsa-") || key.starts_with("sk-"))
    {
        return Err(map_err_str("无效的 SSH 公钥"));
    }
    let target = target
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "~/.ssh/authorized_keys".into());
    // Target is used UNQUOTED in the shell (so `~` expands); restrict its charset.
    if !target.chars().all(|c| c.is_ascii_alphanumeric() || "._/~-".contains(c)) {
        return Err(map_err_str("目标路径包含非法字符"));
    }

    // `dir=$(dirname T)` (unquoted so ~ expands); key is single-quoted (validated
    // to contain no single quote). grep -qxF makes it idempotent.
    let script = format!(
        "dir=$(dirname {t}); mkdir -p \"$dir\" && chmod 700 \"$dir\" 2>/dev/null; \
         touch {t} && chmod 600 {t} 2>/dev/null; \
         if grep -qxF '{k}' {t} 2>/dev/null; then echo MOMO_EXISTS; \
         else printf '%s\\n' '{k}' >> {t} && echo MOMO_ADDED; fi",
        t = target,
        k = key,
    );

    let out = run_session_exec(&app, session_id, script).await?;
    Ok(out.contains("MOMO_ADDED"))
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| map_err_str("找不到用户主目录"))
}

/// Run a command on a live session and return its stdout (off the IPC thread).
async fn run_session_exec(app: &AppHandle, session_id: Uuid, command: String) -> Result<String, String> {
    let app = app.clone();
    let (tx, rx) = flume::bounded(1);
    std::thread::spawn(move || {
        let result = (|| {
            let cmd_tx = {
                let state = app.state::<AppState>();
                let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
                sessions.sender(session_id).map_err(|e| e.to_string())?
            };
            let (reply_tx, reply_rx) = flume::bounded(1);
            cmd_tx
                .send(ssh_core::SessionCmd::Exec { command, reply: reply_tx })
                .map_err(|_| "session worker channel closed".to_string())?;
            reply_rx
                .recv()
                .map_err(|_| "reply channel closed".to_string())?
                .map_err(map_core_err)
        })();
        let _ = tx.send(result);
    });
    rx.recv_async().await.map_err(|_| "exec thread died".to_string())?
}
