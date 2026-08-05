//! SSH key management — list, read, and check agent status.

use std::path::PathBuf;

use serde::Serialize;

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| "找不到用户主目录".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub name: String,
    pub path: String,
    pub key_type: String,
    pub has_pubkey: bool,
    pub fingerprint: Option<String>,
}

/// Scan ~/.ssh/ for key files matching `id_*` (not .pub).
/// Runs on a background thread to avoid blocking the UI.
#[tauri::command]
pub async fn list_ssh_keys() -> Result<Vec<SshKeyInfo>, String> {
    let (tx, rx) = flume::bounded(1);
    std::thread::spawn(move || {
        let result = list_ssh_keys_sync();
        let _ = tx.send(result);
    });
    rx.recv_async().await.map_err(|_| "background thread died".to_string())?
}

fn list_ssh_keys_sync() -> Result<Vec<SshKeyInfo>, String> {
    let ssh_dir = home_dir()?.join(".ssh");
    if !ssh_dir.exists() {
        return Ok(vec![]);
    }
    let mut keys = Vec::new();
    let entries = std::fs::read_dir(&ssh_dir).map_err(|e| e.to_string())?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if (!name.starts_with("id_") || name.ends_with(".pub"))
            && name != "known_hosts" && name != "config" && name != "authorized_keys"
        { continue; }
        if !path.is_file() { continue; }
        candidates.push(path);
    }
    for path in candidates {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let has_pubkey = path.with_extension("pub").is_file();
        let key_type = name.strip_prefix("id_").unwrap_or(&name).trim_end_matches(".pub").to_string();
        let fingerprint = get_fingerprint(&path);
        keys.push(SshKeyInfo {
            name,
            path: path.to_string_lossy().to_string(),
            key_type: match key_type.as_str() {
                "ed25519" => "ED25519".into(),
                "rsa" => "RSA".into(),
                "ecdsa" => "ECDSA".into(),
                "ecdsa_sk" => "ECDSA-SK".into(),
                "ed25519_sk" => "ED25519-SK".into(),
                "dsa" | "dss" => "DSA".into(),
                _ => key_type.to_uppercase(),
            },
            has_pubkey,
            fingerprint,
        });
    }
    keys.sort_by(|a, b| b.has_pubkey.cmp(&a.has_pubkey).then_with(|| a.name.cmp(&b.name)));
    Ok(keys)
}

/// Read a public key file and return its content.
#[tauri::command]
pub fn read_ssh_pubkey(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    let content = std::fs::read_to_string(&p).map_err(|e| format!("读取失败：{e}"))?;
    Ok(content.trim().to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub running: bool,
    pub keys_loaded: Option<u32>,
}

/// Check if SSH agent is running.
/// Does NOT call `ssh-add -l` (which can hang on Windows when agent isn't running).
#[tauri::command]
pub async fn ssh_agent_status() -> Result<AgentStatus, String> {
    let (tx, rx) = flume::bounded(1);
    std::thread::spawn(move || {
        let running = std::env::var("SSH_AUTH_SOCK").is_ok()
            || std::env::var("SSH_AGENT_PID").is_ok()
            || {
                #[cfg(target_os = "windows")]
                { std::fs::OpenOptions::new().read(true).write(false).open(r"\\.\pipe\openssh-ssh-agent").is_ok() }
                #[cfg(not(target_os = "windows"))]
                { false }
            };
        let _ = tx.send(AgentStatus { running, keys_loaded: None });
    });
    rx.recv_async().await.map_err(|_| "background thread died".to_string())
}

fn get_fingerprint(path: &std::path::Path) -> Option<String> {
    // Timeout after 3 seconds to avoid hanging on problematic key files.
    let (tx, rx) = flume::bounded(1);
    let path = path.to_owned();
    std::thread::spawn(move || {
        let out = std::process::Command::new("ssh-keygen")
            .args(["-lf", &path.to_string_lossy()])
            .output();
        let _ = tx.send(out);
    });
    let out: std::process::Output = rx.recv_timeout(std::time::Duration::from_secs(3)).ok()?.ok()?;
    if !out.status.success() { return None; }
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() >= 2 {
        let fp = parts[1].to_string();
        if fp.starts_with("SHA256:") || fp.starts_with("MD5:") {
            return Some(fp);
        }
    }
    Some(line)
}
