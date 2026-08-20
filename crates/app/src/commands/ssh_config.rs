//! SSH config file read/write + MCP host import.

use std::path::PathBuf;

use protocol::{AuthMethod, Connection, ConnectionProtocol, ConnectionSource};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| "找不到用户主目录".to_string())
}

/// Read ~/.ssh/config file content.
#[tauri::command]
pub fn read_ssh_config_text(path: Option<String>) -> Result<String, String> {
    let config_path = path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().unwrap_or_default().join(".ssh").join("config"));

    if !config_path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&config_path)
        .map_err(|e| format!("读取 SSH 配置失败：{e}"))
}

/// Write content to ~/.ssh/config.
#[tauri::command]
pub fn write_ssh_config_text(path: Option<String>, content: String) -> Result<(), String> {
    let config_path = path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().unwrap_or_default().join(".ssh").join("config"));

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&config_path, &content)
        .map_err(|e| format!("写入 SSH 配置失败：{e}"))
}

#[derive(Debug, Deserialize)]
struct McpHost {
    name: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    key: Option<String>,
}

/// One host that could not be imported, with the reason — surfaced to the UI so
/// users aren't silently missing MCP servers (e.g. credential-store write
/// failure).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedMcpHost {
    pub name: String,
    pub error: String,
}

/// Result of an MCP-host import: successfully converted connections plus the
/// hosts that had to be skipped and why.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImportResult {
    pub connections: Vec<Connection>,
    pub skipped: Vec<SkippedMcpHost>,
}

/// Import SSH servers from `~/.ssh/mcp-hosts.json` (ssh-mcp-server format).
/// Returns connections ready to be saved via save_connection. Hosts that fail
/// to convert (missing fields / credential-store failure) are reported in
/// `skipped` instead of being silently dropped.
#[tauri::command]
pub fn import_mcp_servers() -> Result<McpImportResult, String> {
    let mcp_path = home_dir()?.join(".ssh").join("mcp-hosts.json");
    if !mcp_path.exists() {
        return Ok(McpImportResult {
            connections: vec![],
            skipped: vec![],
        });
    }
    let content = std::fs::read_to_string(&mcp_path)
        .map_err(|e| format!("读取 MCP 配置失败：{e}"))?;
    let hosts: Vec<McpHost> = serde_json::from_str(&content)
        .map_err(|e| format!("解析 MCP 配置失败：{e}"))?;
    let mut connections: Vec<Connection> = Vec::new();
    let mut skipped: Vec<SkippedMcpHost> = Vec::new();
    for h in hosts {
        match mcp_host_to_connection(&h) {
            Ok(c) => connections.push(c),
            Err((name, error)) => skipped.push(SkippedMcpHost { name, error }),
        }
    }
    Ok(McpImportResult { connections, skipped })
}

fn mcp_host_to_connection(h: &McpHost) -> Result<Connection, (String, String)> {
    let Some(name) = h.name.as_deref() else {
        return Err(("unknown".into(), "缺少 name 字段".into()));
    };
    let Some(host) = h.host.as_deref() else {
        return Err((name.into(), "缺少 host 字段".into()));
    };
    let username = h.username.as_deref().unwrap_or("root");
    // One UUID shared by the connection id and the credential id: the password
    // is stored in the OS keyring under `mshell/{id}/password` (matching the
    // app-wide credential-id convention) so two hosts with the same name can
    // never share/collide on one credential entry.
    let id = Uuid::new_v4();

    let auth = if let Some(pw) = h.password.as_deref().filter(|p| !p.is_empty()) {
        let credential_id = format!("mshell/{id}/password");
        match ssh_core::creds::set_secret(&credential_id, pw) {
            Ok(()) => AuthMethod::Password { credential_id },
            Err(e) => {
                eprintln!("[mcp-import] 写入凭据失败（{name}）: {e}");
                return Err((name.to_string(), format!("写入凭据失败：{e}")));
            }
        }
    } else if h.key.as_deref().filter(|k| !k.is_empty()).is_some() {
        AuthMethod::PrivateKey {
            path: h.key.as_deref().unwrap_or("").into(),
            passphrase_credential_id: None,
        }
    } else {
        AuthMethod::Agent
    };

    Ok(Connection {
        id,
        name: name.into(),
        host: host.into(),
        port: h.port.unwrap_or(22),
        protocol: ConnectionProtocol::Ssh,
        username: username.into(),
        auth,
        group: Some("MCP".into()),
        tags: vec!["mcp".into()],
        jump_host: None,
        tunnels: vec![],
        source: ConnectionSource::Manual,
        last_connected: None,
        notes: None,
        serial_config: None,
        on_connect: None,
        color: None,
    })
}
